/**
 * 配置默认值与归一化。
 *
 * 不导出 `Config`（Host 的 Config schema 面），只用本地类型 + 独立默认值：
 * 运行时配置来自 `cordis.patch.yml` 的 `config` 段，缺项按这里补齐。
 */

import type { PluginConfig } from './types.js'

/** 网关基址默认值（占位；部署时必须覆盖）。 */
export const DEFAULT_GATEWAY_URL = 'https://smriti.example.com'

/** MCP 服务器名默认值，同时是工具命名空间（`smriti_*`）。 */
export const DEFAULT_MCP_SERVER_NAME = 'smriti'

/** 单次召回默认条数。 */
export const DEFAULT_RECALL_MAX_RESULTS = 6

/** 注入上下文默认 token 预算。 */
export const DEFAULT_RECALL_MAX_TOKENS = 600

/** 每日自动捕获默认上限。 */
export const DEFAULT_CAPTURE_DAILY_LIMIT = 20

/** 自动捕获默认最低置信度。 */
export const DEFAULT_CAPTURE_MIN_CONFIDENCE = 0.7

/** 召回/提取的粗算字符 token 比。 */
export const CHARS_PER_TOKEN = 4

/** 默认配置。 */
export const DEFAULT_CONFIG: PluginConfig = {
  gatewayUrl: DEFAULT_GATEWAY_URL,
  mcpServerName: DEFAULT_MCP_SERVER_NAME,
  autoRecall: true,
  autoCapture: true,
  recallMaxResults: DEFAULT_RECALL_MAX_RESULTS,
  recallMaxTokens: DEFAULT_RECALL_MAX_TOKENS,
  captureDailyLimit: DEFAULT_CAPTURE_DAILY_LIMIT,
  captureMinConfidence: DEFAULT_CAPTURE_MIN_CONFIDENCE,
  recallTimeoutMs: 8000,
  captureTimeoutMs: 10000,
  accessClientId: '',
  accessClientSecret: '',
  exposeMcp: true,
}

/** 召回注入允许的最大字符数（`recallMaxTokens × 4`）。 */
export function recallCharBudget(config: Pick<PluginConfig, 'recallMaxTokens'>): number {
  return Math.max(0, Math.trunc(config.recallMaxTokens)) * CHARS_PER_TOKEN
}

function asString(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : fallback
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase()
    if (lowered === 'true') return true
    if (lowered === 'false') return false
  }
  return fallback
}

function asInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(numeric)))
}

function asRatio(value: unknown, fallback: number): number {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(1, Math.max(0, numeric))
}

/** 去掉末尾斜杠，保留协议与路径前缀。 */
export function normalizeGatewayUrl(value: string): string {
  let url = value.trim()
  while (url.endsWith('/')) url = url.slice(0, -1)
  return url
}

/**
 * 把 Host 传入的原始 config 归一化成完整配置。
 * @param raw - `apply(ctx, config)` 收到的原始对象。
 * @returns 补齐默认值、裁剪到合理区间的配置。
 */
export function resolveConfig(raw: unknown): PluginConfig {
  const source = typeof raw === 'object' && raw !== null ? (raw as Partial<PluginConfig>) : {}
  // gatewayUrl 显式给空串时保留为空（插件会告警并停用），缺项才用默认值。
  const gatewayUrl = typeof source.gatewayUrl === 'string'
    ? normalizeGatewayUrl(source.gatewayUrl)
    : DEFAULT_CONFIG.gatewayUrl
  return {
    gatewayUrl,
    mcpServerName: asString(source.mcpServerName, DEFAULT_CONFIG.mcpServerName),
    autoRecall: asBoolean(source.autoRecall, DEFAULT_CONFIG.autoRecall),
    autoCapture: asBoolean(source.autoCapture, DEFAULT_CONFIG.autoCapture),
    recallMaxResults: asInteger(source.recallMaxResults, DEFAULT_CONFIG.recallMaxResults, 1, 50),
    recallMaxTokens: asInteger(source.recallMaxTokens, DEFAULT_CONFIG.recallMaxTokens, 0, 8000),
    captureDailyLimit: asInteger(source.captureDailyLimit, DEFAULT_CONFIG.captureDailyLimit, 0, 1000),
    captureMinConfidence: asRatio(source.captureMinConfidence, DEFAULT_CONFIG.captureMinConfidence),
    recallTimeoutMs: asInteger(source.recallTimeoutMs, DEFAULT_CONFIG.recallTimeoutMs, 200, 30000),
    captureTimeoutMs: asInteger(source.captureTimeoutMs, DEFAULT_CONFIG.captureTimeoutMs, 500, 30000),
    accessClientId: asString(source.accessClientId, ''),
    accessClientSecret: asString(source.accessClientSecret, ''),
    exposeMcp: asBoolean(source.exposeMcp, true),
  }
}
