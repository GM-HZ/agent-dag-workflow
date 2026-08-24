# @gm-hz/dsh-dag-workflow-host

把 `@gm-hz/dsh-dag-workflow-core` 装配成 DSH 原生 Cordis 服务。插件发布：

- `ctx.workflowNodes`：可处置的 Workflow 节点注册服务。
- `ctx.workflowTemplates`：默认内存 Catalog provider；生产环境可替换为 SQLite provider。
- `ctx.workflowRuns`：默认内存 Run Store provider；生产环境可替换为 SQLite provider。
- `ctx.dagWorkflowEngine`：holder-owned DAG run 服务。
- `dag-workflow/event`：供 Host/UI 观察的实时运行事件。
- 八个 `workflow_*` authoring tools 与 model/user 均可调用的 bundled `workflow-builder` Skill。

## 装配

```ts
import * as DagWorkflow from '@gm-hz/dsh-dag-workflow-host'

await ctx.plugin(DagWorkflow)
```

传入 `{ catalog: 'external', runStore: 'external' }` 可跳过默认内存 provider，并显式装配 `SqliteWorkflowTemplatesProvider` 与 `SqliteWorkflowRunsProvider`。

生产环境可以同时配置 scoped secret bridge 与自动恢复 authority：

```ts
await ctx.plugin(DagWorkflow, {
  catalog: 'external',
  runStore: 'external',
  resolveSecret: ({ ref, parent, signal }) => credentials.resolve(ref, { agent: parent, signal }),
  recovery: {
    reference: parent => sessionIdOf(parent),
    resolve: (ownerRef, { signal }) => agents.resolveSession(ownerRef, signal),
  },
})
```

`reference` 只返回可持久化的查找键；Agent object 永不进入数据库。启动协调器只恢复 `running + ownerRef + valid Agent`，paused run 等待操作者。secret 原值只进入瞬时节点输入，若节点输出包含原值则拒绝 checkpoint。

插件声明 `inject = ['tools', 'subagents', 'approval', 'skills']`。`dsh.tool@1` 始终调用当前 Cordis scope 下的 `ctx.tools.execute()`；`dsh.agent@1` 使用 `ctx.subagents.start()` 并始终 dispose holder-owned run；`dsh.human-approval@1` 使用 `ctx.approval.request()`。三者都传入发起运行的 owning Agent、caller-owned signal 和稳定的 run/node call id。

`core.subworkflow@1` 与 `core.foreach@1` 还会读取 `ctx.workflowTemplates` 中的精确 published revision。每个 child 是同一 `ctx.workflowRuns` 中的确定性 run；子流程暂停时父流程进入 `paused/needs_attention`，不会把未知副作用误报成普通失败。

Authoring tools 包括 `workflow_nodes_list`、`workflow_draft_create/read/update`、`workflow_validate`、`workflow_diff`、`workflow_publish`、`workflow_run`。它们作为普通 DSH tools 重新经过 scope、guard、approval 与 observer policy；published run 必须指定精确 revision。Skill 只引导调用这些工具，不自行读写 Catalog。

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

`parent` 在公共类型上接受任意 object，以兼容 DSH 尚未同步发布的 Agent 类型版本；运行边界会验证它确实暴露可追加的 Session。Provider 对 Tools/Agent 使用窄结构桥接，唯一硬 peer dependency 是与当前 Harness 一致的 `@deepseek-ai/cordis@^4.0.1`。

## 生命周期

- 无效模板与输入在 run 发布前同步抛错。
- 已发布 run 的 `result` 始终 resolve。
- consumer 持有并最终 `dispose()` run。
- Provider 卸载时取消并等待全部活跃 run 收敛。
- 实时事件 listener 和 request observer 的错误全部被隔离，不改变运行结果。

完整 run/node trace 由 `ctx.workflowRuns` 持久化。当前 DSH 尚未开放仓外
Session event 类型注册，也没有为 `Session.append()` 提供 `ignorable` 标记入口，
因此插件不会向 owning Session 写自定义事件，避免会话重载时被判定为不兼容。

Cordis Service 不能使用 JavaScript 原生 `#private` 字段：服务由 Proxy 暴露，方法中的 `this` 是代理。实现统一使用 TypeScript `private`，这个约束也适用于后续 Catalog、Store 和 Canvas RPC service。
