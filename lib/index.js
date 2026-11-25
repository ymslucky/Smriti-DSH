/**
 * Smriti 记忆插件（Host 面）：把 Smriti Worker 暴露的 MCP 记忆服务接进 dsh，
 * 并提供自动召回（`agent/pre-step` + `systemPrompt.context`）与自动捕获
 * （`agent/turn-stopping`），以及给 Client 半用的只读状态/上下文路由。
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
import { Telemetry } from './telemetry.js';
/** 插件名（与 `cordis.patch.yml` 的行 id / 包名一致）。 */
export const name = 'smriti-dsh';
/** 未启用召回与捕获时的空运行时视图。 */
const NO_TEXT = {
    lastUserText: () => undefined,
    lastContext: () => undefined,
    latestContext: () => undefined,
};
function forbidden() {
    return new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json; charset=utf-8' },
    });
}
/** 只允许 owner peer / 同源（或非浏览器）请求；不做跨站 CORS。 */
function guard(request, peer) {
    if (peer?.principal?.kind !== undefined && peer.principal.kind !== 'owner')
        return forbidden();
    const site = request.headers.get('sec-fetch-site');
    if (site !== null && site !== 'same-origin' && site !== 'none')
        return forbidden();
    return undefined;
}
function json(value) {
    return new Response(JSON.stringify(value), {
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
}
/**
 * 插件入口。
 * @param ctx - Host 插件上下文（由 dsh 注入）。
 * @param rawConfig - `cordis.patch.yml` 的 `config` 段；缺项按默认值补齐。
 */
export function apply(ctx, rawConfig) {
    const config = resolveConfig(rawConfig);
    const telemetry = new Telemetry(ctx.logger);
    telemetry.state.config = {
        gatewayUrl: config.gatewayUrl,
        mcpServerName: config.mcpServerName,
        autoRecall: config.autoRecall,
        autoCapture: config.autoCapture,
        recallMaxResults: config.recallMaxResults,
        recallMaxTokens: config.recallMaxTokens,
        captureDailyLimit: config.captureDailyLimit,
        captureMinConfidence: config.captureMinConfidence,
        captureMode: config.captureMode ?? 'heuristic',
        recallTimeoutMs: config.recallTimeoutMs,
        captureTimeoutMs: config.captureTimeoutMs,
        exposeMcp: config.exposeMcp ?? true,
    };
    if (config.gatewayUrl.length === 0) {
        telemetry.log('error', 'plugin', 'gatewayUrl 未配置，插件不生效');
        return;
    }
    const prompt = ctx.get('systemPrompt');
    const server = ctx.get('webServer');
    telemetry.state.capabilities = {
        systemPrompt: prompt !== undefined,
        webServer: server !== undefined,
        userQuestions: ctx.get('userQuestions') !== undefined,
        agents: ctx.get('agents') !== undefined,
        commands: ctx.get('commands') !== undefined,
        credentials: ctx.get('credentials') !== undefined,
        mcpManager: ctx.get('mcpManager') !== undefined,
    };
    telemetry.log('info', 'plugin', '启动', {
        gateway: config.gatewayUrl,
        autoRecall: config.autoRecall,
        autoCapture: config.autoCapture,
        mcpServerName: config.mcpServerName,
        capabilities: telemetry.state.capabilities,
    });
    const client = new GatewayClient(ctx, config);
    // 捕获需要“本回合最后一条 user 文本”，这份记录由召回监听器顺带维护。
    const runtime = config.autoRecall || config.autoCapture
        ? installRecall(ctx, config, client, telemetry)
        : NO_TEXT;
    if (config.autoCapture)
        installCapture(ctx, config, client, runtime, telemetry);
    // 用 Host 的 systemPrompt.context 生成 runtime-context 快照：模型能看到，
    // 但 Chat 里是默认折叠的「上下文」行，不会变成聊天气泡。
    if (config.autoRecall) {
        if (prompt === undefined) {
            telemetry.log('warn', 'plugin', 'systemPrompt 不可用，自动召回只更新缓存、不进入模型上下文');
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
    registerCommands(ctx, config, client, runtime, telemetry);
    // Client 半：上下文 + 状态/日志。只暴露这两类数据，不暴露凭据。
    if (server !== undefined) {
        const disposeContext = server.register({
            kind: 'exact',
            path: '/plugins/smriti/context',
            resource: async (request, peer) => {
                const denied = guard(request, peer);
                if (denied !== undefined)
                    return denied;
                const sessionId = new URL(request.url).searchParams.get('session') ?? '';
                const context = sessionId.length === 0 ? undefined : runtime.lastContext(sessionId);
                return json({ session: sessionId, context: context ?? null });
            },
        });
        if (typeof ctx.effect === 'function')
            ctx.effect(() => disposeContext);
        const disposeStatus = server.register({
            kind: 'exact',
            path: '/plugins/smriti/status',
            resource: async (request, peer) => {
                const denied = guard(request, peer);
                if (denied !== undefined)
                    return denied;
                const url = new URL(request.url);
                const since = Number.parseInt(url.searchParams.get('since') ?? '0', 10);
                const limit = Number.parseInt(url.searchParams.get('limit') ?? '200', 10);
                return json(telemetry.snapshot(Number.isFinite(since) && since > 0 ? since : 0, Number.isFinite(limit) && limit > 0 ? limit : 200));
            },
        });
        if (typeof ctx.effect === 'function')
            ctx.effect(() => disposeStatus);
    }
    if (telemetry.state.capabilities.mcpManager !== true) {
        telemetry.log('warn', 'mcp', 'mcpManager 不可用，跳过 MCP 注册');
    }
    else {
        void registerMcp(ctx, config, (ref) => client.resolveCredential(ref)).then(() => {
            telemetry.log('info', 'mcp', 'MCP 注册完成', { serverName: config.mcpServerName });
        }).catch((error) => {
            telemetry.log('warn', 'mcp', `MCP 注册过程异常：${error instanceof Error ? error.message : String(error)}`);
        });
    }
}
