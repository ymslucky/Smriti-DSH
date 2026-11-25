/**
 * MCP 注册：把 Smriti 的 `memory_*` 工具接进当前 Host。
 *
 * `ctx.get('mcpManager').register(name, entry)` 把服务器贡献给插件生命周期：
 * 插件卸载时 registration disposer 会自动撤下工具，因此这里不需要额外清理。
 */
import { CLIENT_ID_REF, CLIENT_SECRET_REF, MCP_TIMEOUT_MS } from './gateway.js';
/** 已注册过的（manager, serverName）组合；避免 HMR 重复 apply 时重复注册。 */
const registered = new WeakMap();
/** 凭据模板语法：mcp-client 在连接时解析，支持轮换而不重启。 */
function template(ref) {
    return `\${credential:${ref}}`;
}
/**
 * 注册 Smriti MCP 服务器；已注册或服务不可用时只告警/调试日志。
 * @param ctx - Host 插件上下文。
 * @param config - 插件配置。
 * @param resolveCredential - 凭据解析（credentials 服务 → 进程环境变量）。
 * @returns registration disposer；未注册时返回 `undefined`。
 */
export async function registerMcp(ctx, config, resolveCredential) {
    if (config.exposeMcp === false) {
        ctx.logger.info('[smriti] exposeMcp=false，跳过 MCP 注册（沿用 profile 里已有的同名 MCP 服务器）');
        return undefined;
    }
    if (config.gatewayUrl.length === 0) {
        ctx.logger.warn('[smriti] gatewayUrl 为空，跳过 MCP 注册');
        return undefined;
    }
    const manager = ctx.get('mcpManager');
    if (manager === undefined) {
        ctx.logger.warn('[smriti] mcpManager 服务不可用，memory_* 工具未注册');
        return undefined;
    }
    let names = registered.get(manager);
    if (names === undefined) {
        names = new Set();
        registered.set(manager, names);
    }
    if (names.has(config.mcpServerName)) {
        ctx.logger.debug(`[smriti] MCP 服务器 ${config.mcpServerName} 已注册，跳过`);
        return undefined;
    }
    let clientId;
    let clientSecret;
    try {
        clientId = await resolveCredential(CLIENT_ID_REF);
        clientSecret = await resolveCredential(CLIENT_SECRET_REF);
    }
    catch (error) {
        ctx.logger.warn('[smriti] 解析 Access service token 失败：%s', String(error));
    }
    const headers = {
        'CF-Access-Client-Id': clientId ?? template(CLIENT_ID_REF),
        'CF-Access-Client-Secret': clientSecret ?? template(CLIENT_SECRET_REF),
    };
    const entry = {
        transport: 'streamable-http',
        url: `${config.gatewayUrl}/mcp`,
        headers,
        toolCallTimeoutMs: MCP_TIMEOUT_MS,
    };
    try {
        const disposer = manager.register(config.mcpServerName, entry);
        names.add(config.mcpServerName);
        if (clientId === undefined || clientSecret === undefined) {
            ctx.logger.warn(`[smriti] ${CLIENT_ID_REF} / ${CLIENT_SECRET_REF} 尚未解析，MCP 服务器以凭据模板注册（需 credentials 提供方）`);
        }
        ctx.logger.info(`[smriti] MCP 服务器 ${config.mcpServerName} 已注册：${entry.url}`);
        return disposer;
    }
    catch (error) {
        ctx.logger.warn(`[smriti] MCP 服务器 ${config.mcpServerName} 注册失败（可能是同名服务器已被配置）：%s`, error instanceof Error ? error.message : String(error));
        return undefined;
    }
}
