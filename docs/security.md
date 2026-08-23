# 安全与恢复边界

## Authority

- `dsh.tool@1`、`dsh.agent@1`、`dsh.human-approval@1` 永远通过 DSH 的 Tool、subagent 和 approval service，模板发布不授予新权限。
- Canvas Host 插件默认只从 Host 实时 Agent registry 接受仍附着的顶层 Agent，并拒绝缺失、脱离和 subagent identity；这个零配置边界只适合本地单用户 profile。
- 浏览器的 `sessionId` 只是查找键，不是身份凭证。多人或多租户部署必须提供 `authorize`，并从 Host 自己的连接、用户、workspace 和 Session membership 状态做判断，不能因为 id 存在就允许；每个 RPC 都会携带 `agent/action/resourceId` 重新授权。
- 当前 Catalog 是部署级 repository。多租户部署必须按租户隔离 provider/database，或在 authority 层实现同等强度的 resource ownership；不要共享一个无 ownership policy 的全局 catalog。

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

## Resource limits

- 模板策略限制并发节点、节点运行数、总时长、输出字节、foreach item/concurrency 与 subworkflow depth。
- 普通图必须是 DAG；无 `eval`，condition 只使用固定 operator。
- 所有输入、模板、进度与输出先 materialize 为 lossless JSON；prototype、function、symbol、循环引用与非有限数值被拒绝。
