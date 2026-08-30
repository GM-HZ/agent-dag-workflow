# 运行与存储运维

Core 不内置常驻控制平面。部署者通过同一个 Runtime、SQLite Store 和可选 Worker 完成恢复、取消、投递重试与数据保留；这些操作都保留 Authority 和 Journal 边界。

## 取消与进程退出

- 业务取消必须调用 `runtime.cancel(...)`、`handle.cancel(...)`，或对应的 CLI/MCP/DSH/Canvas 入口。它会 CAS 提交终态 `run.cancelled`。
- 进程关闭、Worker lease 丢失或仅想交还执行权时调用 `handle.detach(...)`，或向 Worker 传入 interruption signal。它不会伪造业务取消，另一个 Runner 可以从最后 checkpoint 恢复。
- Core 不会等待不合作的 Host Tool/Agent 才释放执行器，但进程外副作用仍可能继续。因此 Host Tool/Agent 应观察 `AbortSignal`，并以稳定 `invocationId` 做幂等去重；取消竞态中的晚到结果不会覆盖已提交终态。

## SQLite 导出、清理与备份

SQLite 能力只从 `@gm-hz/agent-dag-workflow/sqlite` 导入，默认根入口不会加载 Node 的实验性 SQLite 模块。

```ts
import { SqliteWorkflowRunStore } from '@gm-hz/agent-dag-workflow/sqlite'

const runs = new SqliteWorkflowRunStore({ path: 'workflows.db' })

// 导出完整不可变模板、执行计划、checkpoint 与 Journal events。
const record = await runs.exportRun(runId)

// 只删除截止时间前的终态 Run；running/paused 永远不会被 prune。
const removed = await runs.prune({ terminalBefore: Date.now() - 30 * 86_400_000, limit: 500 })

// SQLite 一致性快照；目标文件必须不存在。
runs.backupTo('backups/workflows-2026-08-30.db')
runs.close()
```

生产部署应先备份，再按有界批次清理，并让自己的调度器负责周期。`exportRun()` 返回的记录可能包含业务数据，应服从部署的数据分级和保留策略。

## Result Delivery

为 Trigger Binding 设置 `deliveryRef` 并把 `WorkflowResultDeliveryService` 注入 `WorkflowRunWorker` 后，Worker 会自动投递 completed/failed/cancelled 终态。投递有独立的稳定 invocation id；失败会记录为 `unknown`，不会改写 Workflow 的终态。

```ts
const worker = new WorkflowRunWorker(runtime, coordinator, delivery)
await worker.runOnce({ workerId: 'worker-1', leaseMs: 30_000 })

// 运维任务重试 pending/unknown 项，仍复用原 invocation id。
await delivery.retryAttention({ limit: 100 })
```

Channel 凭据与平台 token 只存在于 Delivery Gateway 自己的安全存储中，不能进入 `deliveryRef`、模板、Checkpoint 或 Journal。

## 1.0 上线检查

1. 为生产 Authority 配置可恢复的 resolver，并验证跨进程 resume/cancel。DSH 根 bundle 已用 `Session.id` 自动装配 resolver；直接使用 `/dsh/host` 时仍由 Host 显式配置。
2. 根据业务数据量收紧 `WorkflowDeploymentLimits`，不要接受模板自行提升 ceiling。
3. 为 Host 外部能力实现稳定 invocation id 去重、AbortSignal 和输出 Schema。
4. 配置数据库备份、终态保留周期与 delivery attention 告警。
5. 发布前运行 `pnpm check`、`pnpm verify:pack`、复杂示例和 Host/Canvas 回归。
