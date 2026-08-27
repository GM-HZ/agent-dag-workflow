# 安全与恢复边界

## Authority

- `dsh.tool@1`、`dsh.agent@1`、`dsh.human-approval@1` 永远通过 DSH 的 Tool、subagent 和 approval service，模板发布不授予新权限。
- Canvas Host 插件默认只从 Host 实时 Agent registry 接受仍附着的顶层 Agent，并拒绝缺失、脱离和 subagent identity；这个零配置边界只适合本地单用户 profile。
- 浏览器的 `sessionId` 只是查找键，不是身份凭证。多人或多租户部署必须提供 `authorize`，并从 Host 自己的连接、用户、workspace 和 Session membership 状态做判断，不能因为 id 存在就允许；每个 RPC 都会携带 `agent/action/resourceId` 重新授权。
- 当前 Catalog 是部署级 repository。多租户部署必须按租户隔离 service/database，或在 authority 层实现同等强度的 resource ownership；不要共享一个无 ownership policy 的全局 catalog。
- `spec.requires` 是模板级 allowlist，不是 grant。编译器要求 NodeDefinition capability、固定 Tool/Agent/Runtime/subworkflow 和 secret 引用全部预声明；运行仍取 owning Agent scope 与 DSH policy 的交集。
- Engine 只向节点暴露其 NodeDefinition `capabilities` 覆盖的 gateway；自定义 `context.capabilities` 同时隐藏未声明绑定，并拒绝已声明但 Host 未安装的绑定。未声明 `dsh.tools.execute` 的普通节点无法取得 Tool gateway。
- 外部业务调用只有 DSH Tool 与自定义 Node 两级。`ctx.workflowCapabilities` 只允许自定义 Node 注入特殊生命周期服务，不能用作 HTTP/数据库/消息等普通业务调用的旁路，否则会绕开 Tool scope、guard 和审计。
- 第三方 NodeDefinition 是受信任 Host 插件，可以通过闭包持有 ambient authority；`requires` 无法替代插件代码审计或进程 sandbox。

## Secrets

- 模板、event 和 checkpoint 只保存 secret reference。
- DSH 插件仅在配置 `resolveSecret` 后启用 secret binding。回调取得 owning Agent、run/node id 与 AbortSignal，应再次执行 credential scope policy。
- Core 在节点调用完成后对输出执行 secret leak gate；包含已解析 secret 原值的输出以 `SECRET_OUTPUT_LEAK` 失败，错误不包含 secret。
- 节点/Tool 不应主动复制、编码或变换 credential 到输出。Core 无法可靠识别加密、hash、切片等派生泄露；Tool 插件仍负责自己的输出脱敏。

## Persistence and replay

- Store commit 使用 checkpoint seq CAS；事件与 checkpoint 在 SQLite 同一事务中提交。
- `retry: never` 的运行中节点在崩溃后进入 `needs_attention`，不会静默重放；operator 必须明确 `retry/fail`。
- child invocation id 和 foreach item index 稳定派生，重启后命中同一 child run。
- Run 只持久化可序列化 `ownerRef`，不持久化 Agent/Session object。自动恢复用 Host `recovery.resolve` 重新取得 Agent；无 owner、无 authority 和 paused run 不自动开始。
- 这套语义是 at-least-once + 显式不确定性，不声称 exactly-once。Tool 若支持业务幂等，应继续使用自己的 idempotency key。
- 节点输出必须先通过 NodeDefinition schema 与实例 `expects` 才能进入 checkpoint。Agent 语义 review 是业务节点，不能作为安全 Schema、权限或 prompt-injection 边界。
- 非确定 Agent 不应重写外部来源记录。推荐只返回以稳定 `id` 标识的评分/摘要 overlay，再由 `dsh.expr@1` 的 `joinBy` 做一一对应合并；缺失、未知、重复 id 或覆盖原字段会 fail closed，并完整进入 run trace。

## Resource limits

- 模板策略限制并发节点、节点运行数、总时长、输出字节、foreach item/concurrency 与 subworkflow depth。
- 普通图必须是 DAG；无 `eval`，condition 只使用固定 operator。
- `core.script@1` 内置 `dsh.expr@1` 只做纯 JSON 变换，限制 source 大小和 evaluator operation 数，观察 AbortSignal，并拒绝 prototype key 与动态函数调用。
- `ctx.workflowScripts` 中的第三方 runtime 与其他 Host 插件一样属于受信任代码。`deterministic: true` 是可调度/恢复契约，不是 sandbox 或权限证明；部署者必须审计 runtime，不能在其中暗藏 I/O、环境变量或 secret 访问。
- 所有输入、模板、进度与输出先 materialize 为 lossless JSON；prototype、function、symbol、循环引用与非有限数值被拒绝。
