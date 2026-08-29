# Workflow Template v1 语义

状态：`v1alpha1` 已实现；未知 `apiVersion/kind` fail closed，不做静默 migration。

## Envelope

```yaml
apiVersion: workflow.gm-hz.dev/v1alpha1
kind: WorkflowTemplate
metadata:
  id: research-report
  name: Research report
  description: Research a topic and produce a structured report.
spec:
  requires: []
  inputSchema: {}
  outputSchema: {}
  nodes: []
  edges: []
  outputs: {}
  policies: {}
layout: {}
```

`metadata.id` 是 lower-kebab-case 稳定标识。draft revision、published revision、content hash、created/updated time 由 catalog store 管理，不允许 Agent 在文档中伪造。

## Requires

`spec.requires` 是 Workflow revision 的不可变依赖 allowlist：

```yaml
requires:
  - { kind: capability, uses: gateway.tool.execute }
  - { kind: tool, uses: dms.query }
  - { kind: capability, uses: gateway.agent.execute }
  - { kind: script-runtime, uses: json.expr@1 }
  - { kind: workflow, uses: normalize-result@3 }
```

- NodeDefinition 的 `capabilities` 和 `dependencies(config)` 由编译器自动解析；任一 `kind:uses` 未声明时产生 `WORKFLOW_REQUIREMENT_UNDECLARED`。
- 同一依赖不能重复。Tool name、runtime 和 subworkflow revision 必须来自固定 config，不能由运行输入动态改写。Agent 节点使用 Launch 时解析出的 Authority，模板不选择底层执行实现。
- `requires` 只收窄可调用范围，不授予任何权限。实际调用仍必须同时满足 Authority、部署策略与具体 Host Tool/Node policy。
- Engine 按 NodeDefinition `capabilities` 裁剪内置 gateway，并为自定义 Node 创建 scoped `context.capabilities`；未声明的 capability 不可见，声明但 Host 未安装也会 fail closed。
- 第三方 NodeDefinition 是受信任代码；闭包中的宿主级 ambient authority 仍需由插件审计或进程 sandbox 约束。

## 外部扩展的两级模型

1. 普通外部能力必须注册为 Host Tool，并统一使用 `tool.call@1`。Tool name 固定在 `with.uses`，输入来自结构化 binding，执行继续经过 Host scope、guard、credential、observer 与 output validation。Canvas 中每个当前 Authority 可见的 Tool 只是这个通用节点的一个 catalog 条目，不产生新的运行时类型。
2. 只有单次 JSON Tool 调用无法表达的暂停恢复、长任务 checkpoint、事务补偿或特殊控制流，才能注册自定义 `WorkflowNodeDefinition`。它可以通过 Host `WorkflowCapabilityRegistry` 绑定生命周期服务，但必须在 definition 和 `spec.requires` 中使用同一个 capability id。

不存在第三种 Tool-backed Node Preset 执行层。脚本 runtime 是内置 `core.script@1` 的纯数据实现细节，也不能用于绕开 Tool policy。

## Node

```yaml
- id: summarize
  uses: agent.run@1
  title: Summarize evidence
  with:
    prompt: Produce a concise evidence-based summary.
    outputSchema:
      type: object
      required: [report]
      properties:
        report: { type: string }
  inputs:
    topic:
      input: { path: [topic] }
    evidence:
      output:
        nodeId: collect
        path: [items]
  expects:
    maxBytes: 1048576
    schema:
      type: object
      required: [runId, content, structured]
      properties:
        runId: { type: string }
        content: { type: array }
        structured:
          type: object
          required: [report]
          properties:
            report: { type: string }
  policy:
    timeoutMs: 120000
    retry:
      maxAttempts: 1
```

- `id` 在模板内唯一且稳定，不使用 Canvas 顺序作为身份。
- `uses` 必须是精确的 `type@integer-version`。draft 可以经显式 migration 升级，published revision 不做运行时静默迁移。
- `with` 由节点定义的 `configSchema` 校验。
- `inputs` 的每个值是 binding；它必须满足节点 `inputSchema`。
- `policy` 只能收紧 deployment/NodeDefinition 上限，不能提升权限或资源额度。
- `expects.schema` 在 NodeDefinition `outputSchema` 之后校验完整节点输出，`expects.maxBytes` 只能进一步收紧 workflow 上限。校验通过前输出不能写入 checkpoint；该 Schema 也用于下游 binding 的静态 path/type 检查。

## Binding

Binding 是以下结构之一：

```yaml
literal: any-json-value
```

```yaml
input:
  path: [field, nestedField, 0]
```

```yaml
output:
  nodeId: upstreamNodeId
  path: [field, nestedField, 0]
```

`output.nodeId` 不仅必须是当前节点的严格上游，还必须支配 consumer 或被证明为全局必达。这样既允许无条件并行 fan-out 的结果汇合，也拒绝分支局部数据直接跨 OR-join；后者必须先由显式、确定性的汇合语义标准化。`path` 是 string/integer 数组，不解析点号字符串。

Secret 不属于 JSON 数据面，因此 Binding 不支持 `secret`。需要凭据的可信外部节点只能在静态 `with` 中保存 `credentialRef`/`connectionRef` 等不透明引用，由 Host Gateway 在调用最后一刻解析；明文值不能进入普通节点输入、Event、Checkpoint 或 Artifact。

Binding 自身不提供表达式：它只负责把 workflow input、上游 output 或 literal 精确送入节点。确定性派生逻辑应显式建模为 `core.script@1` 节点，禁止在 binding 中夹带模板代码或 JS。

## 确定性脚本节点

```yaml
- id: normalize
  uses: core.script@1
  with:
    language: json.expr@1
    maxOperations: 10000
    source: |-
      {
        customer: upper(trim(input.customer)),
        total: sum(mapGet(input.orders, "amount"))
      }
  inputs:
    customer: { input: { path: [customer] } }
    orders: { input: { path: [orders] } }
```

- `language` 必须是精确的 `language@integer-version`，并在当前 Runtime 的 `WorkflowScriptRuntimeRegistry` 中可解析。
- 编译器先执行 runtime `validate(source)`；语法或业务规则错误产生 `NODE_CONFIG_SEMANTIC_INVALID`。
- runtime 只能接收节点 inputs、AbortSignal 和 `maxOperations`，输出必须是一个 lossless JSON object。
- 内置 `json.expr@1` 是纯表达式 DSL，不是 JavaScript；禁止 I/O、动态调用、prototype key、时间和随机数。
- 第三方 runtime 是受信任部署扩展点。模板的声明不能给 runtime 新增 Authority；需要外部系统或 Secret 时必须使用 Host Tool/自定义节点，并只传递不透明引用。

## 动态结果的两级校验

1. Core 确定性边界：lossless JSON、NodeDefinition output schema、节点 `expects`、端口和字节上限。全部通过后才允许 Artifact capture，并把 capability 完成事件与节点输出原子提交。
2. 可选 Agent 语义复核：作为显式 `agent.run@1` 节点，并为其结构化判断声明 `outputSchema/expects`。

Agent 复核是业务判断，不是权限授予，也不能替代第一层。外部数据即使被 Agent 判断为合法，后续动态调用仍需重新满足 `requires + Authority + Host policy`。

## Edge

```yaml
- id: collect-to-summarize
  source: collect
  target: summarize
  sourcePort: success
```

`sourcePort` 只对多出口节点有意义。普通节点使用隐式 `success`。编译器拒绝 dangling edge、重复 edge id、普通回边和未知 port。

## Outputs

```yaml
outputs:
  report:
    output:
      nodeId: end
      path: [report]
```

输出 binding 必须来自全路径必达的终态节点，并满足 `outputSchema`。多个 end 节点仍可存在，但被 Workflow 输出引用的 End 必须被编译器证明在每条成功路径上执行；无法证明时拒绝发布。

## Policies

```yaml
policies:
  maxConcurrentNodes: 4
  maxNodeRuns: 100
  maxDurationMs: 600000
  maxOutputBytes: 1048576
  subworkflowMaxDepth: 8
```

模板值只能低于等于 Host 注入的 `WorkflowDeploymentLimits`。Catalog 发布时校验，执行器和恢复路径再次取 `min(template/default, deployment)`，防止 inline 或历史模板提升资源额度。累计持久状态的 `maxCheckpointBytes` 只由 Host 配置，不是模板 policy，避免模板用大量合法的单节点输出耗尽 Store。

## Layout

```yaml
layout:
  canvas:
    positions:
      start: { x: 0, y: 120 }
      collect: { x: 320, y: 120 }
      summarize: { x: 640, y: 120 }
```

`layout` 不参与 semantic hash，也不进入 executable IR。未知 layout 字段按 layout schema/version 处理，不能影响运行结果。

## 嵌套与人工节点约定

- `workflow.call@1.with` 必须包含 `{ templateId, revision }`；`inputs` 直接作为 child workflow inputs，输出为 `{ runId, outputs }`。
- `core.foreach@1.with` 必须包含 `{ templateId, revision }`，可选 `maxConcurrency/maxItems`；节点输入是 `{ items, shared? }`，每个 child 收到 `{ item, index, shared }`，节点输出是按原 index 排序的 `{ results: [{ index, runId, outputs }] }`。
- subworkflow/foreach 只解析精确 published revision。Catalog publish 校验版本存在、依赖无环和继承后的最大深度；运行时把有效 depth ceiling 写入每个 child checkpoint。
- 每个 child invocation id 由 parent run/node/item index 稳定派生。同一 invocation 必须绑定同一模板 semantic hash、inputs 和 depth；冲突 fail loud。
- foreach checkpoint 保存每个 item 的 `pending/running/completed` frame。崩溃后 running item 恢复同一 child run，不创建第二个副作用执行。
- `human.approval@1.with` 必须包含 `{ action, reason }`；任意 `inputs` 作为只读详情。节点在调用 approval seam 前提交 `waiting` checkpoint，结果走 `approved/rejected` 端口。
- `agent.run@1.with` 必须包含 `{ prompt }`，可选 `outputSchema/tools/skills`；它使用当前 Launch Authority，输入以稳定 JSON 附加到 prompt，输出为 `{ runId, content, structured? }`。

## 发布校验

发布至少执行：

1. Envelope schema 与 lossless JSON 检查。
2. ID、edge、start/end、DAG 与 container topology 检查。
3. `uses` 精确解析与 NodeDefinition availability 检查。
4. Node config/input/output/expectation schema 与 definition 语义检查，包括 script runtime/source availability。
5. NodeDefinition capability、固定 resource 与 `spec.requires` 完整性检查。
6. Binding 必填项、workflow input、上游性、field path 与可静态判定的 JSON Schema 类型兼容检查；不确定的开放 schema 保留到运行时 validator。
7. Branch port 完整性与每条成功路径 output 可物化检查。
8. Subworkflow revision 存在、依赖无环、深度上限检查。
9. `credentialRef`/`connectionRef` 等不透明引用只在 Host Gateway 内解析；Core 不读取或保存 Secret value。
10. Template policy 不高于 deployment ceiling 检查。
11. Semantic hash 与 content hash 计算。

诊断使用稳定 code，并尽可能携带 `nodeId` 与 `path`。生成 skill 只自动修复唯一确定的结构问题；未知插件、歧义引用和副作用策略必须由用户或 Agent 明确决策。
