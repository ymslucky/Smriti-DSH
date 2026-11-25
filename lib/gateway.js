/**
 * Smriti 网关客户端：fetch + Cloudflare Access 鉴权头 + 超时。
 *
 * REST 面（已定契约）：
 * - `GET  {base}/v1/health`
 * - `GET  {base}/v1/topics`
 * - `POST {base}/v1/recall`  `{query, limit}` → `{items}`
 * - `POST {base}/v1/extract` `{sessionId, messages}` → `{candidates, results}`
 * - `GET  {base}/v1/pending` → `{items}`
 * - `POST {base}/v1/pending/{id}/approve`
 * - `POST {base}/v1/pending/{id}/reject` `{reason?}`
 *
 * 写入面只有 MCP（`POST {base}/mcp`，工具 `memory_*`），REST 没有 upsert/forget，
 * 因此 `/memory save`、`/memory forget` 走 {@link GatewayClient.callTool} 的最小
 * JSON-RPC（Streamable HTTP）实现。
 */
/** Cloudflare Access service token 的 client id 凭据名。 */
export const CLIENT_ID_REF = 'CF_ACCESS_CLIENT_ID';
/** Cloudflare Access service token 的 client secret 凭据名。 */
export const CLIENT_SECRET_REF = 'CF_ACCESS_CLIENT_SECRET';
/** 普通 REST 调用的默认超时。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 8000;
/** 召回默认超时：本机到网关的 AI Search 首字节实测约 5s，2s 会稳定超时。 */
export const RECALL_TIMEOUT_MS = 8000;
/** 回合结束后的捕获不能阻塞回合：后台请求默认 10s。 */
export const CAPTURE_TIMEOUT_MS = 10000;
/** MCP 工具调用超时（与 mcpManager 注册的 `toolCallTimeoutMs` 对齐）。 */
export const MCP_TIMEOUT_MS = 15000;
/** `memory_upsert`：显式保存一条偏好。 */
export const UPSERT_TOOL = 'memory_upsert';
/** `memory_forget`：遗忘一条偏好。 */
export const FORGET_TOOL = 'memory_forget';
/** 网关调用失败（带回 HTTP 状态与响应片段）。 */
export class GatewayError extends Error {
    status;
    constructor(message, status, options) {
        super(message, options);
        this.name = 'GatewayError';
        this.status = status;
    }
}
function isTextContent(value) {
    return typeof value === 'object'
        && value !== null
        && typeof value.type === 'string'
        && typeof value.text === 'string';
}
/**
 * 从候选数组/包装对象里取出条目数组，容忍 `{items}` / `{topics}` / 裸数组三种形态。
 * @param payload - 网关响应体。
 * @param keys - 可接受的包装键。
 * @returns 条目数组（无法识别时为空数组）。
 */
function pickArray(payload, keys) {
    if (Array.isArray(payload))
        return payload;
    if (typeof payload === 'object' && payload !== null) {
        for (const key of keys) {
            const value = payload[key];
            if (Array.isArray(value))
                return value;
        }
    }
    return [];
}
/** 从 SSE 或 JSON 文本里抽出与请求 id 匹配的 JSON-RPC 响应。 */
function parseRpcPayload(text, contentType, id) {
    const candidates = [];
    const trimmed = text.trim();
    if (trimmed.length === 0)
        return undefined;
    const looksSse = contentType.includes('text/event-stream') || trimmed.startsWith('data:');
    if (looksSse) {
        for (const line of trimmed.split(/\r?\n/)) {
            if (!line.startsWith('data:'))
                continue;
            const data = line.slice('data:'.length).trim();
            if (data.length === 0 || data === '[DONE]')
                continue;
            try {
                candidates.push(JSON.parse(data));
            }
            catch {
                // 忽略无法解析的心跳/片段
            }
        }
    }
    else {
        try {
            candidates.push(JSON.parse(trimmed));
        }
        catch {
            return undefined;
        }
    }
    for (const candidate of candidates) {
        if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate))
            continue;
        if (candidate.id === id)
            return candidate;
    }
    for (const candidate of candidates) {
        if (typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)) {
            return candidate;
        }
    }
    return undefined;
}
/** Smriti 网关客户端。 */
export class GatewayClient {
    base;
    ctx;
    config;
    constructor(ctx, config) {
        this.ctx = ctx;
        this.base = config.gatewayUrl;
        this.config = {
            accessClientId: config.accessClientId,
            accessClientSecret: config.accessClientSecret,
        };
    }
    /** 网关基址。 */
    get gatewayUrl() {
        return this.base;
    }
    /** 解析一项凭据：credentials 服务 → 插件配置里的字面量 → 进程环境变量。 */
    async resolveCredential(ref) {
        const service = this.ctx.get('credentials');
        if (service !== undefined) {
            try {
                const resolved = await service.resolve(ref);
                if (resolved !== undefined && typeof resolved.value === 'string' && resolved.value.length > 0) {
                    return resolved.value;
                }
            }
            catch (error) {
                this.ctx.logger.debug(`[smriti] credentials.resolve(${ref}) 失败：%s`, String(error));
            }
        }
        // 显式配置优先于环境变量，便于单用户自用时把 service token 写在 profile 覆盖里。
        const configured = ref === CLIENT_ID_REF
            ? this.config.accessClientId
            : ref === CLIENT_SECRET_REF
                ? this.config.accessClientSecret
                : undefined;
        if (typeof configured === 'string' && configured.length > 0)
            return configured;
        const fromEnv = process.env[ref];
        return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : undefined;
    }
    /** 解析 Access service token；缺任意一项都视为未配置。 */
    async resolveAccessToken() {
        const [clientId, clientSecret] = await Promise.all([
            this.resolveCredential(CLIENT_ID_REF),
            this.resolveCredential(CLIENT_SECRET_REF),
        ]);
        if (clientId === undefined || clientSecret === undefined)
            return undefined;
        return { clientId, clientSecret };
    }
    async authHeaders() {
        const token = await this.resolveAccessToken();
        if (token === undefined) {
            throw new GatewayError(`Smriti 凭据未配置：请设置 ${CLIENT_ID_REF} / ${CLIENT_SECRET_REF}（credentials 服务或环境变量）`);
        }
        return {
            'CF-Access-Client-Id': token.clientId,
            'CF-Access-Client-Secret': token.clientSecret,
        };
    }
    async requestJson(method, path, body, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
        if (this.base.length === 0) {
            throw new GatewayError('Smriti 网关地址未配置：请在插件 config 里设置 gatewayUrl');
        }
        const headers = {
            ...await this.authHeaders(),
            accept: 'application/json',
        };
        if (body !== undefined)
            headers['content-type'] = 'application/json';
        const signal = AbortSignal.timeout(Math.max(1, timeoutMs));
        let response;
        try {
            response = await fetch(`${this.base}${path}`, {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body),
                signal,
            });
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new GatewayError(`Smriti 请求失败：${method} ${path}：${reason}`, undefined, { cause: error });
        }
        if (!response.ok) {
            const snippet = await response.text().catch(() => '');
            throw new GatewayError(`Smriti 返回 ${response.status}：${method} ${path}${snippet.length > 0 ? `：${snippet.slice(0, 200)}` : ''}`, response.status);
        }
        const text = await response.text();
        if (text.trim().length === 0)
            return undefined;
        try {
            return JSON.parse(text);
        }
        catch (error) {
            throw new GatewayError(`Smriti 响应不是合法 JSON：${method} ${path}`, response.status, { cause: error });
        }
    }
    /** `GET /v1/health`。 */
    async health(timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
        return this.requestJson('GET', '/v1/health', undefined, timeoutMs);
    }
    /** `GET /v1/topics`，容忍裸数组或 `{items}` / `{topics}` 包装。 */
    async topics(timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
        const payload = await this.requestJson('GET', '/v1/topics', undefined, timeoutMs);
        return pickArray(payload, ['items', 'topics']);
    }
    /** `POST /v1/recall`。 */
    async recall(query, limit, timeoutMs = RECALL_TIMEOUT_MS) {
        const payload = await this.requestJson('POST', '/v1/recall', { query, limit }, timeoutMs);
        return { items: pickArray(payload, ['items', 'results']) };
    }
    /** `POST /v1/extract`。 */
    async extract(request, timeoutMs = CAPTURE_TIMEOUT_MS) {
        const payload = await this.requestJson('POST', '/v1/extract', request, timeoutMs);
        return {
            candidates: pickArray(payload, ['candidates']),
            results: pickArray(payload, ['results']),
        };
    }
    /** `GET /v1/pending`。 */
    async pending(timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
        const payload = await this.requestJson('GET', '/v1/pending', undefined, timeoutMs);
        return { items: pickArray(payload, ['items', 'pending']) };
    }
    /** `POST /v1/pending/{id}/approve`。 */
    async approve(changeId, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
        return this.requestJson('POST', `/v1/pending/${encodeURIComponent(changeId)}/approve`, {}, timeoutMs);
    }
    /** `POST /v1/pending/{id}/reject`。 */
    async reject(changeId, reason, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
        return this.requestJson('POST', `/v1/pending/${encodeURIComponent(changeId)}/reject`, { reason }, timeoutMs);
    }
    /** `POST /v1/pending/{id}/resolve`：调用方模型/插件裁决，无需人工。 */
    async resolve(changeId, decision, options = {}) {
        return this.requestJson('POST', `/v1/pending/${encodeURIComponent(changeId)}/resolve`, {
            decision,
            ...(options.statement !== undefined ? { statement: options.statement } : {}),
            ...(options.reason !== undefined ? { reason: options.reason } : {}),
        }, options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    }
    /**
     * 最小 MCP Streamable HTTP 客户端：`initialize` → `notifications/initialized` → `tools/call`。
     * 仅用于 REST 面没有对应端点的写操作（save / forget）。
     * @param tool - `memory_*` 工具名。
     * @param args - 工具参数。
     * @returns 解析后的工具结果；文本内容能当 JSON 解析时就返回该 JSON。
     */
    async callTool(tool, args, timeoutMs = MCP_TIMEOUT_MS) {
        if (this.base.length === 0) {
            throw new GatewayError('Smriti 网关地址未配置：请在插件 config 里设置 gatewayUrl');
        }
        const auth = await this.authHeaders();
        const headers = {
            ...auth,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
        };
        const endpoint = `${this.base}/mcp`;
        const signal = AbortSignal.timeout(Math.max(1, timeoutMs));
        let sessionId;
        const post = async (payload) => {
            try {
                return await fetch(endpoint, {
                    method: 'POST',
                    headers: sessionId === undefined ? headers : { ...headers, 'mcp-session-id': sessionId },
                    body: JSON.stringify(payload),
                    signal,
                });
            }
            catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                throw new GatewayError(`Smriti MCP 请求失败：${reason}`, undefined, { cause: error });
            }
        };
        const initResponse = await post({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: '2025-06-18',
                capabilities: {},
                clientInfo: { name: 'smriti-dsh', version: '0.1.0' },
            },
        });
        sessionId = initResponse.headers.get('mcp-session-id') ?? undefined;
        const initBody = await initResponse.text().catch(() => '');
        if (!initResponse.ok) {
            throw new GatewayError(`Smriti MCP initialize 返回 ${initResponse.status}${initBody.length > 0 ? `：${initBody.slice(0, 200)}` : ''}`, initResponse.status);
        }
        const initPayload = parseRpcPayload(initBody, initResponse.headers.get('content-type') ?? '', 1);
        if (initPayload !== undefined && typeof initPayload.error === 'object' && initPayload.error !== null) {
            throw new GatewayError(`Smriti MCP initialize 被拒绝：${JSON.stringify(initPayload.error).slice(0, 200)}`);
        }
        const notified = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
        await notified.text().catch(() => '');
        const callResponse = await post({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: tool, arguments: args },
        });
        const callBody = await callResponse.text().catch(() => '');
        if (!callResponse.ok) {
            throw new GatewayError(`Smriti MCP ${tool} 返回 ${callResponse.status}${callBody.length > 0 ? `：${callBody.slice(0, 200)}` : ''}`, callResponse.status);
        }
        const payload = parseRpcPayload(callBody, callResponse.headers.get('content-type') ?? '', 2);
        if (payload === undefined) {
            throw new GatewayError(`Smriti MCP ${tool} 响应无法解析`);
        }
        if (typeof payload.error === 'object' && payload.error !== null) {
            throw new GatewayError(`Smriti MCP ${tool} 失败：${JSON.stringify(payload.error).slice(0, 300)}`);
        }
        const result = payload.result;
        const content = typeof result === 'object' && result !== null
            ? result.content
            : undefined;
        if (Array.isArray(content)) {
            const texts = content.filter(isTextContent).map((block) => block.text);
            const joined = texts.join('\n').trim();
            if (joined.length > 0) {
                try {
                    return JSON.parse(joined);
                }
                catch {
                    return joined;
                }
            }
        }
        return result;
    }
}
