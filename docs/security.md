# 安全、审计与恢复边界

## Authority 与依赖

- `WorkflowLaunchRequest.authorityRef` 是可持久化引用，`authority` 是 Host 解析出的瞬时权限对象。Core 不把 Session、Token 或凭据对象写入 Run。
- `spec.requires` 是模板级 allowlist，不是 grant。实际能力是模板声明、NodeDefinition 声明、Authority 和 Host policy 的交集。
- Engine 只向节点投影其 NodeDefinition `capabilities` 声明的 Gateway。自定义节点访问未声明或未安装的 Capability 会 fail closed。
- 外部业务调用只有两级：普通能力走 `WorkflowToolGateway`；只有暂停恢复、长进度或特殊端口等生命周期语义才注册自定义 Node。Capability Resolver 不能成为绕过 Tool policy 的第二条业务调用总线。
- 第三方 NodeDefinition 和 Script Runtime 是部署者安装的受信任代码，可能通过闭包持有 ambient authority。模板 allowlist 不能替代代码审计或进程隔离。
- DSH Canvas 的 `sessionId` 只是查找键，不是多租户凭证。多人部署必须实现 `authorize`，并按用户、workspace、Session membership、action 和 resource 逐次授权。

## Secret 与外部数据

- Binding 不支持通用 Secret。模板只能保存 `credentialRef`、`connectionRef` 等不透明静态引用，由 Host Gateway 在调用最后一刻解析。
- Secret 明文不得进入 Workflow Input、节点 Output、Event、Checkpoint、Artifact 或 Live Event。Core 无法识别 Secret 的 hash、编码或切片等派生泄漏，Gateway 仍必须负责输出脱敏。
- Template、Trigger payload、Tool 结果和 Agent 结果都按不可信 JSON 处理。它们必须经过大小限制、lossless JSON materialization 和 Schema 校验。
- Agent 语义复核是显式业务节点，不授予权限，也不能替代结构 Schema、依赖门禁或 prompt-injection 隔离。

## Journal、Artifact 与 Replay

- Event 与对应 Checkpoint 在 Store 中按 `expectedSeq` CAS 原子提交；Event Envelope 包含 run、node、invocation、workflow hash、origin 和 correlation。
- Capture Policy 由部署配置，模板不能放宽。`replayable` 模式用内容寻址 Artifact 保存允许捕获的外部结果；缺失、脱敏、digest/内容不一致时 Recorded Replay 必须拒绝。
- `inspect` 不执行；`recorded` 跳过外部节点并重算确定性下游；`live` 重新调用当前发布计划的外部能力。三者不能混称为 Replay。
- `retry: never` 的运行中外部节点在崩溃后进入 `needs_attention`，操作者必须显式选择 retry/fail。
- 稳定 invocationId、Ingress 幂等键和 Journal CAS 降低重复执行，但不构成外部副作用 exactly-once。Gateway 应实现业务幂等并处理 unknown state。

## Trigger 与 Worker

- 外部 Trigger 不能指定最终 Authority、Workflow revision 或幂等键。Adapter 先验签并生成可信 Envelope，Ingress 根据来源和消息 id 派生去重键，Binding 再固定映射到发布修订与 Authority。
- Run launch 与 Ingress 状态之间的崩溃间隙由确定性 idempotency key + `recoverPending` 收敛，不通过猜测执行结果处理。
- Reference Worker 使用 claim/lease/heartbeat；Runtime 仍以 Journal CAS 防止并发提交。生产分布式 Store 必须增加服务端 fencing token，不能把单进程 Coordinator 当作分布式锁。
- Result Delivery 使用稳定 invocationId，并区分成功、失败和 unknown attempt；重试不能生成新的业务身份。

## 资源限制

- 模板策略限制并发节点、节点运行数、总时长、输出字节、foreach item/concurrency 与 subworkflow depth。
- 普通图必须是 DAG；无无界 `while`。Condition 只使用固定 operator。
- `core.script@1` 的内置 `json.expr@1` 只做纯 JSON 变换，限制 source 大小和 evaluator operation 数，观察 AbortSignal，并拒绝 I/O、环境变量、时间、随机数、prototype key、动态函数和 `eval`。
- 所有输入、模板、进度与输出先物化为 lossless JSON；function、symbol、循环引用与非有限数值会被拒绝。
