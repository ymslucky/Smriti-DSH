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
/** 框架注入的上下文来源，不应当被当成“用户这句话”。 */
const NON_USER_SOURCES = new Set(['runtime-context', 'system-prompt', 'agent-instructions']);
/**
 * 从本步进批的消息里取最后一条真正的用户输入。
 *
 * 优先选 `source.kind === 'user'`；否则取最后一条来源不是框架上下文的带文本消息
 * （子智能体的 prompt 等来源仍然算用户输入）。`runtime-context` 之类的注入消息
 * 既不参与召回，也不参与捕获。
 * @param messages - `agent/pre-step` 的 `messages`。
 * @returns 文本；没有可用文本时返回 `undefined`。
 */
export function lastUserTextOf(messages) {
    let fallback;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message === undefined)
            continue;
        const kind = message.source?.kind;
        if (kind !== undefined && NON_USER_SOURCES.has(kind))
            continue;
        const text = textOfUserMessage(message);
        if (text.length === 0)
            continue;
        if (kind === 'user')
            return text;
        if (fallback === undefined)
            fallback = text;
    }
    return fallback;
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
export function installRecall(ctx, config, client) {
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
        }
        if (decision.kind === 'reject')
            return decision;
        if (!config.autoRecall)
            return decision;
        if (payload.signal.aborted)
            return decision;
        if (userText === undefined)
            return decision;
        // 空进批（工具续步等）不查询：没有新的用户文本。
        if (decision.messages.length === 0)
            return decision;
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
        }
        else {
            try {
                const response = await client.recall(userText, config.recallMaxResults, config.recallTimeoutMs ?? RECALL_TIMEOUT_MS);
                items = response.items;
                recalled.set(sessionId, { query: userText, items });
                trimToLimit(recalled);
            }
            catch (error) {
                latest = undefined;
                contexts.delete(sessionId);
                ctx.logger.debug('[smriti] 召回失败（按无记忆继续）：%s', error instanceof Error ? error.message : String(error));
                return decision;
            }
        }
        if (payload.signal.aborted)
            return decision;
        const text = formatMemoryContext(items ?? [], recallCharBudget(config));
        if (text === undefined) {
            latest = undefined;
            contexts.delete(sessionId);
            return decision;
        }
        contexts.set(sessionId, text);
        trimToLimit(contexts);
        latest = text;
        const injectedCount = /count="(\d+)"/.exec(text)?.[1] ?? '0';
        ctx.logger.debug(`[smriti] 召回记忆 ${injectedCount} 条（turn ${payload.turn} step ${payload.step}）`);
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
