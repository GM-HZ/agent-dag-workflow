# 实现状态与完成审计

本表是“完整实现总体设计”的验收清单。`完成` 必须同时有实现、测试和公开入口；仅有设计文档或类型定义记为 `未开始/部分完成`。

| 能力 | 状态 | 当前证据 | 未完成项 |
|---|---|---|---|
| Template v1alpha1 envelope/binding/layout | 部分完成 | `packages/core/src/types.ts`、`schema.ts`、lossless JSON snapshot | schema migration、类型兼容推导 |
| 节点注册与插件卸载 | 完成 | `registry.ts`、compiler lease 测试、Cordis registry service 测试 | 后续只需扩充节点类型 |
| 编译诊断、DAG、上游 binding、端口、终态路径 | 完成 | `compiler.ts`、`compiler.spec.ts` | container/subworkflow 校验随对应节点实现 |
| 内存调度、condition/join/skip、取消、caps | 完成 | `engine.ts`、`engine.spec.ts` | 持久事务与恢复由下一项承接 |
| `start/end/tool/condition` | 完成 | `nodes.ts` 与核心/DSH 集成测试 | 无 |
| DSH Cordis `ctx.workflowNodes/ctx.dagWorkflowEngine` | 完成 | `packages/dsh/src/services.ts`、`plugin.spec.ts` | 加入正式 DSH bundle patch |
| 真实 `ctx.tools.execute()` policy path | 完成 | Cordis stub 端到端证明 owning Agent/signal/args 透传 | 在完整 Harness composition 中再跑兼容门禁 |
| Session 摘要与实时事件 | 完成 | run/node Session event 与 observer containment 测试 | UI projection 尚未实现 |
| Template catalog、draft/revision/hash/CAS/publish | 完成 | `packages/catalog` 领域测试、`packages/sqlite` 重开/CAS/ownership 测试 | 仅剩接入 Cordis service（不改变 catalog 语义） |
| Run event store、checkpoint、crash recovery | 未开始 | 总体架构 §4.3 | 全部实现与故障注入测试 |
| `agent/foreach/subworkflow/human-approval` | 未开始 | 总体架构 §5 | 全部实现与恢复语义 |
| Agent CRUD/validate/diff/publish/run tools | 未开始 | 总体架构 §6 | 全部实现 |
| `workflow-builder` Skill | 未开始 | 总体架构 §6 | 规划/构建/修复/预览闭环 |
| Canvas Host RPC 与 Client overlay | 未开始 | 总体架构 §7 | 编辑、校验、diff、trace、renderer registry |
| 安全/权限/secret/idempotency review | 部分完成 | tool policy 路径、secret reference、单次执行约束 | 持久化与扩展节点实现后完整审计 |
| CI、构建、包内容、MIT | 完成 | `.github/workflows/ci.yml`、pack 检查、LICENSE | 发布前 provenance/SBOM 可选 |

## Cordis 兼容性审阅结论

1. Service 方法会经 Proxy 调用，禁止原生 `#private`；测试已覆盖此项。
2. 所有注册必须由 `ctx.effect()` 持有；核心节点在插件卸载后移除。
3. Provider 卸载必须 cancel + await active runs，不能只删除 service key。
4. DSH 仍处于预览版本且包发布不同步；Tools/Agent 使用结构桥接，Cordis 使用精确兼容 peer range。
5. Session 记录是观察面，任何 append/listener 失败都不能改变执行面。
