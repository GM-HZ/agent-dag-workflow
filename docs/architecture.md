# DSH DAG Workflow 总体架构

> 本文描述当前 `0.2.x` DSH 集成架构。去除 DSH Core 标识、收敛为单一公开包并引入通用 Journal/Adapter/Trigger 边界的 `0.3.0` 提案见 [Agent DAG Workflow 核心通用化重构方案](core-generalization-refactor.md)。

## 1. 产品定位

DSH DAG Workflow 是一组可组合插件，而不是一个拥有独立模型、工具、权限和会话体系的平台。它提供四件事：版本化模板、可恢复执行、Agent 生成/调用入口、Canvas 可视化。

现有 DSH dynamic workflow 继续负责一次性的模型生成脚本与大规模 subagent fan-out；DAG Workflow 负责可保存、可审查、可复用和可恢复的确定性流程。二者共享底层能力，但不共享不兼容的输入协议，也不占用同一个 `ctx.workflowEngine` service key。

## 2. 设计原则

1. **模板是唯一事实源。** Skill、Agent 工具、Canvas、CLI 和执行器读写同一份 `WorkflowTemplate`。
2. **Canvas 是投影。** React Flow/Flowgram 坐标放在独立 `layout` 区域；运行编译器忽略它，语义图不包含 UI 库私有字段。
3. **外部扩展只有两级。** 普通外部能力一律注册为 DSH Tool；只有 Tool 无法表达的工作流生命周期才实现自定义 Node，不引入 Tool-backed preset 或第二套调用协议。
4. **发布版本不可变。** draft 可以编辑，published revision 固定模板内容、节点类型版本和语义 hash。
5. **恢复不是重跑的别名。** ready queue、边状态、节点尝试、变量池、等待原因和 container frame 都属于 checkpoint。
6. **默认按至少一次设计。** 外部副作用无法承诺 exactly-once；崩溃时状态不明的节点默认进入 `needs_attention`，除非节点声明可安全重试或具备幂等键。
7. **任意环路不进入 v1。** 普通图必须是 DAG；循环只通过 `foreach` 容器表达，避免隐式回边破坏校验、恢复和可视化。
8. **能力必须预声明。** NodeDefinition 从固定 config 解析 capability/resource dependency，模板 `spec.requires` 是 fail-closed allowlist；声明不等于授权。
9. **动态结果必须先契约化。** `node.expects` 在 checkpoint 前收窄输出 Schema/大小；Agent 语义复核只能作为显式后续节点。

## 3. 能力分层

```mermaid
flowchart TB
  subgraph Consumers["Consumers"]
    Skill["workflow-builder skill"]
    Tools["Agent workflow tools"]
    Canvas["Canvas client plugin"]
    CLI["CLI / API"]
  end

  subgraph Definitions["Service definitions"]
    Catalog["ctx.workflowTemplates"]
    Nodes["ctx.workflowNodes"]
    Caps["ctx.workflowCapabilities"]
    Scripts["ctx.workflowScripts"]
    Engine["ctx.dagWorkflowEngine"]
  end

  subgraph Runtime["Runtime implementations"]
    Store["SQLite template/run store"]
    Scheduler["Local persistent scheduler"]
    CoreNodes["Core NodeDefinitions"]
    PluginNodes["Third-party node plugins"]
  end

  subgraph DSH["Existing DSH capabilities"]
    DshTools["ctx.tools"]
    Subagents["ctx.subagents"]
    Approval["interaction / approval"]
    Sessions["owning Agent / session authority"]
    Remote["Typert Remote"]
    Slots["client modules / UI slots"]
  end

  Skill --> Tools
  Tools --> Catalog
  Tools --> Engine
  Canvas --> Remote
  CLI --> Catalog
  CLI --> Engine
  Catalog --> Store
  Engine --> Scheduler
  Engine --> Nodes
  Nodes --> Scripts
  Nodes --> CoreNodes
  Nodes --> PluginNodes
  PluginNodes --> Caps
  CoreNodes --> DshTools
  CoreNodes --> Subagents
  CoreNodes --> Approval
  Engine --> Sessions
  Canvas --> Slots
```

扩展决策只有两条路径：

1. 能以一次结构化调用表达的外部能力注册到 `ctx.tools`，统一由 `dsh.tool@1` 执行。Canvas 直接把 scope-visible Tool schema 显示为 palette 项，保存时仍是同一个通用 Tool 节点。
2. 需要暂停恢复、长任务 checkpoint、事务补偿或特殊控制流时，注册完整 `WorkflowNodeDefinition`。自定义节点若需要 Host 生命周期服务，同时在 `ctx.workflowCapabilities` 注册绑定，并从节点的 scoped resolver 取得。

`ctx.workflowCapabilities` 是自定义 Node 的安全 inject 投影，不是第三种业务扩展层；HTTP、数据库、消息、存储等普通调用不能借它绕开 DSH Tool policy。

### 3.1 `ctx.workflowNodes`

节点定义注册表是插件生态的核心。每次注册必须返回 disposer，并在插件卸载后停止新的编译解析。建议定义包含：

```ts
interface WorkflowNodeDefinition {
  readonly type: string
  readonly version: number
  readonly title: string
  readonly description: string
  readonly configSchema: JsonSchema
  readonly inputSchema: JsonSchema
  readonly outputSchema: JsonSchema
  readonly capabilities: readonly string[]
  dependencies?(config: JsonObject): readonly WorkflowRequirement[]
  readonly retry: 'never' | 'safe' | 'idempotent'
  execute(context: WorkflowNodeExecutionContext): Promise<WorkflowNodeExecutionResult>
}
```

Canvas renderer不是 Host 定义的一部分。Client 插件按相同 `type@version` 注册表单/节点 renderer；没有定制 renderer 时使用 JSON Schema 通用表单，保证第三方 Host 节点仍可查看和编辑。

运行开始时解析并租用精确的 `type@version`。插件卸载后拒绝新运行；已接受运行持有 run-owned executor 与清理句柄，遵循 DSH 已有 holder-owned run 语义，不能在运行中静默换实现。

节点定义还可以提供 `dependencyKinds + dependencies(config)`。编译器把它和 `capabilities`、secret binding 合并为节点的固定依赖请求，并要求全部出现在模板 `spec.requires`。内置 Tool/Agent/Approval gateway 按 NodeDefinition capabilities 裁剪；自定义服务通过 `context.capabilities.require(name)` 取得，resolver 同时拒绝 Node 未声明的能力和 Host 未安装的绑定。

### 3.2 `ctx.workflowScripts`

`core.script@1` 不是开放的 JavaScript/Python eval 节点，而是一个版本化 runtime adapter。Host 通过 `ctx.workflowScripts` 注册 `language@version`；节点在编译期完成 runtime availability 与 source 语义校验，在运行期只传入深冻结 JSON input、AbortSignal 和操作预算，并只接受 JSON object 输出。

内置 `dsh.expr@1` 覆盖 Coze/Dify 常见的字段映射、文本模板、数组筛选/投影、聚合和类型转换。`sortBy` 提供稳定多键排序，`withIndex` 从确定顺序生成序号；`joinBy` 对唯一 key 做一一对应 overlay 合并，并禁止覆盖原字段，可用于把 Agent 评分/摘要安全合并回 Tool 原始记录。它没有 I/O、时间、随机数、环境变量或 secret API，并拒绝 prototype key 与动态函数调用。外部 HTTP、数据库、知识库和凭据访问继续使用 `dsh.tool@1`；复杂非确定逻辑使用 `dsh.agent@1`。第三方 runtime 是受信任的 Host 插件代码，声明 `deterministic: true` 后仍由部署者负责审计。

### 3.3 `ctx.workflowTemplates`

负责 draft、revision、发布、校验和查询，不负责调度。核心操作：

- `createDraft / readDraft / updateDraft(expectedRevision)`
- `validate(template, scope)`
- `diff(base, candidate)`
- `publish(expectedRevision)`
- `getPublished(id, revision?) / list()`

更新使用 optimistic concurrency。语义 hash 排除 `layout`，内容 hash 包含完整模板。发布时锁定节点版本；缺失节点、版本迁移失败、能力不可见或 secret 引用无效都必须失败。

### 3.4 `ctx.dagWorkflowEngine`

建议沿用 DSH `start() -> run handle` 风格，但不要扩展现有 script-based `WorkflowStartRequest`：

```ts
interface DagWorkflowStartRequest {
  readonly template: WorkflowTemplateRef | InlineWorkflowTemplate
  readonly inputs: JsonValue
  readonly parent: Agent
  readonly signal?: AbortSignal
  readonly mode?: 'foreground' | 'background'
}

interface DagWorkflowRun {
  readonly id: DagWorkflowRunId
  readonly result: Promise<DagWorkflowResult> // 永不 reject
  cancel(reason?: string): void
  dispose(): Promise<void>
}
```

首版只做 foreground；background 后续接 DSH job/schedule 能力。Canvas test run 也应建立明确的 Agent/Session 归属，不能用无 authority 的匿名 Host 调用绕过 scoped tool 与 approval 策略。

## 4. 编译与执行

### 4.1 编译流水线

```mermaid
flowchart LR
  Parse["Parse + structural schema"] --> Resolve["Resolve node type@version"]
  Resolve --> Topology["Topology / branch / container checks"]
  Topology --> Bindings["Binding + type compatibility"]
  Bindings --> Policy["Capability / secret / retry policy"]
  Policy --> IR["Immutable executable IR"]
```

结构校验和语义校验分开。JSON Schema 只负责 envelope；唯一 ID、上游引用、端口、类型兼容、DAG、subworkflow 递归深度与插件可用性由编译器产生结构化 diagnostics：

```ts
interface WorkflowDiagnostic {
  code: string
  severity: 'error' | 'warning'
  message: string
  nodeId?: string
  path?: readonly (string | number)[]
}
```

生成器和 Canvas 都消费同一 diagnostics，使 Agent 能定点修复、UI 能高亮节点。

编译还会生成不可变 capability manifest。有效能力是 `NodeDefinition declaration ∩ template requires ∩ owning Agent scope ∩ deployment policy`；任何一层缺失都 fail closed。`requires`、`expects` 都属于语义模板并进入 semantic hash。

### 4.2 调度语义

每条边状态为 `unknown | taken | skipped`。普通节点在所有入边不再 unknown 且至少一条入边 taken 时 ready；条件节点将选中端口的边标记 taken，其余标记 skipped。这样分支汇合、跳过传播和并行 join 不依赖隐式拓扑猜测。

节点状态建议为：

```text
pending -> ready -> running -> succeeded
                         |----> failed
                         |----> waiting -> ready
                         |----> cancelled
pending/ready ----------> skipped
running after crash ----> needs_attention | ready(retry-safe)
```

调度器有界并发，队列操作与节点状态迁移必须在一个持久事务内提交。一个节点成功后依次提交：输出快照、节点终态、出边状态、后继 ready task、run event；提交成功后才能向观察者发布。

节点输出在“成功”前依次经过 lossless JSON、secret leak、NodeDefinition output schema、实例 `expects.schema/maxBytes`。若需要判断“业务上是否合理”，图中再连接一个具有严格结构化输出的 Agent review 节点；模型判断不会扩大后续节点权限。

### 4.3 事件与 checkpoint

独立 workflow run store 保存完整事件和 checkpoint。插件不向 DSH Session 写入自定义事件类型，避免宿主在未注册下游事件 schema 时拒绝重放会话；Agent 调用产生的标准 `workflow_run` tool call/result 仍由 DSH 正常写入 Session，满足 “model-visible means logged”。Canvas 的运行轨迹则通过 run store 和实时 `dag-workflow/event` 信号呈现。

最小 run event：

- `run.started / run.completed / run.failed / run.cancelled / run.paused`
- `node.ready / node.started / node.progress / node.completed / node.failed / node.waiting / node.skipped / node.needs-attention`
- `edge.taken / edge.skipped`
- `checkpoint.committed`

每个事件包含 run-local 单调 `seq`。checkpoint 保存模板/hash、节点输出与进度、节点/边状态、ready queue、node run count、container frame、depth ceiling 与 pause reason。v1 每个节点一次正常尝试；崩溃后的 retry 由 NodeDefinition `retry` 声明与 operator decision 控制。人工节点进入 waiting 前必须先提交 checkpoint。

## 5. 首批节点

| Node | Execution path | v1 约束 |
|---|---|---|
| `core.start@1` | 验证并暴露 workflow inputs | 唯一 |
| `core.end@1` | 组装 workflow outputs | 至少一个 |
| `dsh.tool@1` | `ctx.tools.execute()` | 重新执行全部 DSH policy；默认崩溃后不自动重试 |
| `dsh.agent@1` | `ctx.subagents` | parent 归属明确；输出可选 JSON Schema |
| `core.condition@1` | 受限表达式/JSON Logic | 禁止 `eval` 和任意 JS |
| `core.script@1` | `ctx.workflowScripts` | 纯 JSON 变换；精确 runtime 版本；有 source/operation 上限 |
| `core.foreach@1` | 显式容器 frame | 有界 item 与并发数，不允许普通回边 |
| `core.subworkflow@1` | 调用固定发布 revision | 发布时检查依赖环和最大深度 |
| `dsh.human-approval@1` | interaction/approval + checkpoint | resume token 一次性、带 authority |

HTTP、知识库、数据库不先做专属节点；它们通过 `dsh.tool@1` 使用 DSH 插件注册的工具。确定性数据处理通过 `core.script@1`，但它不能成为绕过 Tool policy 的 I/O 后门。只有当某能力需要独有的 Canvas、流式或 checkpoint 语义时，再增加专属节点。

## 6. Agent 与 Skill 生成闭环

引导 skill 不直接拼接并落盘 YAML。它驱动一组受验证工具：

- `workflow_nodes_list`：返回当前 Agent scope 可用的节点类型、版本和 schemas。
- `workflow_draft_create/import/read/update/validate`：维护带 revision 的 draft；大型模板以完整 JSON 字符串导入并继续使用 CAS。
- `workflow_validate`：返回结构化 diagnostics。
- `workflow_diff`：生成前后节点/边/config 差异。
- `workflow_publish`：只有无 error diagnostics 且 expected revision 一致时发布。
- `workflow_run`：执行 published revision 或显式 inline draft test run。

skill 流程借鉴 Dify 的 planner/builder 拆分，但由 DSH Agent 完成：

1. 澄清目标、输入、输出、外部副作用和人工确认点。
2. 查询当前 scope 的节点/Tool catalog 与当前 Agent 支持的结构化输出 Schema 方言，禁止臆造插件名或使用不支持的约束。
3. 先生成只含 node id/type/purpose/edges 的 topology plan。
4. 再按节点 schema 填充 config 与 bindings；大型图可有界并行构建节点配置。
5. 只做确定性修复，例如默认 layout、缺省端口、稳定 ID；有多种语义解释时回问用户。
6. 循环 `validate -> 定点修复`，展示 diff 后再发布。
7. 发布后可选择立即 test run，并把 run id 交给 Canvas。

## 7. Canvas 插件

Canvas 建议用 `@xyflow/react` 起步，不把 Coze Flowgram 或 Dify Canvas 代码直接搬入项目。DSH Client 插件通过 `dsh.client` 加载，使用 Typert Remote 调用 template/run services。

推荐 UI 装载方式：

- 在 `shell.overlay` 注册一个全屏 Workflow Studio overlay，避免替换 `ui-layout` 的 root 或永久占用窄 details panel。
- 提供一个轻量浮动入口；生成 skill 创建/更新 draft 的 Remote event 也可自动打开对应 draft。
- 运行节点和聊天中的 workflow run renderer 可打开同一个 overlay，并定位到 run/template/node。
- overlay 内包括 node palette、Canvas、schema form、diagnostics、test inputs、run trace、diff/publish。

Client 节点 renderer 也是 effect 注册并可卸载。Host 返回 node type 元数据与 JSON Schema，Client 自定义 renderer 只增强体验；不能成为模板可执行性的必要条件。

## 8. 插件/包拆分

首版采用独立 monorepo，不修改 DSH 上游；共同演进的 definition/implementation 被合并为六个公开包：

```text
packages/
  core/       # protocol/compiler/scheduler/core nodes/run-store contract
  catalog/    # draft CAS/diff/published revisions
  dsh/        # Cordis services, DSH nodes, Agent tools, bundled Skill
  sqlite/     # template/run SQLite persistence and migrations
  canvas/     # Typert Remote, shell overlay, XYFlow Studio
```

所有注册都通过 Cordis effect，并测试 dispose 后注册项消失。Canvas Client 另暴露 renderer registry 与 `workflowCanvasUi` navigation controller，供第三方节点和 Session renderer 扩展。

## 9. 交付阶段

### Phase 0：可执行内核 spike

- Template v1 parser/validator/diagnostics。
- Node registry 与 plugin disposal/版本解析。
- 内存 scheduler：start/end/tool/condition、分支与 join。
- `workflow_run` tool，通过真实 DSH tool pipeline 执行节点。

退出标准：无 Canvas 也能由固定 YAML 完成真实组合测试，Session 中可重放 run 摘要。

### Phase 1：持久运行

- SQLite template/revision/run event/checkpoint。
- crash recovery、cancel、retry policy、output cap。
- agent、foreach、subworkflow、human approval。

退出标准：进程在任意 node boundary 重启后可恢复；不安全副作用不会被静默重放。

### Phase 2：生成体验

- Agent CRUD/validate/diff/publish tools。
- `workflow-builder` skill。
- tool/node catalog 路由与结构化修复。

退出标准：从自然语言到可发布模板全链路不需要手改 YAML，错误能定位 node/path。

### Phase 3：Canvas

- full-screen overlay、通用 schema form、定制核心节点 renderer。
- test run trace、节点输出检查、diff、optimistic concurrency。
- run/Session 跳转。

退出标准：Skill 生成和 Canvas 编辑互相可见且不发生 DSL 转换损失。

## 10. 主要风险

- **DSH 仍是 developer preview。** 锁定 DSH revision，用一层 adapter 封装 Typert、slot 与 service key；模板协议自行版本化。
- **插件卸载与长运行冲突。** engine start 时租用 node definitions；卸载只阻止新 run，现有 run 必须继续或以明确原因取消并清理。
- **副作用重放。** 默认不自动重试未知结果的 tool 节点；逐步引入 idempotency capability，不能用 checkpoint 冒充 exactly-once。
- **模板携带 prompt 与 secret。** secret 只能保存 reference；执行时重新做 scoped capability/approval 检查；模板发布不代表授予权限。
- **Canvas 反客为主。** 运行 schema 与 UI state 分离；任何无 Canvas 的 Agent/CLI 都能完整创建、校验和执行模板。
- **参考项目许可证。** 设计思想可借鉴，代码复制必须逐文件确认许可；Dify 是 modified Apache-2.0，前端还有额外条件与外观声明。
