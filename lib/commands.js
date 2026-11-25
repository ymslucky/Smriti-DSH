/**
 * `/memory` 人工命令：待裁决复核、召回检索、显式保存与遗忘。
 *
 * 只注册一个命令 `memory`，子命令由 `rawInput` 解析：
 * `review` / `approve <id>` / `reject <id> [reason]` / `search <q>` /
 * `save <topic> <text>` / `forget <topic> <id> [reason]` / `topics`。
 */
import { FORGET_TOOL, UPSERT_TOOL, } from './gateway.js';
/** 命令体提示文本。 */
const USAGE = [
    'review                    列出待裁决变更',
    'approve <id>              批准一条待裁决变更',
    'reject <id> [reason]      拒绝一条待裁决变更',
    'resolve <id> replace|keep|merge [merged text]  直接裁决一条待裁决变更',
    'context                   查看最近一次注入的记忆上下文',
    'search <query>            检索记忆',
    'save <topic> <text>       显式保存一条偏好',
    'forget <topic> <id> [reason]  遗忘一条偏好',
    'topics                    列出主题与条数',
].join('\n');
function asRecord(value) {
    return typeof value === 'object' && value !== null ? value : undefined;
}
function statusText(payload) {
    const record = asRecord(payload);
    if (record === undefined)
        return typeof payload === 'string' ? payload : 'ok';
    const status = record.status;
    if (typeof status === 'string') {
        const message = record.message;
        return typeof message === 'string' && message.length > 0 ? `${status}（${message}）` : status;
    }
    const change = asRecord(record.change);
    if (change !== undefined && typeof change.changeId === 'string') {
        return `pending_review（${change.changeId}）`;
    }
    const memory = asRecord(record.memory);
    if (memory !== undefined && typeof memory.id === 'string')
        return `applied（${memory.id}）`;
    return 'ok';
}
function formatPending(items) {
    if (items.length === 0)
        return '没有待裁决变更。';
    const lines = [`待裁决 ${items.length} 项：`];
    for (const [index, item] of items.entries()) {
        const current = item.current;
        const proposed = item.proposed ?? { statement: '(缺失)' };
        const confidence = typeof proposed.confidence === 'number' ? ` conf=${proposed.confidence.toFixed(2)}` : '';
        lines.push(`${index + 1}. [${item.kind}] ${item.topic}  id=${item.changeId}`);
        lines.push(`   现状：${current === null || current === undefined ? '(无)' : current.statement}`);
        lines.push(`   建议：${proposed.statement}${confidence}`);
    }
    lines.push('用 /memory approve <id> 或 /memory reject <id> [reason] 处理。');
    return lines.join('\n');
}
function formatRecall(items) {
    if (items.length === 0)
        return '没有命中记忆。';
    return items.map((item) => `- [${item.topic}] ${item.statement}  (id=${item.id})`).join('\n');
}
function formatTopics(items) {
    if (items.length === 0)
        return '没有主题数据。';
    return items
        .map((item) => {
        const count = typeof item.count === 'number' ? ` ×${item.count}` : '';
        const label = item.label !== undefined && item.label.length > 0 ? ` ${item.label}` : '';
        return `- ${item.topic}${count}${label}`;
    })
        .join('\n');
}
/** 按“第一个词 + 其余原文”切分，保留文本内部的空格。 */
function splitFirst(raw) {
    const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(raw);
    if (match === null)
        return { head: '', tail: '' };
    return { head: match[1] ?? '', tail: (match[2] ?? '').trim() };
}
/**
 * 注册 `/memory` 命令。
 * @param ctx - Host 插件上下文。
 * @param config - 插件配置。
 * @param client - 网关客户端。
 */
export function registerCommands(ctx, config, client, runtime) {
    const commands = ctx.get('commands');
    if (commands === undefined) {
        ctx.logger.warn('[smriti] commands 服务不可用，/memory 未注册');
        return;
    }
    const dispatch = async (invocation) => {
        const raw = invocation.rawInput.trim();
        const { head, tail } = splitFirst(raw);
        switch (head) {
            case '': {
                return { kind: 'success', text: USAGE };
            }
            case 'review': {
                const response = await client.pending();
                return { kind: 'success', text: formatPending(response.items) };
            }
            case 'topics': {
                const topics = await client.topics();
                return { kind: 'success', text: formatTopics(topics) };
            }
            case 'context': {
                const context = runtime.lastContext(invocation.agent.id);
                return {
                    kind: 'success',
                    text: context ?? '还没有注入记忆上下文（自动召回可能未触发，或本次没有命中）。',
                };
            }
            case 'search': {
                if (tail.length === 0)
                    return { kind: 'error', text: '用法：/memory search <query>' };
                const response = await client.recall(tail, config.recallMaxResults);
                return { kind: 'success', text: formatRecall(response.items) };
            }
            case 'approve': {
                if (tail.length === 0)
                    return { kind: 'error', text: '用法：/memory approve <id>' };
                const result = await client.approve(splitFirst(tail).head);
                return { kind: 'success', text: `已提交批准：${statusText(result)}` };
            }
            case 'reject': {
                const parsed = splitFirst(tail);
                if (parsed.head.length === 0)
                    return { kind: 'error', text: '用法：/memory reject <id> [reason]' };
                const result = await client.reject(parsed.head, parsed.tail.length > 0 ? parsed.tail : 'user rejected');
                return { kind: 'success', text: `已提交拒绝：${statusText(result)}` };
            }
            case 'resolve': {
                const parsed = splitFirst(tail);
                const rest = splitFirst(parsed.tail);
                const decision = rest.head;
                if (parsed.head.length === 0 || (decision !== 'replace' && decision !== 'keep' && decision !== 'merge')) {
                    return { kind: 'error', text: '用法：/memory resolve <id> replace|keep|merge [merged text]' };
                }
                if (decision === 'merge' && rest.tail.length === 0) {
                    return { kind: 'error', text: 'merge 需要合并后的陈述：/memory resolve <id> merge <text>' };
                }
                const result = await client.resolve(parsed.head, decision, {
                    ...(decision === 'merge' ? { statement: rest.tail } : {}),
                    reason: 'user command',
                });
                return { kind: 'success', text: `已裁决 ${parsed.head} → ${decision}：${statusText(result)}` };
            }
            case 'save': {
                const parsed = splitFirst(tail);
                if (parsed.head.length === 0 || parsed.tail.length === 0) {
                    return { kind: 'error', text: '用法：/memory save <topic> <text>' };
                }
                const result = await client.callTool(UPSERT_TOOL, {
                    topic: parsed.head,
                    statement: parsed.tail,
                    confidence: config.captureMinConfidence,
                    source: { session: invocation.agent.id },
                });
                return { kind: 'success', text: `保存 ${parsed.head}：${statusText(result)}` };
            }
            case 'forget': {
                const parsed = splitFirst(tail);
                const rest = splitFirst(parsed.tail);
                if (parsed.head.length === 0 || rest.head.length === 0) {
                    return { kind: 'error', text: '用法：/memory forget <topic> <id> [reason]' };
                }
                const result = await client.callTool(FORGET_TOOL, {
                    topic: parsed.head,
                    id: rest.head,
                    reason: rest.tail.length > 0 ? rest.tail : 'user forget',
                });
                return { kind: 'success', text: `已遗忘 ${parsed.head}/${rest.head}：${statusText(result)}` };
            }
            default: {
                return { kind: 'error', text: `未知子命令 "${head}"。\n${USAGE}` };
            }
        }
    };
    try {
        commands.register({
            name: 'memory',
            description: 'Smriti 记忆：复核待裁决、检索、保存与遗忘偏好',
            input: { hint: 'review | approve <id> | reject <id> [reason] | resolve <id> replace|keep|merge [text] | context | search <q> | save <topic> <text> | forget <topic> <id> [reason] | topics' },
            handler: async (invocation) => {
                try {
                    return await dispatch(invocation);
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    return { kind: 'error', text: `Smriti 调用失败：${message}` };
                }
            },
        });
        ctx.logger.info('[smriti] /memory 命令已注册');
    }
    catch (error) {
        ctx.logger.warn('[smriti] /memory 命令注册失败：%s', error instanceof Error ? error.message : String(error));
    }
}
