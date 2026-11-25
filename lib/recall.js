/**
 * 自动召回：`agent/pre-step` 里按本步进批的最后一条 user 文本查询记忆，
 * 结果写入插件注册的 `systemPrompt.context`（`smriti-memory`），由 Host
 * 在每次装配时生成 runtime-context 快照 —— Chat 里默认折叠，不占对话正文。
 *
 * 约束：
 * - 把网络等待限制在关键路径预算内（{@link RECALL_TIMEOUT_MS}）；
 * - 同一 `turn + step` 只查询一次；
 * - 每会话缓存最近一次查询的结果，避免同一步/重试重复请求；
 * - 任何失败都只是“无记忆”，不改变 `next()` 的决策。
 */
import { recallCharBudget } from './config.js';
import { RECALL_TIMEOUT_MS } from './gateway.js';
import { truncateText } from './telemetry.js';
/** 会话缓存上限：超出后按插入顺序淘汰最旧条目。 */
const MAX_TRACKED_SESSIONS = 256;
function trimToLimit(map) {
    while (map.size > MAX_TRACKED_SESSIONS) {
        const oldest = map.keys().next();
        if (oldest.done === true)
            return;
        map.delete(oldest.value);
    }
}
/**
 * 取一条 user 消息里的纯文本。
 * @param message - Host 的 user 消息结构。
 * @returns 拼接后的文本；没有文本块时返回空串。
 */
export function textOfUserMessage(message) {
    const blocks = Array.isArray(message.content) ? message.content : [];
    const texts = blocks
        .filter((block) => (block.type === 'text' && typeof block.text === 'string'))
        .map((block) => block.text);
    return texts.join('\n').trim();
}
/**
 * 从本步进批的消息里取最后一条真正的用户输入。
 *
 * 只接受 `source.kind === 'user'`（或旧消息没有 source.kind）；子智能体报告、
 * agent-message、user-question-reply、runtime-context 等都不算“用户这句话”，
 * 避免拿子会话的汇报文本去召回/捕获。
 * @param messages - `agent/pre-step` 的 `messages`。
 * @returns 文本；没有可用文本时返回 `undefined`。
 */
export function lastUserTextOf(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message === undefined)
            continue;
        const kind = message.source?.kind;
        if (kind !== undefined && kind !== 'user')
            continue;
        const text = textOfUserMessage(message);
        if (text.length > 0)
            return text;
    }
    return undefined;
}
/**
 * 把召回条目格式化成 `<memory_context count="N">…</memory_context>`，并按字符预算裁剪。
 * @param items - 召回条目。
 * @param maxChars - 字符预算（`recallMaxTokens × 4`）。
 * @returns 上下文文本；预算不足或没有条目时返回 `undefined`。
 */
export function formatMemoryContext(items, maxChars) {
    if (items.length === 0 || maxChars <= 0)
        return undefined;
    const close = '</memory_context>';
    const open = (count) => `<memory_context count="${count}">`;
    let body = '';
    let count = 0;
    for (const item of items) {
        const statement = typeof item.statement === 'string' ? item.statement.trim() : '';
        if (statement.length === 0)
            continue;
        const line = `- [${item.topic}] ${statement}`;
        const nextCount = count + 1;
        const nextBody = body.length === 0 ? line : `${body}\n${line}`;
        const total = open(nextCount).length + 1 + nextBody.length + 1 + close.length;
        if (total <= maxChars) {
            body = nextBody;
            count = nextCount;
            continue;
        }
        if (count === 0) {
            const available = maxChars - open(1).length - 2 - close.length;
            if (available >= 8) {
                body = `${line.slice(0, available - 1)}…`;
                count = 1;
            }
        }
        break;
    }
    if (count === 0)
        return undefined;
    return `${open(count)}\n${body}\n${close}`;
}
/**
 * 安装自动召回监听器。
 * @param ctx - Host 插件上下文。
 * @param config - 插件配置。
 * @param client - 网关客户端。
 * @returns 供自动捕获读取“本回合最后一条 user 文本”的运行时视图。
 */
export function installRecall(ctx, config, client, telemetry) {
    const texts = new Map();
    const contexts = new Map();
    const recalled = new Map();
    const injected = new Map();
    let latest;
    ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next();
        // 无论是否注入，都记下本步进批的用户文本，供回合结束后的自动捕获使用。
        const userText = lastUserTextOf(payload.messages);
        if (userText !== undefined) {
            texts.set(payload.agent.id, { turn: payload.turn, text: userText });
            trimToLimit(texts);
            telemetry.log('debug', 'recall', 'pre-step 收到用户文本', {
                turn: payload.turn,
                step: payload.step,
                text: truncateText(userText, 160),
            });
        }
        if (decision.kind === 'reject') {
            if (userText !== undefined)
                telemetry.log('debug', 'recall', 'pre-step 被拒绝，跳过召回');
            return decision;
        }
        if (!config.autoRecall) {
            if (userText !== undefined)
                telemetry.log('debug', 'recall', 'autoRecall=false，跳过召回');
            return decision;
        }
        if (payload.signal.aborted) {
            if (userText !== undefined)
                telemetry.log('debug', 'recall', 'pre-step 已中止，跳过召回');
            return decision;
        }
        if (userText === undefined)
            return decision;
        // 空进批（工具续步等）不查询：没有新的用户文本。
        if (decision.messages.length === 0) {
            telemetry.log('debug', 'recall', '空进批，跳过召回', { turn: payload.turn, step: payload.step });
            return decision;
        }
        const sessionId = payload.agent.id;
        const guard = injected.get(sessionId);
        if (guard !== undefined && guard.turn === payload.turn && guard.steps.has(payload.step))
            return decision;
        if (guard === undefined || guard.turn !== payload.turn) {
            injected.set(sessionId, { turn: payload.turn, steps: new Set([payload.step]) });
        }
        else {
            guard.steps.add(payload.step);
        }
        trimToLimit(injected);
        let items;
        const cached = recalled.get(sessionId);
        if (cached !== undefined && cached.query === userText) {
            items = cached.items;
            telemetry.log('debug', 'recall', `复用缓存：${items.length} 条`, { turn: payload.turn });
        }
        else {
            const startedAt = Date.now();
            try {
                telemetry.log('info', 'recall', '开始召回', {
                    turn: payload.turn,
                    query: truncateText(userText, 160),
                });
                const response = await client.recall(userText, config.recallMaxResults, config.recallTimeoutMs ?? RECALL_TIMEOUT_MS);
                items = response.items;
                const elapsed = Date.now() - startedAt;
                telemetry.recordRecall({
                    at: new Date().toISOString(),
                    query: truncateText(userText, 160),
                    items: items.length,
                    ms: elapsed,
                });
                telemetry.log('info', 'recall', `召回完成：${items.length} 条 / ${elapsed}ms`, {
                    turn: payload.turn,
                    topics: items.map((item) => item.topic),
                });
                recalled.set(sessionId, { query: userText, items });
                trimToLimit(recalled);
            }
            catch (error) {
                latest = undefined;
                contexts.delete(sessionId);
                const message = error instanceof Error ? error.message : String(error);
                telemetry.recordRecall({
                    at: new Date().toISOString(),
                    query: truncateText(userText, 160),
                    items: 0,
                    ms: Date.now() - startedAt,
                    error: message,
                });
                telemetry.log('warn', 'recall', `召回失败：${message}`, {
                    turn: payload.turn,
                    query: truncateText(userText, 160),
                });
                return decision;
            }
        }
        if (payload.signal.aborted)
            return decision;
        const text = formatMemoryContext(items ?? [], recallCharBudget(config));
        if (text === undefined) {
            latest = undefined;
            contexts.delete(sessionId);
            telemetry.log('info', 'recall', '召回无命中，清空上下文', { turn: payload.turn });
            return decision;
        }
        contexts.set(sessionId, text);
        trimToLimit(contexts);
        latest = text;
        const injectedCount = /count="(\d+)"/.exec(text)?.[1] ?? '0';
        telemetry.log('info', 'recall', `写入上下文：${injectedCount} 条（turn ${payload.turn} step ${payload.step}）`);
        // 不修改 decision.messages：由 systemPrompt.context 负责把 latest 变成
        // 本轮 runtime-context 快照，Chat 里默认折叠显示。
        return decision;
    });
    return {
        lastUserText(agentId) {
            return texts.get(agentId);
        },
        lastContext(agentId) {
            return contexts.get(agentId);
        },
        latestContext() {
            return latest;
        },
    };
}
