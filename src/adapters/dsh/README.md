# @gm-hz/dsh-dag-workflow-host

把 `@gm-hz/dsh-dag-workflow-core` 装配成 DSH 原生 Cordis 服务。插件发布：

- `ctx.workflowNodes`：可处置的 Workflow 节点注册服务。
- `ctx.workflowCapabilities`：自定义 Node 的 Host 服务注册表；执行时只投影 NodeDefinition 已声明的能力。
- `ctx.workflowScripts`：可处置的版本化纯脚本 runtime 注册服务，内置 `json.expr@1`。
- `ctx.workflowTemplates`：默认内存 Catalog 实现；生产环境可替换为 SQLite 实现。
- `ctx.workflowRuns`：默认内存 Run Store 实现；生产环境可替换为 SQLite 实现。
- `ctx.dagWorkflowEngine`：holder-owned DAG run 服务。
- `dag-workflow/event`：供 Host/UI 观察的实时运行事件。
- 十个 `workflow_*` authoring tools 与 model/user 均可调用的 bundled `workflow-builder` Skill。

## 装配

```ts
import * as DagWorkflow from '@gm-hz/dsh-dag-workflow-host'

await ctx.plugin(DagWorkflow)
```

传入 `{ catalog: 'external', runStore: 'external' }` 可跳过默认内存实现，并显式装配 `SqliteWorkflowTemplatesService` 与 `SqliteWorkflowRunsService`。

生产环境可以同时配置 scoped secret bridge 与自动恢复 authority：

```ts
await ctx.plugin(DagWorkflow, {
  catalog: 'external',
  runStore: 'external',
  resolveSecret: ({ ref, parent, signal }) => credentials.resolve(ref, { agent: parent, signal }),
  recovery: {
    reference: parent => sessionIdOf(parent),
    resolve: (authorityRef, { signal }) => agents.resolveSession(authorityRef, signal),
  },
})
```

`reference` 只返回可持久化的查找键；Agent object 永不进入数据库。启动协调器只恢复 `running + authorityRef + valid Agent`，paused run 等待操作者。Credential 只以不透明引用保存在静态配置中，明文不进入数据面和 checkpoint。

插件声明 `inject = ['tools', 'subagents', 'approval', 'skills']`。`tool.call@1` 始终调用当前 Cordis scope 下的 `ctx.tools.execute()`；`agent.run@1` 使用 `ctx.subagents.start()` 并始终 dispose holder-owned run；`human.approval@1` 使用 `ctx.approval.request()`。三者都传入发起运行的 owning Agent、caller-owned signal 和稳定的 run/node call id。

`workflow.call@1` 与 `core.foreach@1` 还会读取 `ctx.workflowTemplates` 中的精确 published revision。每个 child 是同一 `ctx.workflowRuns` 中的确定性 run；子流程暂停时父流程进入 `paused/needs_attention`，不会把未知副作用误报成普通失败。

Authoring tools 包括 `workflow_nodes_list`、`workflow_draft_create/import/read/update/validate`、`workflow_validate`、`workflow_diff`、`workflow_publish`、`workflow_run`。`workflow_draft_import` 接收完整 `templateJson`，适合大型模板；更新时仍要求 draft revision CAS。它们作为普通 DSH tools 重新经过 scope、guard、approval 与 observer policy；published run 必须指定精确 revision。Skill 只引导调用这些工具，不自行读写 Catalog。

`workflow_nodes_list` 同时返回 `scriptRuntimes`、当前 DSH Agent 的结构化输出能力/Schema 方言、节点 `dependencyKinds` 和可由默认配置推导的 `defaultRequirements`。模板不选择 Agent 实现。第三方插件可调用 `ctx.workflowScripts.register()` 增加确定性业务语言；`core.script@1` 在编译期解析精确 `language@version` 并执行 runtime 的语义校验。Runtime 只负责纯 JSON 变换，任何 I/O 或 secret 访问仍由普通 DSH 节点承担。

外部扩展固定为两级。普通 HTTP、数据库、消息和存储能力只注册到 `ctx.tools`，由 `tool.call@1` 统一执行；`workflow_nodes_list` 会按调用 Agent scope 返回这些 Tool。只有暂停恢复、进度 checkpoint、事务补偿等 Tool 无法表达的生命周期才注册 `ctx.workflowNodes`。此类自定义 Node 可以用 `ctx.workflowCapabilities.register()` 绑定 Host 服务，并通过 `execution.capabilities.require()` 获取 fail-closed 的节点级投影；它不是第二套 Tool invocation bus。

模板 `spec.requires` 是类似 Cordis inject 的 fail-closed 依赖白名单，但不授予权限。运行仍以 owning Agent 的真实 DSH scope 为准，并再次经过 Tool/subagent/approval policy。节点 `expects` 在动态结果写入 run store 前执行确定性 JSON Schema 与字节上限校验；Agent 语义复核应作为后续显式节点，不能替代该边界。

```ts
const run = ctx.dagWorkflowEngine.start({
  template,
  inputs: { message: 'hello' },
  parent: agent,
})

const result = await run.result
await run.dispose()

const recovered = ctx.dagWorkflowEngine.resume({
  runId: run.id,
  parent: agent,
  unknownNodeResolutions: { call: 'retry' },
})
```

`parent` 在公共类型上接受任意 object；运行边界会验证它确实暴露可追加的 Session。Host 对 Tools/Agent 使用窄结构桥接，唯一硬 peer dependency 是与当前 Harness 一致的 `@deepseek-ai/cordis@^4.0.1`。

## 生命周期

- 无效模板与输入在 run 发布前同步抛错。
- 已发布 run 的 `result` 始终 resolve。
- consumer 持有并最终 `dispose()` run。
- Host 插件卸载时取消并等待全部活跃 run 收敛。
- 实时事件 listener 和 request observer 的错误全部被隔离，不改变运行结果。

完整 run/node trace 由 `ctx.workflowRuns` 持久化。当前 DSH 尚未开放仓外
Session event 类型注册，也没有为 `Session.append()` 提供 `ignorable` 标记入口，
因此插件不会向 owning Session 写自定义事件，避免会话重载时被判定为不兼容。

Cordis Service 不能使用 JavaScript 原生 `#private` 字段：服务由 Proxy 暴露，方法中的 `this` 是代理。实现统一使用 TypeScript `private`，这个约束也适用于后续 Catalog、Store 和 Canvas RPC service。
