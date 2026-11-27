# 运行与存储运维

Core 不内置常驻控制平面。部署者通过同一个 Runtime、SQLite Store 和可选 Worker 完成恢复、取消、投递重试与数据保留；这些操作都保留 Authority 和 Journal 边界。1.0 的 `WorkflowRunWorker.runOnce()` 每次只 claim 一个 Run，不提供多线程或多进程 Worker 池。

## 取消与进程退出

- 业务取消必须调用 `runtime.cancel(...)`、`handle.cancel(...)`，或对应的 CLI/MCP/DSH/Canvas 入口。它会 CAS 提交终态 `run.cancelled`。
- 进程关闭、Worker lease 丢失或仅想交还执行权时调用 `handle.detach(...)`，或向 Worker 传入 interruption signal。它不会伪造业务取消，另一个 Runner 可以从最后 checkpoint 恢复。
- Core 不会等待不合作的 Host Tool/Agent 才释放执行器，但进程外副作用仍可能继续。因此 Host Tool/Agent 应观察 `AbortSignal`，并以稳定 `invocationId` 做幂等去重；取消竞态中的晚到结果不会覆盖已提交终态。

## 运行历史和日志

Canvas 运行历史支持直接粘贴 Run ID、查看最新事件、筛选失败或按节点查看。点失败摘要可定位冻结图和对应事件，即使事件位于较早的日志页。CLI 中可用 `adw trace --latest` 查看当前执行身份的最近运行，或加 `--workflow orders` 限定流程。

`adw runs` 默认按更新时间倒序列出当前执行身份的运行。可以用 `--workflow`、`--status` 和 `--limit` 缩小范围，或用输出的 `data.nextAfter` 继续分页。DSH Canvas 的运行历史可以打开当前会话的已保存运行和轨迹。重启后仍可在同一 SQLite 库及运行身份下读取历史。

`adw trace <runId> --all` 与 Canvas 下载使用同一份 `agent-dag-workflow.journal/v1` JSONL 格式。第一行是 `run.snapshot`，包含流程修订、状态、结果或错误和 `checkpointSeq`。后续行逐条记录截至导出开始时已提交的 Journal 事件，最后一条应达到该序号。发生断档时，导出会报告错误。运行通过 SQLite 保存，导出只是读取一份副本。

Journal 记录工作流接收、开始、节点状态、外部能力请求与结果状态、重试、取消和 Checkpoint 等执行事实。外部能力宿主内部的日志由宿主保存，导出中的运行和调用标识可用于关联。完整 SQLite 记录包含输入、固定执行计划和 Checkpoint，适合在受控环境中复盘并挑选回归样本。

`adw trace RUN_ID --stats` 逐页读取当前身份有权查看的 Journal，汇总每个节点的执行次数、失败尝试、重试、耗时以及宿主上报的模型、Tool 版本和 token。并行节点的耗时分别累计。`host.usageSamples` 表示提供了 token 数据的调用数，未上报的字段保持缺省。Recorded Replay 保留模型和 Tool 的来源信息，重放的数据不会累计到宿主用量。子运行用自己的 Run ID 查询。

```bash
adw runs --query orders --status failed --format table
adw trace RUN_ID --stats
adw trace RUN_ID --all --output run.jsonl
adw verify-log run.jsonl
adw evidence RUN_ID --artifacts --redact email,accountName --output evidence.json
adw verify-evidence evidence.json
```

`--output` 在导出完成后写入新文件。`verify-log` 核对 Run ID、语义哈希和 Journal 序号。证据包还包含冻结计划、运行输入和 Checkpoint。`--artifacts` 包含实际可读的 Artifact，并区分未包含及不可用的内容。`--redact` 按指定 JSON 字段遮蔽导出副本，保留用于复核的运行标识、事件序号和附件引用。导出后检查自由文本和派生字段是否仍包含敏感值。Canvas 的运行历史可预览证据、设置脱敏字段和下载同一格式。`verify-evidence` 核对 Journal 与 Checkpoint 的身份和序号、附件引用及原始附件的字节哈希。校验和用于核对文件一致性。

## 从运行生成回归用例

```bash
adw case from-run RUN_ID --output run.case.json
adw case compare run.case.json --base orders@1 --candidate ./orders.workflow.json
```

`case compare` 也接受用例目录。每个用例默认要求基线和候选同时满足 `expected`。要验证一次预期修复，把基线的已知行为写到 `baselineExpected`，把修复后的行为写到 `expected`。两侧各自通过且基线尚未满足修复目标时，报告标记 `expected-correction`。断言可覆盖运行状态、最终输出、必经节点、失败节点、错误码和禁止调用的 Tool。

外部节点使用预先记录的输出或失败。样本需要声明 `expectedInputs`，并匹配实际执行节点的类型、配置和输入。报告分别标记基线漂移、候选回归、无效用例以及离线样本不足。单个无效用例会保留在报告里，目录中的后续用例继续检查。`--output report.json` 保存逐条诊断和两侧的语义哈希。所有用例通过时退出码为 `0`，报告中有失败时为 `5`。发布依旧由用户确认。

用 `--host ./host.mjs --review` 可在确定性检查通过后请宿主 Agent 复核结果质量。样本可声明 `reviewRubric`，包含 `id`、正整数 `version` 和 `criteria` 文本列表，例如周报的来源覆盖、事实一致性和重要信息保留。报告保留参与复核的标准版本，每次复核都有独立 Run ID 和 Journal。

## SQLite 导出、清理与备份

SQLite 能力只从 `@gm-hz/agent-dag-workflow/sqlite` 导入，默认根入口不会加载 Node 的实验性 SQLite 模块。

```bash
adw doctor --db workflows.db
adw backup workflows.snapshot.db --db workflows.db
adw backup-verify workflows.snapshot.db
adw restore workflows.snapshot.db --db workflows.restored.db
adw archive --before TIME_MS --limit 100 --db workflows.db
```

`doctor` 显示选中的数据库和执行身份，以及主库 `bytes`、预写日志 `walBytes` 与两者合计 `totalBytes`。`backup-verify` 检查快照的 SQLite 完整性和外键关系。恢复演练可先列出恢复库里的最近一条运行，再用同一库读取其 Trace，核对运行状态和 Journal 序号。

```bash
adw runs --latest --db workflows.restored.db
adw trace RUN_ID --events --db workflows.restored.db
```

恢复写入新的数据库文件。`archive` 默认预览终态运行，添加 `--apply --output archive.db` 时先保留一致性 SQLite 快照，再按当前执行身份归档选中的运行。默认保留历史。

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

## Trigger 恢复

永久输入错误会记录为 `rejected` 并保留稳定的原因码。`recoverPending()` 会继续尝试同一批的后续事件。解析身份、队列或存储等未恢复的故障保持 `received`，整批尝试结束后通过 `AggregateError` 报告对应事件和原因，可在故障恢复后安全重试。

## Generic Webhook 签名

宿主将原始请求体和小写 header 名交给 `WebhookTriggerAdapter.accept()`，验签成功后才调用 Trigger Ingress。每个签名 header 必须只有一个值。

| Header | 格式 |
|---|---|
| `x-workflow-timestamp` | Unix 毫秒时间戳，十进制整数，省略前导零。默认允许接收时间前后各 5 分钟。 |
| `x-workflow-event-id` | 发送方生成的事件 ID，1–512 个 ASCII 字符，允许字母、数字和 `._:-`。同一事件重试时沿用该 ID。 |
| `x-workflow-signature` | `v1=` 后接 HMAC-SHA256 的 64 位小写十六进制摘要。 |

发送方按以下格式签名。三个行分隔符均为 LF，正文是同一 HTTP 请求实际发送的 UTF-8 JSON 字节。

```js
import { createHmac } from 'node:crypto'

function signWebhook(secret, eventId, body) {
  const timestamp = String(Date.now())
  const mac = createHmac('sha256', secret)
    .update(`agent-dag-webhook:v1\n${timestamp}\n${eventId}\n`)
    .update(body)
    .digest('hex')
  return {
    'x-workflow-timestamp': timestamp,
    'x-workflow-event-id': eventId,
    'x-workflow-signature': `v1=${mac}`,
  }
}
```

升级时，请在同一切换窗口让发送方和接收方启用上述格式。旧签名不包含事件 ID，升级后的适配器会拒绝该格式。重试超过时间窗口时，以新的时间戳重新签名，并保留原事件 ID。

## 个人定时任务

先按 [快速开始](./guide/quickstart) 创建项目并发布 `orders@1`，在项目根目录注册计划。`--timezone` 决定何时触发。`run-now` 会立即执行一次，适合确认输入和权限。

```bash
npm exec -- adw schedule publish daily-orders --workflow orders@1 \
  --cron '0 9 * * *' --timezone Asia/Shanghai --input input.json
npm exec -- adw schedule run-now daily-orders
npm exec -- adw schedule status daily-orders
```

系统调度器每分钟调用一次 `schedule tick`。固定 Node、CLI 与配置的绝对路径，避免系统任务因为 PATH 或工作目录不同而打开另一个数据库。以下两种设置选一种，命令从项目根目录开始。

### macOS launchd

```bash
project=$(pwd -P)
node_bin=$(command -v node)
cli_main="$project/node_modules/@gm-hz/agent-dag-workflow/lib/cli.js"
config_file="$project/.agent-dag-workflow.json"
label=dev.agent-dag-workflow.daily-orders
plist="$HOME/Library/LaunchAgents/$label.plist"
mkdir -p "$HOME/Library/LaunchAgents"

if [ ! -e "$plist" ]; then
  args=$("$node_bin" -p 'JSON.stringify(process.argv.slice(1))' -- \
    "$node_bin" "$cli_main" schedule tick --config "$config_file")
  plutil -create xml1 "$plist" &&
    plutil -insert Label -string "$label" "$plist" &&
    plutil -insert ProgramArguments -json "$args" "$plist" &&
    plutil -insert RunAtLoad -bool YES "$plist" &&
    plutil -insert StartInterval -integer 60 "$plist" &&
    plutil -insert StandardOutPath -string "$project/schedule.log" "$plist" &&
    plutil -insert StandardErrorPath -string "$project/schedule.error.log" "$plist" &&
    launchctl bootstrap "gui/$(id -u)" "$plist"
fi
```

用 `launchctl print "gui/$(id -u)/$label"` 查看任务。停止系统定时调用时运行 `launchctl bootout "gui/$(id -u)" "$plist"`。

### Linux cron

```bash
project=$(pwd -P)
node_bin=$(command -v node)
cli_main="$project/node_modules/@gm-hz/agent-dag-workflow/lib/cli.js"
config_file="$project/.agent-dag-workflow.json"
printf '* * * * * "%s" "%s" schedule tick --config "%s" >> "%s/schedule.log" 2>&1\n' \
  "$node_bin" "$cli_main" "$config_file" "$project"
```

将打印的那一行加入 `crontab -e`。用 `crontab -l` 检查，停止时在 `crontab -e` 删除这一行。

### 检查执行状态

一分钟后运行 `npm exec -- adw schedule status daily-orders`。`data.state.lastTickAt` 表示调度器最近持久化的检查时间，单位为 Unix 毫秒。手动 `run-now` 不更新这个时间。若字段缺失或长时间未更新，先查系统任务和 `schedule.log`，再用 `npm exec -- adw doctor` 核对配置与数据库。`data.lastRun` 包含最近运行的状态与 Run ID，可用 `adw trace RUN_ID --events` 排查节点。

### 在 DSH 中查看和试跑

Canvas 首页展开当前会话详情即可找到 SQLite 路径和执行身份。注册绑定时，可给 `adw schedule publish` 显式传入该数据库和身份，并选择 DSH 中实际发布的固定修订。

```bash
adw schedule publish daily-orders --db "$dsh_database" --authority "$dsh_authority" \
  --workflow orders@1 --cron '0 9 * * *' --timezone Asia/Shanghai --input input.json
```

在 Canvas 的「触发与投递」中刷新，可核对下次计划、上次调度检查、最近触发结果和日志。选择「立即试跑」会用当前 DSH 会话执行绑定里的模板和输入，产生可以查看的 Run ID。试跑保持调度游标，并将结果留在运行日志。按时触发由相同身份的调度宿主负责。调度宿主需要能解析绑定中的执行身份。

`--misfire fire-once` 可以补跑最近一次，`--overlap allow` 允许重叠。配置宿主 `delivery` 及 `--delivery` 后可投递终态。宿主可选的 `notify` 接收漏跑、失败、暂停和待投递提醒。`adw delivery list` 查看待处理项，`adw delivery retry-due` 按退避策略处理到期项，`adw delivery retry INVOCATION_ID` 可逐条处理。

## 上线检查

1. 为生产 Authority 配置可恢复的 resolver，并验证跨进程 resume/cancel。DSH 根 bundle 已用 `Session.id` 自动装配 resolver；直接使用 `/dsh/host` 时仍由 Host 显式配置。
2. 根据业务数据量收紧 `WorkflowDeploymentLimits`，不要接受模板自行提升 ceiling。
3. 为 Host 外部能力实现稳定 invocation id 去重、AbortSignal 和输出 Schema。
4. 配置数据库备份、终态保留周期与 delivery attention 告警。
5. 发布前运行 `pnpm check`、`pnpm verify:canvas-browser`、`pnpm verify:pack`、复杂示例和 Host 回归。
