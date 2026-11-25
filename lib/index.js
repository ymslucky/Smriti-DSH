/**
 * Smriti 记忆插件（Host 面）：把 Smriti Worker 暴露的 MCP 记忆服务接进 dsh，
 * 并提供自动召回（`agent/pre-step`）与自动捕获（`agent/turn-stopping`）。
 *
 * 入口契约：导出 `name` 与 `apply(ctx, config)`；不导出 `Config`（默认值在
 * `src/config.ts` 里补齐），运行时依赖全部通过 `ctx.get(...)` 软获取。
 */
import { installCapture } from './capture.js';
import { registerCommands } from './commands.js';
import { resolveConfig } from './config.js';
import { GatewayClient } from './gateway.js';
import { registerMcp } from './mcp.js';
import { installRecall } from './recall.js';
/** 插件名（与 `cordis.patch.yml` 的行 id / 包名一致）。 */
export const name = 'smriti-dsh';
/** 未启用召回与捕获时的空运行时视图。 */
const NO_TEXT = {
    lastUserText: () => undefined,
    lastContext: () => undefined,
    latestContext: () => undefined,
};
/**
 * 插件入口。
 * @param ctx - Host 插件上下文（由 dsh 注入）。
 * @param rawConfig - `cordis.patch.yml` 的 `config` 段；缺项按默认值补齐。
 */
export function apply(ctx, rawConfig) {
    const config = resolveConfig(rawConfig);
    if (config.gatewayUrl.length === 0) {
        ctx.logger.warn('[smriti] gatewayUrl 未配置，插件不生效');
        return;
    }
    const client = new GatewayClient(ctx, config);
    ctx.logger.info(`[smriti] 启动：gateway=${config.gatewayUrl} recall=${String(config.autoRecall)}`
        + ` capture=${String(config.autoCapture)} mcp=${config.mcpServerName}`);
    // 捕获需要“本回合最后一条 user 文本”，这份记录由召回监听器顺带维护。
    const runtime = config.autoRecall || config.autoCapture
        ? installRecall(ctx, config, client)
        : NO_TEXT;
    if (config.autoCapture)
        installCapture(ctx, config, client, runtime);
    // 用 Host 的 systemPrompt.context 生成 runtime-context 快照：模型能看到，
    // 但 Chat 里是默认折叠的「上下文」行，不会变成聊天气泡。
    if (config.autoRecall) {
        const prompt = ctx.get('systemPrompt');
        if (prompt === undefined) {
            ctx.logger.warn('[smriti] systemPrompt 不可用，自动召回只更新缓存、不进入模型上下文');
        }
        else {
            const dispose = prompt.context({
                name: 'smriti-memory',
                order: 50,
                required: true,
                interpolate: false,
                // AssembleContext 由 dsh-agent 扩展了 `agent`：按会话取，避免多会话串味。
                text: (context) => {
                    const agentId = context?.agent?.id;
                    return (agentId === undefined ? runtime.latestContext() : runtime.lastContext(agentId)) ?? '';
                },
            });
            if (typeof ctx.effect === 'function')
                ctx.effect(() => dispose);
        }
    }
    registerCommands(ctx, config, client, runtime);
    // 可选的 Client 半用它拉取当前会话的记忆上下文；只暴露这段文本，不暴露凭据。
    const server = ctx.get('webServer');
    if (server !== undefined) {
        const dispose = server.register({
            kind: 'exact',
            path: '/plugins/smriti/context',
            resource: async (request, peer) => {
                if (peer?.principal?.kind !== undefined && peer.principal.kind !== 'owner') {
                    return new Response(JSON.stringify({ error: 'forbidden' }), {
                        status: 403,
                        headers: { 'content-type': 'application/json' },
                    });
                }
                const site = request.headers.get('sec-fetch-site');
                if (site !== null && site !== 'same-origin' && site !== 'none') {
                    return new Response(JSON.stringify({ error: 'forbidden' }), {
                        status: 403,
                        headers: { 'content-type': 'application/json' },
                    });
                }
                const sessionId = new URL(request.url).searchParams.get('session') ?? '';
                const context = sessionId.length === 0 ? undefined : runtime.lastContext(sessionId);
                return new Response(JSON.stringify({ session: sessionId, context: context ?? null }), {
                    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
                });
            },
        });
        if (typeof ctx.effect === 'function')
            ctx.effect(() => dispose);
    }
    void registerMcp(ctx, config, (ref) => client.resolveCredential(ref)).catch((error) => {
        ctx.logger.warn('[smriti] MCP 注册过程异常：%s', error instanceof Error ? error.message : String(error));
    });
}
