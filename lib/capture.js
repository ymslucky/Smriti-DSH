/**
 * 自动捕获：`agent/turn-stopping` 时判断本回合是否出现“偏好句式”，
 * 命中才调用 `POST /v1/extract` 让网关生成候选。
 *
 * 关键约束：`agent/turn-stopping` 是 serial 事件（返回的 Promise 会被 await），
 * 所以这里只做同步判断后 fire-and-forget，把网络等待留在回合之外，
 * 且内部硬超时 {@link CAPTURE_TIMEOUT_MS}（3s）。
 */
import { createHash } from 'node:crypto';
import { CAPTURE_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS } from './gateway.js';
import { truncateText } from './telemetry.js';
/** 偏好句式启发式：中文六类 + 英文四类。 */
export const PREFERENCE_PATTERNS = [
    /习惯/,
    /以后/,
    /统一/,
    /不要再/,
    /不要用|别用|改用|换成/,
    /记住|记一下|记下/,
    /我们(?:都|一般|通常)/,
    /我(?:一般|通常|习惯|默认)/,
    /规范|约定|风格/,
    /\bprefer(?:s|red|ence|ences)?\b/i,
    /\balways\b/i,
    /\bnever\b/i,
    /\bby default\b/i,
];
/** 过短的文本不可能是偏好陈述，直接跳过。 */
const MIN_TEXT_LENGTH = 6;
/** 单次捕获提交给网关的文本上限。 */
const MAX_CAPTURE_CHARS = 4000;
/** 去重集合上限。 */
const MAX_SEEN_DIGESTS = 256;
/** 按本地日期生成计数键。 */
function localDay(now) {
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
/**
 * 判断文本是否含偏好句式。
 * @param text - 本回合最后一条 user 文本。
 * @returns 命中任一模式时为 `true`。
 */
export function looksLikePreference(text) {
    if (text.length < MIN_TEXT_LENGTH)
        return false;
    return PREFERENCE_PATTERNS.some((pattern) => pattern.test(text));
}
/**
 * 占用一次每日自动捕获额度。
 * @param counter - 进程内计数器。
 * @param limit - 每日上限；`<= 0` 关闭自动捕获。
 * @param now - 当前时间（按本地日期重置）。
 * @returns 是否允许本次捕获。
 */
export function takeDailySlot(counter, limit, now) {
    if (!Number.isFinite(limit) || limit <= 0)
        return false;
    const day = localDay(now);
    if (counter.day !== day) {
        counter.day = day;
        counter.count = 0;
    }
    if (counter.count >= limit)
        return false;
    counter.count += 1;
    return true;
}
function digestOf(text) {
    return createHash('sha1').update(text).digest('hex').slice(0, 16);
}
export function summarizeExtract(response, minConfidence) {
    const candidates = response.candidates ?? [];
    const results = response.results ?? [];
    const confident = candidates.filter((candidate) => (candidate.confidence ?? 0) >= minConfidence);
    const statuses = new Map();
    for (const result of results) {
        const status = result.status ?? 'unknown';
        statuses.set(status, (statuses.get(status) ?? 0) + 1);
    }
    const statusText = statuses.size === 0
        ? '无写入'
        : [...statuses].map(([status, count]) => `${status}×${count}`).join(', ');
    const topicText = confident.length === 0
        ? '无高置信候选'
        : confident.map((candidate) => `${candidate.topic}(<${(candidate.confidence ?? 0).toFixed(2)})`).join(', ');
    return `候选 ${candidates.length} 条（高置信 ${confident.length}）：${topicText}；${statusText}`;
}
/** 截断长陈述，避免把整个记忆塞进问题卡片。 */
function shortStatement(value, max = 120) {
    const text = value.replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
}
/**
 * 自动捕获产生冲突时，用 DSH 的用户提问卡片让用户当场决策：
 * - 槽位冲突：替换 / 保留；
 * - 疑似重复：写入 / 放弃。
 * 答案通过 `/v1/pending/{id}/resolve` 立即生效；用户不回答则保持 pending。
 * 子会话（subagent）不允许人类交互，提问失败时回退为“保留 pending”。
 */
async function askResolveConflicts(ctx, client, agent, response, timeoutMs, telemetry) {
    const ids = new Set();
    for (const result of response.results ?? []) {
        if (result.status !== 'pending_review')
            continue;
        const changeId = result.change?.changeId;
        if (typeof changeId === 'string' && changeId.length > 0)
            ids.add(changeId);
    }
    if (ids.size === 0)
        return;
    const service = ctx.get('userQuestions');
    if (service === undefined) {
        telemetry.log('warn', 'capture', 'userQuestions 不可用，冲突保留 pending', { ids: [...ids] });
        return;
    }
    let pending;
    try {
        pending = (await client.pending(timeoutMs)).items;
    }
    catch (error) {
        telemetry.log('warn', 'capture', `读取 pending 失败：${String(error)}`);
        return;
    }
    const changes = pending.filter((change) => ids.has(change.changeId)).slice(0, 3);
    if (changes.length === 0) {
        telemetry.log('info', 'capture', '未在 pending 中找到本次变更（可能已被自动处理）', { ids: [...ids] });
        return;
    }
    telemetry.log('info', 'capture', `准备冲突提问：${changes.length} 条`, {
        changes: changes.map((change) => ({ id: change.changeId, topic: change.topic, current: change.current !== null })),
    });
    const questions = changes.map((change) => {
        const isConflict = change.current !== null;
        const proposed = shortStatement(change.proposed.statement);
        return {
            id: change.changeId,
            header: isConflict ? '记忆冲突' : '疑似重复',
            question: isConflict
                ? `「${change.topic}」现在记录的是：${shortStatement(change.current?.statement ?? '')}。新捕获：${proposed}。如何处理？`
                : `「${change.topic}」已有相似记忆，新捕获：${proposed}。是否写入？`,
            ...(isConflict
                ? { detail: '选择“合并”时请输入合并后的陈述；不回答则保留 pending。' }
                : {}),
            options: isConflict
                ? [
                    { label: '替换', description: '用新记忆取代旧记忆，旧版进历史' },
                    { label: '保留', description: '保留旧记忆，丢弃这次捕获' },
                    { label: '合并', description: '输入合并后的陈述（自定义答案）' },
                ]
                : [
                    { label: '写入', description: '仍然写入这条新记忆' },
                    { label: '放弃', description: '丢弃这次捕获' },
                ],
        };
    });
    let answer;
    try {
        // turn-stopping 里拿到的是 Agent 快照；userQuestions 要求 registry 里的
        // “exact live instance”，否则会报 human interaction requires the exact live
        // calling agent。先经 agents.get 换成 live root。
        const agents = ctx.get('agents');
        const liveAgent = agents?.get?.(agent.id) ?? agent;
        telemetry.log('info', 'capture', '等待用户裁决冲突', {
            agent: agent.id,
            live: liveAgent !== agent,
        });
        answer = await service.ask({ agent: liveAgent, questions });
        telemetry.log('info', 'capture', '收到冲突裁决', { answers: answer.answers });
    }
    catch (error) {
        // 子会话、会话已关闭、没有 UI answerer 等：保持 pending，不阻塞回答。
        telemetry.log('warn', 'capture', `冲突决策弹窗不可用，保留 pending：${String(error)}`);
        return;
    }
    for (const item of answer.answers) {
        const change = changes.find((candidate) => candidate.changeId === item.id);
        if (change === undefined)
            continue;
        const selected = item.selected[0];
        if (selected === undefined)
            continue;
        if (selected === '合并') {
            const merged = item.custom?.trim() ?? '';
            if (merged.length === 0) {
                telemetry.log('warn', 'capture', `合并未提供文本，保留 pending：${change.changeId}`);
                continue;
            }
            try {
                await client.resolve(change.changeId, 'merge', {
                    statement: merged,
                    reason: 'auto-capture conflict prompt',
                });
                telemetry.log('info', 'capture', `冲突已裁决：${change.changeId} → merge`);
            }
            catch (error) {
                telemetry.log('warn', 'capture', `合并裁决失败，保留 pending：${String(error)}`);
            }
            continue;
        }
        const decision = selected === '替换' || selected === '写入' ? 'replace' : 'keep';
        try {
            await client.resolve(change.changeId, decision, {
                reason: 'auto-capture conflict prompt',
            });
            telemetry.log('info', 'capture', `冲突已裁决：${change.changeId} → ${decision}`);
        }
        catch (error) {
            telemetry.log('warn', 'capture', `冲突裁决失败，保留 pending：${String(error)}`);
        }
    }
}
/**
 * 安装自动捕获监听器。
 * @param ctx - Host 插件上下文。
 * @param config - 插件配置。
 * @param client - 网关客户端。
 * @param runtime - 召回模块提供的“本回合最后 user 文本”视图。
 */
export function installCapture(ctx, config, client, runtime, telemetry) {
    const counter = { day: '', count: 0 };
    const seen = new Set();
    telemetry.state.daily.limit = config.captureDailyLimit;
    ctx.on('agent/turn-stopping', (payload) => {
        if (!config.autoCapture) {
            telemetry.log('debug', 'capture', 'autoCapture=false，跳过');
            return;
        }
        if (payload.signal.aborted) {
            telemetry.log('debug', 'capture', 'turn-stopping 已中止，跳过');
            return;
        }
        const record = runtime.lastUserText(payload.agent.id);
        // 只看属于本回合的文本，避免复用上一回合的残留。
        if (record === undefined || record.turn !== payload.turn) {
            telemetry.log('debug', 'capture', '跳过：没有本回合的用户文本', {
                turn: payload.turn,
                recordTurn: record?.turn ?? null,
            });
            return;
        }
        const text = record.text.trim();
        const textPreview = truncateText(text, 200);
        const matched = config.captureMode === 'always' || looksLikePreference(text);
        if (!matched) {
            telemetry.recordCapture({
                at: new Date().toISOString(),
                turn: payload.turn,
                text: textPreview,
                matched: false,
                reason: '未命中偏好句式（captureMode=heuristic）',
            });
            telemetry.log('debug', 'capture', '未命中偏好句式，跳过', {
                turn: payload.turn,
                captureMode: config.captureMode ?? 'heuristic',
                text: textPreview,
            });
            return;
        }
        const digest = digestOf(text);
        if (seen.has(digest)) {
            telemetry.recordCapture({
                at: new Date().toISOString(),
                turn: payload.turn,
                text: textPreview,
                matched: true,
                reason: '重复文本，已跳过',
            });
            telemetry.log('debug', 'capture', '重复文本，已跳过', { turn: payload.turn });
            return;
        }
        if (!takeDailySlot(counter, config.captureDailyLimit, new Date())) {
            telemetry.setDaily(counter.day, counter.count, config.captureDailyLimit);
            telemetry.recordCapture({
                at: new Date().toISOString(),
                turn: payload.turn,
                text: textPreview,
                matched: true,
                reason: '已达每日自动捕获上限',
            });
            telemetry.log('warn', 'capture', '已达每日自动捕获上限，跳过本回合', {
                day: counter.day,
                count: counter.count,
                limit: config.captureDailyLimit,
            });
            return;
        }
        telemetry.setDaily(counter.day, counter.count, config.captureDailyLimit);
        seen.add(digest);
        while (seen.size > MAX_SEEN_DIGESTS) {
            const oldest = seen.values().next();
            if (oldest.done === true)
                break;
            seen.delete(oldest.value);
        }
        const sessionId = payload.agent.id;
        telemetry.recordCapture({
            at: new Date().toISOString(),
            turn: payload.turn,
            text: textPreview,
            matched: true,
            reason: '开始提取',
        });
        telemetry.log('info', 'capture', '命中偏好句式，开始提取', {
            turn: payload.turn,
            text: textPreview,
        });
        void (async () => {
            const startedAt = Date.now();
            try {
                const response = await client.extract({
                    sessionId,
                    messages: [{ role: 'user', content: text.slice(0, MAX_CAPTURE_CHARS) }],
                }, config.captureTimeoutMs ?? CAPTURE_TIMEOUT_MS);
                const summary = summarizeExtract(response, config.captureMinConfidence);
                telemetry.recordCapture({
                    at: new Date().toISOString(),
                    turn: payload.turn,
                    text: textPreview,
                    matched: true,
                    reason: '提取完成',
                    status: summary,
                    ms: Date.now() - startedAt,
                });
                telemetry.log('info', 'capture', `提取完成：${summary}`, {
                    turn: payload.turn,
                    results: response.results,
                });
                await askResolveConflicts(ctx, client, payload.agent, response, DEFAULT_REQUEST_TIMEOUT_MS, telemetry);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                telemetry.recordCapture({
                    at: new Date().toISOString(),
                    turn: payload.turn,
                    text: textPreview,
                    matched: true,
                    reason: '提取失败',
                    error: message,
                    ms: Date.now() - startedAt,
                });
                telemetry.log('warn', 'capture', `自动捕获失败（忽略）：${message}`, {
                    turn: payload.turn,
                });
            }
        })();
    });
}
