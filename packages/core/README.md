# @gm-hz/dsh-workflow-core

DSH DAG Workflow 的无 UI 内核。v0.1 提供插件化节点注册、模板编译诊断、内存 DAG 调度、结构化 binding、运行事件以及 DSH Tool Runtime adapter。

## 快速使用

```ts
import {
  createDshToolGateway,
  DagWorkflowEngine,
  parseWorkflowTemplate,
  registerCoreNodes,
  WorkflowNodeRegistry,
} from '@gm-hz/dsh-workflow-core'

const registry = new WorkflowNodeRegistry()
registerCoreNodes(registry)

const tools = createDshToolGateway(async input => {
  // Host 插件在这里调用 ctx.tools.execute()，并绑定 owning Agent 与 CallId。
  return executeThroughDsh(input)
})

const engine = new DagWorkflowEngine(registry, { tools })
const template = parseWorkflowTemplate(yamlSource)
const run = engine.start({ template, inputs: { message: 'hello' } })
const result = await run.result // 始终 resolve；通过 status 判断结果
```

## v0.1 内置节点

- `core.start@1`：暴露并验证 Workflow 输入。
- `core.end@1`：组装一个终态输出对象。
- `core.condition@1`：使用固定 operator 选择 `true/false` 端口，不执行任意代码。
- `dsh.tool@1`：只能通过注入的 `WorkflowToolGateway` 执行工具。

## 当前限制

- 只提供内存运行时，不保存 revision、run event 或 checkpoint。
- 节点只执行一次；模板声明 `maxAttempts > 1` 会在编译期失败。
- 取消和 timeout 是协作式的，节点实现必须观察 `AbortSignal`。
- 尚未提供 `agent/foreach/subworkflow/human-approval`、DSH Cordis Service Provider、生成 Skill 和 Canvas。

这些限制对应总体架构中的 Phase 1-3，不会通过在 v0.1 中静默降级来伪装支持。
