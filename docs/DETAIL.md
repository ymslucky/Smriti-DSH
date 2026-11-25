# Smriti-DSH 实现细节

本文记录插件与 **dsh Host 0.2.2-rc.5**、**Smriti 网关契约**的对齐方式，
以及契约没写死时插件做的选择（含与网关契约的偏差）。

## 1. 运行面与入口

- 形态：Host 函数插件，`export const name = 'smriti-dsh'` + `export function apply(ctx, config)`。
- **不导出 `Config`**：dsh 的 Config 面要求 schemastery（`@deepseek-ai/schemastery`），
  而本仓库只允许 `tsc` + `@types/node` 且禁止 import `@deepseek-ai/*`，
  因此默认值/归一化放在 `src/config.ts`（`resolveConfig`），对外只读纯对象。
- 不声明 `inject`：用到的 4 个服务全部 `ctx.get(...)` 软获取，缺失时降级并告警，
  避免 Host 组合缺一个可选服务时整个 fiber 变 pending：
  - `mcpManager` 缺失 → 不注册 `memory_*` 工具，其余功能照常；
  - `commands` 缺失 → 不注册 `/memory`；
  - `credentials` 缺失 → 退回 `process.env`；
  - 事件始终可用。
- 不用 `ctx.effect`：`ctx.on(...)` 的监听器和 `mcpManager.register(...)` 的 disposer
  都归当前 fiber 所有，Host 卸载插件时会自动撤销。

## 2. 事件接线（已按本机安装版本核对）

### 2.1 `agent/pre-step`（waterfall）

真实签名：

```ts
'agent/pre-step'(payload: { agent; messages: UserMessage[]; turn: number; step: number;
  signal: AbortSignal; modelSelection: Readonly<ModelSelection> },
  next: () => Promise<PreStepDecision>): Promise<PreStepDecision>
type PreStepDecision = { kind: 'reject' } | { kind: 'enter'; messages: UserMessage[]; startsRequestSeries?: true }
```

实现顺序（`src/recall.ts`）：

1. `const decision = await next()` —— 先让下游（含 runtime-context、agent-instructions）定稿；
2. `decision.kind === 'reject'` 原样返回；
3. 记录本步进批的最后一条 user 文本（`source.kind === 'user'` 优先），供自动捕获复用；
4. 未启用召回 / `signal.aborted` / 没有文本 / `decision.messages.length === 0` 时直接返回；
5. `turn+step` 去重，同会话命中相同 query 时复用上次 `/v1/recall` 结果；
6. 返回 `{ kind: 'enter', messages: [memoryMessage, ...decision.messages] }`。

选择 `scripts`/`turn+step` 细节的说明：

- **空进批不注入**：工具续步（`step > 1`）的进批通常为空，此时注入会把一个纯续步变成
  “只有记忆”的独立请求，语义错误；`decision.messages.length === 0` 时跳过。
  因此实际效果是“每个 turn 的第一次进批注入一次”。
- **不丢 `startsRequestSeries`**：这里构造新的 `enter` 决策，只改 `messages`，
  不额外设置 `startsRequestSeries`（下游语义由原决策决定，注入不改变请求序列边界）。
- **消息形态**（与 Host `createUserMessage` 等价，手工构造，不 import）：

  ```ts
  { id: crypto.randomUUID(), role: 'user',
    content: [{ type: 'text', text: '<memory_context …>' }],
    source: { kind: 'user' } }
  ```

  消息、内容数组、文本块与 `source` 都被 `Object.freeze`，避免下游对共享对象原地修改。
  该消息由 agent loop 以 `session.append('user/message', …)` 落盘，`source.kind: 'user'`
  是 `MessageSourceMap` 里的基础来源，允许被注入。

### 2.2 `agent/turn-stopping`（serial）

真实签名：`(payload: { agent; turn; signal }): Promise<void> | void`，**返回的 Promise 会被 await**。
所以 `src/capture.ts` 的监听器是同步函数：

1. 同步完成所有判定（`autoCapture`、`signal.aborted`、本回合文本、偏好句式、每日额度、去重）；
2. `void (async () => { await client.extract(...) })()` —— 网络等待不进入回合；
3. 内部用 `AbortSignal.timeout(CAPTURE_TIMEOUT_MS = 3000)`，失败只 `logger.warn`。

## 3. MCP 注册

```ts
ctx.get('mcpManager').register(config.mcpServerName, {
  transport: 'streamable-http',
  url: `${config.gatewayUrl}/mcp`,
  headers: { 'CF-Access-Client-Id': …, 'CF-Access-Client-Secret': … },
  toolCallTimeoutMs: 15000,
})
```

- **去重**：模块级 `WeakMap<manager, Set<serverName>>`；HMR 重复 `apply` 不会重复注册。
- **凭据策略**：先用 `credentials` 服务解析，再退回插件配置的 `accessClientId` /
  `accessClientSecret`，最后 `process.env`；两项都解析到时**内联字面量**
  （这种注册不落盘，只是进程内 entry）；解析不到时退回 mcp-client 的
  `${credential:REF}` 模板，由 Host 的 credentials 提供方在连接时解析，
  这样“先注册、后配置凭据”也能自动恢复，并支持轮换。注意模板模式要求 Host
  挂载了 `credentials` 提供方（mcp-client 的硬要求），否则该服务器会以
  `failed/load` 状态出现——这是有诊断信息的失败，不会连带影响网关 REST 功能。
- **exposeMcp**：默认 `true`；profile 里已有同名 MCP 服务器（如 `@local/smriti-mcp`）时
  设为 `false`，避免重复注册同名服务器，`memory_*` 工具仍由已有服务器提供。
- **失败语义**：`register` 抛错（同名服务器已被配置、entry 非法、manager 已销毁）
  只 `logger.warn`，不影响其余功能。

## 4. 网关契约对齐与偏差

### 4.1 已实现且与契约一致

| 调用 | 路径 | 请求 | 读取 |
|---|---|---|---|
| 健康 | `GET {base}/v1/health` | — | 仅要求 2xx |
| 主题 | `GET {base}/v1/topics` | — | 条目数组 |
| 召回 | `POST {base}/v1/recall` | `{query, limit}` | `{items:[{id,topic,statement}]}` |
| 提取 | `POST {base}/v1/extract` | `{sessionId, messages:[{role,content}]}` | `{candidates, results}` |
| 待裁决 | `GET {base}/v1/pending` | — | `{items:[PendingChange]}` |
| 批准 | `POST {base}/v1/pending/{id}/approve` | `{}` | `WriteResult` |
| 拒绝 | `POST {base}/v1/pending/{id}/reject` | `{reason}` | `WriteResult` |

所有请求都带 `CF-Access-Client-Id` / `CF-Access-Client-Secret`，并用
`AbortSignal.timeout(...)` 限时；非 2xx、非 JSON、缺凭据都抛 `GatewayError`
（带状态码与响应片段），由调用方决定是降级（召回/捕获）还是显示（命令）。

### 4.2 偏差与假设

1. **`/v1/topics`、`/v1/health`、approve/reject 的响应体没有在 `docs/plan.md` 固化。**
   客户端做容忍解析：`topics` 接受裸数组或 `{items}` / `{topics}` 包装；
   `health` 只要求 2xx；`approve`/`reject` 读取 `{status?, message?, memory?, change?}`，
   都没有时显示 `ok`。
2. **REST 面没有写入端点**（无 upsert / forget），但 `/memory save`、`/memory forget`
   需要写入。实现方式：`GatewayClient.callTool()` 提供一个**最小 MCP Streamable HTTP
   客户端**（`initialize` → `notifications/initialized` → `tools/call`，捕获
   `Mcp-Session-Id`，兼容 SSE 与 JSON 两种响应）。工具名与参数目前假定为：
   - `memory_upsert`：`{topic, statement, confidence, source:{session}}`
   - `memory_forget`：`{topic, id, reason}`

   这两个常量在 `src/gateway.ts`（`UPSERT_TOOL` / `FORGET_TOOL`）。**如果网关
   `POST /mcp` 的工具名或参数不同，需要改这两个常量与两处 `callTool` 实参**——
   这是本插件唯一一处“契约未定、按命名约定推定”的地方。
3. **`captureMinConfidence` 无法随请求下发**：`/v1/extract` 的 body 只有
   `{sessionId, messages}`，阈值由网关决定。插件把这个值用于：
   捕获日志里“高置信候选”的过滤展示，以及 `/memory save` 的默认 `confidence`。
   它**不会**阻止网关写入低置信候选。
4. **超时预算**：召回在 `pre-step` 关键路径上，默认 8s（实测本机到网关的 AI Search
   首字节约 5s，原 2s 会稳定超时）；自动捕获默认 10s（后台 fire-and-forget）；
   普通 REST 8s；MCP 工具调用 15s（与注册的 `toolCallTimeoutMs` 一致）。
   两项都可通过 `recallTimeoutMs` / `captureTimeoutMs` 调整。
5. **上下文供给**：不修改 `decision.messages`；插件注册
   `systemPrompt.context({ name: 'smriti-memory' })`，Host 在每步装配时生成
   runtime-context 快照（`source.kind: 'runtime-context'`、`form: 'snapshot'`、
   `sections: [{ name: 'smriti-memory', text }]`），Chat 渲染成默认折叠的
   上下文行（`ContextInjectionRow`），不是 user 气泡。注意：不要在 pre-step
   里自行返回 `source.kind: 'runtime-context'` 的 UserMessage——agent loop 会把它
   替换成 Host 自己投影的 context（见 `dsh-agent-loop/src/agent.ts` 的
   `decision.messages` 分支），内容会被丢弃。
6. **冲突决策弹窗**：自动捕获产生 `pending_review` 时，插件读取 `/v1/pending` 找到
   对应变更，用 `ctx.userQuestions.ask`（不传 `wait`，阻塞式问题卡片）让用户选择
   「替换 / 保留」（疑似重复为「写入 / 放弃」），随后调用
   `/v1/pending/{id}/resolve`。子会话（subagent）不允许人类交互，提问失败时保留
   pending，不阻塞对话。
7. **`/v1/recall` 的结果缓存**：按会话缓存“最近一次 query 的结果”；
   同 query 的下一步/重试直接复用，避免关键路径重复请求。
8. **每日上限是进程内计数**，按本地日期重置；重启 dsh 会清零。
   这是有意的轻量实现（单用户自用），不落盘。
9. **主题不复制词表**：`/memory save` 只校验“有 topic 与文本”，
   未知或非法主题由网关按 `UpsertResult.status === 'invalid_topic'` 拒绝并在命令里显示。

## 5. 自动捕获启发式

命中即认为可能是偏好陈述（`src/capture.ts` 的 `PREFERENCE_PATTERNS`）：

- 中文：`习惯`、`以后都`、`统一`、`不要再`
- 英文（忽略大小写）：`prefer`（含 prefers/preferred/preference）、`always`、`never`、`by default`

另外：文本短于 6 字符直接跳过；提交给网关的文本截断到 4000 字符；
同一条文本用 sha1 前 16 位去重（保留最近 256 条），避免重复捕获。

## 6. 文件清单

```
src/types.ts      本地结构化类型（配置、网关 DTO、Host 事件/服务结构面）
src/config.ts     默认值、归一化、字符预算换算
src/gateway.ts    GatewayClient：鉴权头、超时、REST 方法、最小 MCP tools/call
src/mcp.ts        mcpManager 注册与去重
src/recall.ts     pre-step 召回、<memory_context> 格式化、systemPrompt.context 供给
src/capture.ts    turn-stopping 启发式捕获、每日额度、冲突提问与 resolve
src/commands.ts   /memory 全部子命令
src/index.ts      name / apply 组装、systemPrompt.context 与只读路由
client.js         Client 半：标题栏「记忆」按钮 + 浮层（零构建）
```

## 7. Client 半与只读路由

- Client 模块以 `window.__ModuleLoader__.load({ id:'smriti-dsh', factory })` 注册，`package.json.dsh.client` 声明 `platform: 'web'`、`immediately: true`、`inject` 会话 UI 包；无需打包器。
- 按钮注册在 `conversation.session.header.actions`（session 作用域，标准 props 带 `sessionId`）；浮层用 `position: fixed`，有 `react-dom` 时用 `createPortal`，避免被标题栏 `overflow` 裁剪。
- 数据来自 Host 的只读 `GET /plugins/smriti/context?session=…`：返回 `{session, context}`，其中 `context` 是 `runtime.lastContext(sessionId)`，不返回 Access token 或其他凭据；路由 `cache-control: no-store`，只允许同源/无 Sec-Fetch-Site 的请求，非 owner peer 返回 403。
- 客户端模块图在页面加载时注入，所以首次安装或更新 `client.js` 后要刷新 Web GUI；`pnpm run dev:web` 同时运行时才走 HMR。


## 8. 验证记录

- `pnpm run build`（`tsc -p tsconfig.json`）→ 通过，生成 `lib/*.js`。
- `node --check lib/index.js` → 通过。
- 另用一次性 Node 脚本（放在系统临时目录，未进仓库）做了两轮动态验证：
  1. **假网关端到端**：本地 HTTP 假网关 + 假 `ctx`（`systemPrompt` / `userQuestions` / `commands`），
     断言 pre-step 不改消息、`systemPrompt.context` 的 provider 返回 `<memory_context>`、
     冲突时调用 `userQuestions.ask` 且答案“替换”映射到 `/v1/pending/{id}/resolve` 的
     `decision:'replace'`、`/memory context` 返回上下文。
  2. **真实 profile**：本机桌面 profile 安装并启用 `include:smriti-dsh`；真实
     `https://smriti.msxor.com` 召回成功，会话日志中出现
     `source.kind:'runtime-context'`、`sections:[{name:'smriti-memory', text:'<memory_context …>'}]`
     的快照；禁用插件后该段消失。
- `/plugins/smriti/context` 本机请求返回 200（无召回时 `context:null`）；
  `clientModules.clientPath('smriti-dsh')` 能解析到 `client.js`，但已有浏览器页面需要刷新一次。
