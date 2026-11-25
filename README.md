# Smriti-DSH

把 [Smriti](https://github.com/) Worker 网关的精炼记忆接进 DeepSeek Harness（dsh）：
**自动召回**上下文、**自动捕获**偏好候选、暴露 `memory_*` MCP 工具，并带一个 `/memory` 人工命令。

这是一个 **Host + Client 双面 bundle**：Host 负责召回/捕获/命令/MCP，Client 负责会话标题旁的「记忆」按钮与上下文浮层。Host 运行时只依赖 `tsc` + `@types/node`，不 import 任何 `@deepseek-ai/*` 包；Client 半是零构建的 `client.js`（`window.__ModuleLoader__.load` 工厂）。

## 功能

| 能力 | 触发点 | 行为 |
|---|---|---|
| 自动召回 | `agent/pre-step`（waterfall）+ `systemPrompt.context` | 取本步进批最后一条 user 文本查 `POST /v1/recall`，把 `<memory_context count="N">` 交给插件注册的 `smriti-memory` 上下文；Host 每步生成 runtime-context 快照，Chat 里默认折叠的「上下文」行（点开才展开），不是聊天气泡。同 `turn+step` 只查询一次，预算按 `recallMaxTokens × 4` 字符裁剪 |
| 自动捕获 | `agent/turn-stopping`（serial） | 命中偏好句式才 `POST /v1/extract`；**不 await**，内部超时（默认 10s），每日上限计数。若捕获产生冲突/疑似重复，立即用 `userQuestions.ask` 弹出决策卡片（替换/保留/合并，合并需输入新陈述），答案通过 `/v1/pending/{id}/resolve` 生效 |
| MCP 工具 | 插件激活时 | 用 `ctx.get('mcpManager').register('smriti', {transport:'streamable-http', url:'{base}/mcp', headers})` 注册，工具随插件加载/卸载自动挂载与撤销 |
| `/memory` 命令 | `ctx.get('commands').register` | `review` / `approve` / `reject` / `context` / `search` / `save` / `forget` / `topics` |
| 记忆面板 | Client `conversation.session.header.actions` | 标题旁「记忆」按钮打开浮层，读取 `GET /plugins/smriti/context?session=…`，展示当前会话最近一次注入的上下文；Host 只暴露这段文本 |

召回内容示例（Host 生成的 runtime-context 快照）：

```text
<memory_context count="2">
- [tooling.package-manager] 统一用 pnpm，不要用 npm
- [workflow.git] commit message 用中文，一次提交只做一件事
</memory_context>
```

## 安装

先构建（`lib/` 已提交，改源码后重新生成）：

```sh
node <pnpm.mjs> install
node <pnpm.mjs> run build      # tsc → lib/
```

再以本地路径装进某个 profile（会读取 `package.json` 的 `dsh.bundle.patch`）：

```sh
npx -p @deepseek-ai/dsh dsh plugin --profile <profile> add <本仓库绝对路径>
```

或直接在 profile 的 `cordis.patch.yml` 里插入本插件行（行 id `smriti-dsh` 已由仓库自带的
`cordis.patch.yml` 定义），然后重启该 profile。本仓库**未**自带 `prepare` 脚本，
从 Git 安装时需要先自行构建 `lib/`，或改用路径安装。

## 记忆面板（Client 半）

- 面板用原生 `<dialog>.showModal()` 的 top layer，避免标题栏 `overflow` 裁剪；不依赖 `react-dom` portal。
- 首次安装或更新 `client.js` 后需要**刷新一次 Web GUI**：客户端模块图在页面加载时注入，热更新只在 `pnpm run dev:web` 同时运行时生效。
- 按钮位于会话标题右侧（`conversation.session.header.actions`），点击后请求
  `GET /plugins/smriti/context?session=<sessionId>`，显示当前会话最近一次召回全文。
- Host 路由只返回 `{ session, context }`，不返回凭据；`context` 为空时面板显示“当前会话还没有召回记忆”。
- 标题栏浮层被裁剪时用原生 `<dialog>` 的 top layer，不依赖 `react-dom`。

## 配置

`cordis.patch.yml` → `config`（缺项自动补默认值）：

| 键 | 默认值 | 说明 |
|---|---|---|
| `gatewayUrl` | `https://smriti.example.com` | 网关基址，末尾斜杠自动去掉；**部署时必须覆盖** |
| `mcpServerName` | `smriti` | MCP 服务器名，也是工具命名空间 |
| `autoRecall` | `true` | 是否自动召回并注入 |
| `autoCapture` | `true` | 是否在回合结束时自动捕获 |
| `recallMaxResults` | `6` | 单次召回条数（1–50） |
| `recallMaxTokens` | `600` | 注入预算（×4 字符），0 表示关闭注入 |
| `captureDailyLimit` | `20` | 每日自动捕获次数上限（按本地日期，进程内计数） |
| `captureMinConfidence` | `0.7` | 最低置信度：用于捕获结果过滤与 `/memory save` 的默认置信度 |
| `recallTimeoutMs` | `8000` | 召回超时；本机到网关的 AI Search 首字节实测约 5s |
| `captureTimeoutMs` | `10000` | 自动捕获超时（后台请求） |
| `accessClientId` | 空 | Access service token 的 client id；配置后优先于 credentials/env |
| `accessClientSecret` | 空 | Access service token 的 client secret |
| `exposeMcp` | `true` | 是否再注册一份 `memory_*` MCP；已有同名 MCP 服务器时设为 `false` |

`gatewayUrl` 显式留空会让插件告警并停用，不会静默打到占位域名。

## 凭据

所有网关请求都带 Cloudflare Access service token 头：

- `CF-Access-Client-Id` ← `CF_ACCESS_CLIENT_ID`
- `CF-Access-Client-Secret` ← `CF_ACCESS_CLIENT_SECRET`

解析顺序：`ctx.get('credentials').resolve(名字)` → 插件配置的 `accessClientId` / `accessClientSecret` → `process.env[名字]`。
凭据在**每次请求前重新解析**，所以在 dsh 里更新凭据后无需重启（MCP 侧见 `docs/DETAIL.md`
的模板回退说明）。单用户自用时可以把两项写进 profile 覆盖的插件 config。

## `/memory` 命令

| 子命令 | 作用 |
|---|---|
| `review` | 列出待裁决变更（现状 / 建议 / changeId） |
| `approve <id>` | 批准一条待裁决变更 |
| `reject <id> [reason]` | 拒绝一条待裁决变更（默认理由 `user rejected`） |
| `resolve <id> replace\|keep\|merge [text]` | 直接裁决；`merge` 必须给出合并后的陈述 |
| `context` | 查看当前会话最近一次注入的记忆上下文（注入行默认折叠时用它手动拉出） |
| `search <query>` | 检索记忆（走 `/v1/recall`） |
| `save <topic> <text>` | 显式保存一条偏好（走 MCP `memory_upsert`） |
| `forget <topic> <id> [reason]` | 遗忘一条偏好（走 MCP `memory_forget`） |
| `topics` | 列出主题与条数 |

## 开发

```sh
node <pnpm.mjs> run build       # tsc -p tsconfig.json → lib/
node <pnpm.mjs> run typecheck
node --check lib/index.js       # 入口语法检查
```

- `src/types.ts` 本地结构化类型（不 import `@deepseek-ai/*`）
- `src/config.ts` 默认值与归一化
- `src/gateway.ts` fetch + 鉴权 + 超时 + 最小 MCP JSON-RPC（save/forget）
- `src/mcp.ts` `mcpManager` 注册（重复 apply 去重）
- `src/recall.ts` 召回、上下文格式化与 `systemPrompt.context` 供给
- `src/capture.ts` 偏好句式启发式、每日额度、异步捕获
- `src/commands.ts` `/memory` 命令
- `src/index.ts` 组装：`export const name` / `export function apply`

网关契约、注入细节、偏差与已知假设见 [`docs/DETAIL.md`](docs/DETAIL.md)。
