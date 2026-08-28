# 1.0.0 重构实现状态

状态以当前 `codex/generalize-workflow-core` 分支和自动化门禁为准。`完成` 表示已有公开入口和测试；`部分完成` 不得在 README 中宣称为生产级能力。

| 能力 | 状态 | 当前证据 | 收口项 |
| --- | --- | --- | --- |
| 单公开包与 subpath exports | 完成 | 根 `package.json`、干净 build、tarball 独立安装和无 DSH 通用入口导入烟测 | 最终 npm 发布不在本轮执行 |
| 中立 Template/Binding/Node 协议 | 完成 | `src/core`、新 API Version、无旧 Parser/节点别名、离线 migrator | 无 |
| 编译、DAG、Condition、Foreach、Subworkflow | 完成 | Core compiler/engine/catalog 测试 | 无界 loop 明确不做 |
| 两级扩展与依赖门禁 | 完成 | Tool Gateway、自定义 Node Capability projection、`spec.requires` fail-closed 测试 | 无 Provider 层 |
| Async Runtime/Catalog/Store | 完成 | `WorkflowRuntime`、Memory/SQLite、published/inline execution plan；DSH/Canvas 复用同一 Runtime | 无 |
| Execution Plan 与版本锁 | 完成 | canonical template、dependency closure、Engine/NodeDefinition set hash | 无 digest 的自定义 Node 只能 non-replayable |
| Event Envelope、Checkpoint、分页 Journal | 完成 | Envelope v1、CAS 原子 commit、Store 原生分页、故障注入 | OTel projection 属于后续 Adapter |
| Live Event | 完成（协议） | run/node/invocation envelope、有界订阅缓冲、慢消费者丢弃旧 delta、取消 | 各 Host 的 token transport 按需实现 |
| Artifact/Capture Policy | 完成 | Memory/SQLite content-addressed store、digest 校验、Event hash/ref、缺失/脱敏/不一致拒绝 | 加密与 retention 由部署实现 |
| inspect/recorded/live Replay | 完成 | Recorded 创建新 run、验证外部输出 Artifact、跳过外部节点、重算确定性下游 | 大规模历史数据仍需 retention 策略 |
| 持久幂等 Launch | 完成 | Authority-scoped deterministic runId、跨 Runtime 并发测试、immutable launch conflict | 分布式部署仍需协调器 fencing |
| Trigger Envelope/Binding/Ingress | 完成 | server-derived dedupe、固定 revision/Authority、SQLite Ingress、launch gap recovery | 生产 HTTP server/消息平台不是 Core |
| Cron/Webhook/钉钉 reference adapter | 完成（reference） | 时区、HMAC、身份映射测试 | 不宣称覆盖所有平台协议/回调形态 |
| Worker claim/lease | 完成（reference） | Memory/SQLite coordinator、租约过期、heartbeat、Worker 通过统一 Runtime resume | 分布式 Store 仍需服务端 lease fencing；不宣称 exactly-once |
| Result Delivery | 完成（reference） | 稳定 invocationId、unknown attempt、幂等 retry 测试 | 生产 Channel 自行实现加密 Store 与告警 |
| CLI | 完成 | validate/draft/publish/run/trace/replay/resume/migrate、SQLite 跨进程测试、显式 Host module | 交互式体验不属于 Core |
| MCP 控制面 | 完成 | discovery/draft/publish/run/trace/replay/resume，同 Runtime 测试 | 将发布流程投影为独立 MCP Tool 可后续增加 |
| DSH Adapter 与 Canvas | 完成 | DSH `dagWorkflowEngine` 内部使用统一 Runtime；published target 固定 revision；Canvas 使用 metadata/checkpoint/event page API | UI 产品体验继续独立迭代 |
| Migration | 完成 | Store schema v1-v8 fixture、重复重开、旧 Template 离线转换 | in-flight checkpoint 不自动迁移 |
| 复杂纵向 Case | 完成 | 同一 21 节点 AI 模型周报经 SDK/MCP/CLI/DSH 执行；比较输出与 Journal 契约 | 真实联网结果不作为确定性 CI fixture |
| 文档一致性 | 完成 | README、Architecture、重构方案、体验与子入口 README 描述同一 1.0.0 事实模型 | 发布后按版本维护 |

## 当前硬门禁

合并到 `master` 前必须全部满足：

1. `pnpm check` 全绿；
2. 干净 build 后 Core 产物不含 DSH/Cordis 标识；
3. tarball 在未安装 DSH peer 的目录中可导入根入口、Runtime、SQLite、MCP 和 Trigger；
4. CLI 跨进程 trace/recorded replay 通过；
5. DSH 本机复杂 Workflow 与 Canvas 回归通过；
6. 同一复杂模板的 Host conformance 与真实 DSH 回归收口；
7. 最终代码审查无 P0/P1 问题后再合并；不在本分支中途发布 npm 或 DSH Market。
