# 1.0.0 重构实现状态

状态以当前 `main` 工作树和自动化门禁为准。`完成` 表示已有公开入口和测试；reference adapter 不等于对应平台的生产级连接器。

| 能力 | 状态 | 当前证据 | 收口项 |
| --- | --- | --- | --- |
| 单公开包与 subpath exports | 完成 | 根 `package.json`、干净 build、tarball 独立安装和无 DSH 通用入口导入烟测 | 最终 npm 发布不在本轮执行 |
| 中立 Template/Binding/Node 协议 | 完成 | `src/core`、新 API Version、无旧 Parser/节点别名、离线 migrator | 无 |
| 编译、DAG、Condition、Foreach、Subworkflow | 完成 | Core compiler/engine/catalog 测试 | 无界 loop 明确不做 |
| 两级扩展与依赖门禁 | 完成 | Tool Gateway、自定义 Node Capability projection、`spec.requires` fail-closed 测试 | 无 Provider 层 |
| Async Runtime/Catalog/Store | 完成 | `WorkflowRuntime`、Memory/SQLite、published/inline execution plan；DSH/Canvas 复用同一 Runtime | 无 |
| Execution Plan 与版本锁 | 完成 | canonical template、dependency closure、Engine/NodeDefinition set hash、实现摘要漂移拒绝测试 | 无 digest 的自定义 Node 只能 inline non-replayable，不能发布 |
| Event Envelope、Checkpoint、分页 Journal | 完成 | Envelope v1、CAS 原子 commit、16 MiB commit 上限、Store 原生分页、故障注入 | OTel projection 属于后续 Adapter |
| Live Event | 完成（协议） | checkpoint progress 同时投影 Live/Journal、有界缓冲、`liveSeq`、慢消费者丢弃旧 delta、取消/终态关闭 | 各 Host 的 token transport 按需实现 |
| Artifact/Capture Policy | 完成 | Memory/SQLite content-addressed store、digest 校验、Event hash/ref、缺失/脱敏/不一致拒绝；能力不支持时拒绝 encryption/retention 配置 | 加密和自动保留由具备显式 capability 的部署 Store 实现 |
| inspect/recorded/live Replay | 完成 | Recorded 创建新 run、验证外部输出 Artifact、跳过外部节点、重算确定性下游 | 大规模历史数据仍需 retention 策略 |
| 持久幂等 Launch | 完成 | Authority-scoped deterministic runId、跨 Runtime 并发测试、immutable launch conflict | 分布式部署仍需协调器 fencing |
| Trigger Envelope/Binding/Ingress | 完成 | server-derived dedupe、重复次数审计、固定 revision/Authority、SQLite Ingress、后台 queue、launch gap recovery | 生产 HTTP server/消息平台不是 Core |
| Cron/Webhook/钉钉 reference adapter | 完成（reference） | 时区与 misfire、HMAC、钉钉签名/身份、命令/受限自然语言路由、回执关联 | 不宣称覆盖所有平台协议/回调形态 |
| Worker claim/lease | 完成（reference） | Memory/SQLite coordinator、租约过期、heartbeat、两个 SQLite Worker 竞态与单次执行 | 分布式 Store 仍需服务端 lease fencing；不宣称 exactly-once |
| Result Delivery | 完成（reference） | SQLite durable record、稳定 invocationId、immutable binding、并发合并、unknown attempt、幂等 retry | 生产 Channel 自行实现加密凭据与告警 |
| Agent Access Plane | 完成 | `WorkflowAgentAccess`、有界 search/describe/run/trace projection、稳定错误码；Adapter 不直接访问 Store | 无 Provider 层 |
| CLI-native | 完成 | v1 JSON/JSONL Envelope、stdin、search/describe/draft/diff/publish/run/run-get/trace/replay/resume、background worker、SQLite 跨进程与显式 Host module | 交互式 UI 不属于 CLI |
| Skill / Codex Plugin | 完成 | CLI-first/MCP-fallback Skill、同步门禁、官方 Skill/Plugin validator、仓库内 Codex manifest | 个人 marketplace 安装不是源码门禁 |
| 固定 MCP Gateway | 完成 | 5 个 invoke / 11 个 author Tool、1000 Workflow 上下文预算测试、官方 SDK 内存与真实 stdio 进程测试 | 不提供逐 Workflow Tool 投影 |
| DSH Adapter 与 Canvas | 完成 | DSH `dagWorkflowEngine` 使用统一 Runtime；Canvas 编辑同一模板并提供 Trigger/Ingress/Delivery/Trace 运维面 | UI 产品体验可继续独立迭代 |
| Migration | 完成 | Store schema v1-v10 fixture、重复重开、旧 Template 离线转换；不支持的 in-flight run 显式隔离为 paused/operator attention | 不静默猜测旧 checkpoint 语义 |
| 复杂纵向 Case | 完成 | 同一 21 节点 AI 模型周报经 SDK/MCP/CLI/DSH 执行；比较输出与 Journal 契约 | 真实联网结果不作为确定性 CI fixture |
| 文档一致性 | 完成 | README、Architecture、重构方案、体验与子入口 README 描述同一 1.0.0 事实模型 | 发布后按协议变更维护 |

## 当前硬门禁

确认并推送 `main` 前必须全部满足：

1. `pnpm check` 全绿；
2. 干净 build 后 Core 产物不含 DSH/Cordis 标识；
3. tarball 在未安装 DSH peer 的目录中可导入根入口、Runtime、SQLite、MCP 和 Trigger；
4. CLI 跨进程 trace/recorded replay 通过；
5. DSH 本机复杂 Workflow 与 Canvas 回归通过；
6. 同一复杂模板的 Host conformance 与真实 DSH 回归收口；
7. 最终代码审查无 P0/P1 问题后再合并；不在本分支中途发布 npm 或 DSH Market。
