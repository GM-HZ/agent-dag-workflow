# @gm-hz/dsh-dag-workflow-core

DSH DAG Workflow 的无 UI 内核。提供插件化节点注册、模板编译诊断、DAG 调度、结构化 binding、运行事件、checkpoint 恢复以及 DSH Tool Runtime adapter。

## 快速使用

```ts
import {
  createDshToolGateway,
  DagWorkflowEngine,
  InMemoryWorkflowRunStore,
  parseWorkflowTemplate,
  registerCoreNodes,
  WorkflowNodeRegistry,
} from '@gm-hz/dsh-dag-workflow-core'

const registry = new WorkflowNodeRegistry()
registerCoreNodes(registry)

const tools = createDshToolGateway(async input => {
  // Host 插件在这里调用 ctx.tools.execute()，并绑定 owning Agent 与 CallId。
  return executeThroughDsh(input)
})

const runStore = new InMemoryWorkflowRunStore()
const engine = new DagWorkflowEngine(registry, { tools }, { runStore })
const template = parseWorkflowTemplate(yamlSource)
const run = engine.start({ template, inputs: { message: 'hello' } })
const result = await run.result // 始终 resolve；通过 status 判断结果

// 进程恢复后使用同一个持久化 store；未知副作用节点需显式处理。
const resumed = engine.resume({
  runId: run.id,
  unknownNodeResolutions: { sideEffectNodeId: 'retry' },
})
```

## 能力依赖与结果契约

外部集成只有两级：普通业务能力使用通用 `dsh.tool@1`；只有特殊工作流生命周期才实现自定义 `WorkflowNodeDefinition`。节点通过 `capabilities + dependencies(config)` 声明依赖，并由模板 `spec.requires` 精确 allowlist。编译器拒绝未声明的 capability、Tool、Agent provider、Runtime、secret 与 subworkflow。

自定义 Node 可以把 Host 服务注册到 `WorkflowCapabilityRegistry`，再通过 `context.capabilities.require(name)` 获取节点级安全投影。resolver 不会暴露 NodeDefinition 未声明的能力，并对已声明但未安装的绑定 fail closed。这个 registry 只服务自定义工作流语义；HTTP、数据库、消息等普通业务调用仍应走 DSH Tool。

节点实例可使用 `expects: { schema, maxBytes? }` 收窄 NodeDefinition 的通用输出。输出依次经过 lossless JSON、secret leak、definition output schema、实例 expectation 和大小限制，全部通过后才能进入 checkpoint。`expects.schema` 同时参与下游 binding 的静态 path/type 检查。

## 内置节点

- `core.start@1`：暴露并验证 Workflow 输入。
- `core.end@1`：组装一个终态输出对象。
- `core.condition@1`：使用固定 operator 选择 `true/false` 端口，不执行任意代码。
- `core.script@1`：通过版本化纯脚本 runtime 执行有界 JSON 变换；默认语言为 `dsh.expr@1`。
- `dsh.tool@1`：只能通过注入的 `WorkflowToolGateway` 执行工具。
- `dsh.agent@1`：通过 `WorkflowAgentGateway` 执行并收敛 foreground subagent。
- `dsh.human-approval@1`：通过 `WorkflowApprovalGateway` 获取 fail-closed 决策，并产生 `approved/rejected` 端口。
- `core.subworkflow@1`：执行 `with.templateId + revision` 指定的不可变发布版本。
- `core.foreach@1`：对 `inputs.items` 并行调用固定发布版本；child 标准输入为 `{ item, index, shared }`。

## `dsh.expr@1`

表达式只读取 `input`，必须返回 object。支持 JSON literal、成员/索引访问、`! - ?? || && == != === !== > >= < <= + - * / %` 和三元表达式。内置函数：

```text
len upper lower trim join split concat slice coalesce
string number boolean keys values get has
sum min max unique sort mapGet filterEq json parseJson format
```

运行时有 AbortSignal、操作数上限和 32 KiB source 上限；禁止动态函数调用、prototype key、I/O、时间、随机数与 `eval`。自定义确定性语言通过 `WorkflowScriptRuntimeRegistry` 注册，再将该 registry 传给 `registerCoreNodes(registry, { scriptRuntimes })`。

## 当前限制

- Core 提供内存 Run Store 接口实现；生产持久化由 SQLite provider 提供。
- 节点只执行一次；模板声明 `maxAttempts > 1` 会在编译期失败。
- 取消和 timeout 是协作式的，节点实现必须观察 `AbortSignal`。
- 生成 Skill 与 Canvas 分别由 `@gm-hz/dsh-dag-workflow-host` 和 `@gm-hz/dsh-dag-workflow-canvas` 提供，Core 不依赖 React/DSH Client。

这些限制对应总体架构中的 Phase 1-3，不会通过在 v0.1 中静默降级来伪装支持。
