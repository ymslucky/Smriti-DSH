/**
 * 本地结构化类型。
 *
 * 本包不 import 任何 `@deepseek-ai/*` 包：Host 在运行时把真实对象注入 `ctx`，
 * 这里只声明本插件实际用到的最小结构面。契约依据当前安装的 dsh
 * 0.2.2-rc.5（`agent/pre-step`、`agent/turn-stopping`、`mcpManager`、
 * `commands`、`credentials` 的真实签名）。
 */

/** ISO 时间字符串。 */
export type IsoDate = string

/** 插件配置（`cordis.patch.yml` 里 `config` 段）。 */
export interface PluginConfig {
  /** 网关基址，例如 `https://smriti.example.com`；末尾斜杠会被去掉。 */
  gatewayUrl: string
  /** MCP 服务器名，同时作为工具命名空间，默认 `smriti`。 */
  mcpServerName: string
  /** 是否在每步模型调用前自动召回记忆。 */
  autoRecall: boolean
  /** 是否在回合结束时自动捕获偏好候选。 */
  autoCapture: boolean
  /** 单次召回最多返回条数。 */
  recallMaxResults: number
  /** 注入 `<memory_context>` 的 token 预算（按 4 字符/token 粗算）。 */
  recallMaxTokens: number
  /** 每日自动捕获次数上限（按本地日期重置，进程内存计数）。 */
  captureDailyLimit: number
  /** 自动捕获写入 / `/memory save` 时的最低置信度。 */
  captureMinConfidence: number
  /** 召回请求的超时（毫秒）；本机到网关的 AI Search 首字节约 5s，默认 8s。 */
  recallTimeoutMs: number
  /** 自动捕获请求的超时（毫秒）；后台任务，默认 10s。 */
  captureTimeoutMs: number
  /** Access service token 的 client id；配置后优先于 credentials/env。 */
  accessClientId?: string
  /** Access service token 的 client secret；与 client id 成对出现。 */
  accessClientSecret?: string
  /** 是否用 mcpManager 再注册一份 memory_* 工具；已有同名 MCP 服务器时设为 false。 */
  exposeMcp?: boolean
}

/* ------------------------------------------------------------------ *
 * 网关 DTO（只声明插件读取的字段，其余字段一律忽略）
 * ------------------------------------------------------------------ */

/** `POST /v1/recall` 的条目。 */
export interface RecallItem {
  id: string
  topic: string
  statement: string
}

/** `POST /v1/recall` 的响应体。 */
export interface RecallResponse {
  items: RecallItem[]
}

/** 已生效记忆的摘要。 */
export interface MemorySummary {
  id: string
  topic?: string
  statement: string
  version?: number
}

/** 待裁决变更里的“建议”部分。 */
export interface PendingProposal {
  statement: string
  rationale?: string
  confidence?: number
}

/** `GET /v1/pending` 的条目（对齐 Smriti `PendingChange`，字段可选以容忍演进）。 */
export interface PendingChange {
  changeId: string
  kind: string
  topic: string
  current: MemorySummary | null
  proposed: PendingProposal
  createdAt?: IsoDate
}

/** `GET /v1/pending` 的响应体。 */
export interface PendingResponse {
  items: PendingChange[]
}

/** `GET /v1/topics` 的条目。 */
export interface TopicSummary {
  topic: string
  label?: string
  description?: string
  count?: number
}

/** `POST /v1/extract` 的一条消息。 */
export interface ExtractMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

/** `POST /v1/extract` 的请求体。 */
export interface ExtractRequest {
  sessionId: string
  messages: ExtractMessage[]
}

/** `POST /v1/extract` 的候选。 */
export interface ExtractCandidate {
  topic: string
  statement: string
  rationale?: string
  confidence: number
}

/** `POST /v1/extract` 的结果条目（UpsertResult 的结构化子集）。 */
export interface ExtractResult {
  status?: string
  message?: string
  memory?: MemorySummary
  change?: {
    changeId?: string
    kind?: string
  }
}

/** `POST /v1/extract` 的响应体。 */
export interface ExtractResponse {
  candidates?: ExtractCandidate[]
  results?: ExtractResult[]
}

/** 写入类操作的通用结果（approve / reject / MCP 工具）。 */
export interface WriteResult {
  status?: string
  applied?: boolean
  message?: string
  memory?: MemorySummary
  change?: {
    changeId?: string
    kind?: string
  }
}

/* ------------------------------------------------------------------ *
 * 单条 MCP 内容块（`tools/call` 的返回被尽力解析成 JSON）
 * ------------------------------------------------------------------ */

/** MCP `tools/call` 结果里的文本内容块。 */
export interface McpTextContent {
  type: string
  text?: string
}

/* ------------------------------------------------------------------ *
 * Host 注入的服务与事件（结构化最小面）
 * ------------------------------------------------------------------ */

/** 纯文本内容块。 */
export interface TextBlockLike {
  type: 'text'
  text: string
}

/** 任意内容块（插件只读取 `type === 'text'` 的块）。 */
export type ContentBlockLike = TextBlockLike | { type: string; [key: string]: unknown }

/** 消息来源；`kind` 是开放字符串。 */
export interface MessageSourceLike {
  kind: string
  [key: string]: unknown
}

/** 注入用 user 消息（Host 侧 `UserMessage` 的结构子集）。 */
export interface UserMessageLike {
  id?: string
  role: 'user'
  content: ContentBlockLike[]
  source?: MessageSourceLike
}

/** Agent 的最小标识（`id` 就是 SessionId）。 */
export interface AgentLike {
  id: string
}

/** `agent/pre-step` 的 payload。 */
export interface PreStepPayloadLike {
  agent: AgentLike
  messages: UserMessageLike[]
  turn: number
  step: number
  signal: AbortSignal
}

/** `agent/pre-step` 的瀑布决策。 */
export type PreStepDecisionLike =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: UserMessageLike[]; startsRequestSeries?: true }

/** `agent/pre-step` 监听器。 */
export type PreStepListener = (
  payload: PreStepPayloadLike,
  next: () => Promise<PreStepDecisionLike>,
) => Promise<PreStepDecisionLike>

/** `agent/turn-stopping` 的 payload。 */
export interface TurnStoppingPayloadLike {
  agent: AgentLike
  turn: number
  signal: AbortSignal
}

/** `agent/turn-stopping` 监听器（serial 模式：返回 Promise 会被 await）。 */
export type TurnStoppingListener = (payload: TurnStoppingPayloadLike) => Promise<void> | void

/** Host logger。 */
export interface LoggerLike {
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/** Cordis 的 effect disposer。 */
export type Disposer = () => void

/** 插件用到的 `ctx` 结构面。 */
export interface CordisContextLike {
  on(event: 'agent/pre-step', listener: PreStepListener, options?: { prepend?: boolean }): Disposer
  on(event: 'agent/turn-stopping', listener: TurnStoppingListener, options?: { prepend?: boolean }): Disposer
  get(name: string): unknown
  /** Cordis effect：注册清理函数，插件卸载时执行。 */
  effect?(dispose: () => void): Disposer
  readonly logger: LoggerLike
}

/** `ctx.get('systemPrompt')` 的最小结构面。 */
export interface SystemPromptLike {
  context(context: {
    name: string
    order: number
    text: string | ((context?: { agent?: { id?: string } }) => string)
    interpolate?: boolean
    required?: boolean
  }): Disposer
}

/** `credentials.resolve` 的返回。 */
export interface ResolvedCredentialLike {
  value: string
  source?: string
}

/** `ctx.get('credentials')`。 */
export interface CredentialsLike {
  resolve(ref: string): Promise<ResolvedCredentialLike | undefined>
}

/** `mcpManager.register` 的 entry（streamable-http 形态）。 */
export interface McpServerEntryLike {
  transport: 'streamable-http'
  url: string
  headers: Record<string, string>
  toolCallTimeoutMs?: number
}

/** `ctx.get('mcpManager')`。 */
export interface McpManagerLike {
  register(name: string, entry: McpServerEntryLike): Disposer
}

/** 命令调用现场。 */
export interface CommandInvocationLike {
  agent: AgentLike
  rawInput: string
  signal?: AbortSignal
}

/** 命令返回值。 */
export type CommandResultLike =
  | { kind: 'success'; text?: string }
  | { kind: 'error'; text: string }

/** 命令定义。 */
export interface CommandDefinitionLike {
  name: string
  description: string
  input?: {
    hint: string
    attachments?: boolean
  }
  recordInput?: boolean
  handler: (invocation: CommandInvocationLike) => CommandResultLike | Promise<CommandResultLike>
}

/** `ctx.get('commands')`。 */
export interface CommandsLike {
  register(definition: CommandDefinitionLike): Disposer
}

/* ------------------------------------------------------------------ *
 * 用户提问（冲突决策弹窗）
 * ------------------------------------------------------------------ */

export interface AskUserQuestionOption {
  label: string
  description?: string
}

export interface AskUserQuestionItem {
  id: string
  question: string
  detail?: string
  header?: string
  options?: AskUserQuestionOption[]
  multiSelect?: boolean
}

export interface AskUserQuestionAnswer {
  answers: Array<{ id: string; selected: string[]; custom?: string }>
}

export interface UserQuestionsLike {
  ask(request: {
    agent: AgentLike
    questions: AskUserQuestionItem[]
    signal?: AbortSignal
  }): Promise<AskUserQuestionAnswer>
}
