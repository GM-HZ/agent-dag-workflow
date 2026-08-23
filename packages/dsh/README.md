# @gm-hz/dsh-workflow-dsh

把 `@gm-hz/dsh-workflow-core` 装配成 DSH 原生 Cordis 服务。插件发布：

- `ctx.workflowNodes`：可处置的 Workflow 节点注册服务。
- `ctx.dagWorkflowEngine`：holder-owned DAG run 服务。
- `dag-workflow/event`：供 Host/UI 观察的实时运行事件。
- `dsh-dag-workflow/*` Session 摘要事件：用于重放顶层 run/node 状态。

## 装配

```ts
import * as DagWorkflow from '@gm-hz/dsh-workflow-dsh'

await ctx.plugin(DagWorkflow)
```

插件声明 `inject = ['tools']`。`dsh.tool@1` 始终调用当前 Cordis scope 下的 `ctx.tools.execute()`，并传入发起运行的 owning Agent、caller-owned signal 和 run/node 派生 call id。

```ts
const run = ctx.dagWorkflowEngine.start({
  template,
  inputs: { message: 'hello' },
  parent: agent,
})

const result = await run.result
await run.dispose()
```

`parent` 在公共类型上接受任意 object，以兼容 DSH 尚未同步发布的 Agent 类型版本；运行边界会验证它确实暴露可追加的 Session。Provider 对 Tools/Agent 使用窄结构桥接，唯一硬 peer dependency 是与当前 Harness 一致的 `@deepseek-ai/cordis@^4.0.1`。

## 生命周期

- 无效模板与输入在 run 发布前同步抛错。
- 已发布 run 的 `result` 始终 resolve。
- consumer 持有并最终 `dispose()` run。
- Provider 卸载时取消并等待全部活跃 run 收敛。
- Session 写入、实时事件 listener 和 request observer 的错误全部被隔离，不改变运行结果。

Cordis Service 不能使用 JavaScript 原生 `#private` 字段：服务由 Proxy 暴露，方法中的 `this` 是代理。实现统一使用 TypeScript `private`，这个约束也适用于后续 Catalog、Store 和 Canvas RPC service。
