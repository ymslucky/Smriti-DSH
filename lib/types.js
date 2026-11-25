/**
 * 本地结构化类型。
 *
 * 本包不 import 任何 `@deepseek-ai/*` 包：Host 在运行时把真实对象注入 `ctx`，
 * 这里只声明本插件实际用到的最小结构面。契约依据当前安装的 dsh
 * 0.2.2-rc.5（`agent/pre-step`、`agent/turn-stopping`、`mcpManager`、
 * `commands`、`credentials` 的真实签名）。
 */
export {};
