# @gm-hz/agent-dag-workflow/core

与宿主无关的 DAG 编译与执行内核。它提供节点注册、模板诊断、结构化 Binding、并发调度、Checkpoint、Journal 和恢复；不依赖 DSH、Cordis、React 或任何模型 Provider。

应用通常应使用 `@gm-hz/agent-dag-workflow/runtime` 的 `WorkflowRuntime`。直接使用 Engine 只适合实现新的 Runtime 或嵌入式宿主：

```ts
import {
  DagWorkflowEngine,
  InMemoryWorkflowRunStore,
  parseWorkflowTemplate,
  registerCoreNodes,
  WorkflowNodeRegistry,
} from '@gm-hz/agent-dag-workflow/core'

const nodes = new WorkflowNodeRegistry()
registerCoreNodes(nodes)

const store = new InMemoryWorkflowRunStore()
const engine = new DagWorkflowEngine(nodes, {
  tools: {
    async execute(request) {
      // Host 在自己的权限、审计和凭据边界内执行已声明 Tool。
      return hostTools.execute(request.uses, request.inputs, request.authority)
    },
  },
}, { runStore: store })

const template = parseWorkflowTemplate(source)
const run = await engine.start({
  template,
  inputs: { message: 'hello' },
  execution: {
    authorityRef: 'user:42',
    authority: currentAuthority,
    origin: { type: 'sdk' },
  },
})
const result = await run.result
```

## 两级扩展

普通外部能力统一使用 `tool.call@1`，由 Host 的 `WorkflowToolGateway` 连接已有 Tool、MCP、Skill 包装器或受控本地命令。只有需要自定义生命周期、端口或恢复语义时才注册 `WorkflowNodeDefinition`。

自定义节点用 `capabilities + dependencies(config)` 声明能力，模板用 `spec.requires` 精确 allowlist。执行时 `context.capabilities` 只投影该定义声明的能力；未声明或未安装一律 fail closed。这个 Resolver 不是另一套 Provider/Tool Bus。

`expects: { schema, maxBytes? }` 可以进一步收窄节点实例输出。输出通过 lossless JSON、NodeDefinition Schema、实例 Schema 和大小限制后，才会原子提交到 Checkpoint。Secret 明文从设计上不得进入数据面，最终脱敏仍是 Host Gateway 的责任。

## 内置节点

- `core.start@1`：暴露并验证 Workflow 输入。
- `core.end@1`：组装终态输出。
- `core.condition@1`：用固定 operator 选择 `true/false` 端口。
- `core.script@1`：执行有界、确定性的纯 JSON 变换；默认语言为 `json.expr@1`。
- `tool.call@1`：通过 `WorkflowToolGateway` 调用一个精确声明的 Tool。
- `agent.run@1`：通过 `WorkflowAgentGateway` 执行 Agent，并校验结构化结果。
- `human.approval@1`：通过 `WorkflowApprovalGateway` 获取 fail-closed 决策。
- `workflow.call@1`：调用固定发布修订的子 Workflow。
- `core.foreach@1`：按有界并发调用固定子 Workflow；标准输入为 `{ item, index, shared }`。

## `json.expr@1`

表达式只读取 `input`，必须返回 object。它支持 JSON literal、成员/索引访问、有限运算符和以下纯函数：

```text
len upper lower trim join split concat slice coalesce
string number boolean keys values get has
sum min max unique sort sortBy withIndex joinBy mapGet filterEq json parseJson format
```

`sortBy` 提供稳定多键排序；`withIndex` 生成确定序号；`joinBy` 要求 overlay 与 base 的 key 一一对应且不能覆盖原字段。运行时限制操作数和 source 大小，并禁止 I/O、时间、随机数、prototype key、动态函数与 `eval`。

## 边界

- Memory Store 用于测试和单进程嵌入；持久运行使用 `./sqlite` 或 Host Store。
- 节点 timeout 和取消是协作式的，Gateway/Node 必须观察 `AbortSignal`。
- 外部副作用的 exactly-once 不能由 DAG 单独保证；Gateway 应使用稳定 `invocationId` 幂等，并对未知结果进入人工处理。
- UI、DSH、CLI、MCP 和 Trigger 都位于 Adapter 层，不属于 Core。
