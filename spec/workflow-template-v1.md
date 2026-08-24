# Workflow Template v1 语义

状态：`v1alpha1` 已实现；未知 `apiVersion/kind` fail closed，不做静默 migration。

## Envelope

```yaml
apiVersion: dsh.workflow/v1alpha1
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
  - { kind: capability, uses: dsh.tools.execute }
  - { kind: tool, uses: dms.query }
  - { kind: capability, uses: dsh.subagents.start }
  - { kind: agent-provider, uses: general-purpose }
  - { kind: script-runtime, uses: dsh.expr@1 }
  - { kind: secret, uses: credential:analytics-readonly }
  - { kind: workflow, uses: normalize-result@3 }
```

- NodeDefinition 的 `capabilities` 和 `dependencies(config)`、以及 secret binding 都由编译器自动解析；任一 `kind:uses` 未声明时产生 `WORKFLOW_REQUIREMENT_UNDECLARED`。
- 同一依赖不能重复。Tool name、Agent provider、runtime 和 subworkflow revision 必须来自固定 config，不能由运行输入动态改写。
- `requires` 只收窄可调用范围，不授予任何权限。实际调用仍必须同时满足 owning Agent scope、部署策略与具体 DSH Tool/Node policy。
- Engine 按 NodeDefinition `capabilities` 裁剪内置 gateway，并为自定义 Node 创建 scoped `context.capabilities`；未声明的 capability 不可见，声明但 Host 未安装也会 fail closed。
- 第三方 NodeDefinition 是受信任代码；闭包中的宿主级 ambient authority 仍需由插件审计或进程 sandbox 约束。

## 外部扩展的两级模型

1. 普通外部能力必须注册为 DSH Tool，并统一使用 `dsh.tool@1`。Tool name 固定在 `with.name`，输入来自结构化 binding，执行继续经过 DSH scope、guard、credential、observer 与 output validation。Canvas 中每个 scope-visible Tool 只是这个通用节点的一个 catalog 条目，不产生新的运行时类型。
2. 只有单次 JSON Tool 调用无法表达的暂停恢复、长任务 checkpoint、事务补偿或特殊控制流，才能注册自定义 `WorkflowNodeDefinition`。它可以通过 Host `WorkflowCapabilityRegistry` 绑定生命周期服务，但必须在 definition 和 `spec.requires` 中使用同一个 capability id。

不存在第三种 Tool-backed Node Provider/Node Preset 执行层。脚本 runtime 是内置 `core.script@1` 的纯数据实现细节，也不能用于绕开 Tool policy。

## Node

```yaml
- id: summarize
  uses: dsh.agent@1
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
      input: topic
    evidence:
      output:
        node: collect
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
input: workflowInputName
```

```yaml
output:
  node: upstreamNodeId
  path: [field, nestedField, 0]
```

```yaml
secret:
  ref: CREDENTIAL_REFERENCE
```

`output.node` 必须是当前节点的严格上游。`path` 是 string/integer 数组，不解析点号字符串。secret 只存 reference；值由执行时 credentials provider 解析，永不写入模板、event 或 checkpoint。

Binding 自身不提供表达式：它只负责把 workflow input、上游 output、literal 或 secret 精确送入节点。确定性派生逻辑应显式建模为 `core.script@1` 节点，禁止在 binding 中夹带模板代码或 JS。

## 确定性脚本节点

```yaml
- id: normalize
  uses: core.script@1
  with:
    language: dsh.expr@1
    maxOperations: 10000
    source: |-
      {
        customer: upper(trim(input.customer)),
        total: sum(mapGet(input.orders, "amount"))
      }
  inputs:
    customer: { input: customer }
    orders: { input: orders }
```

- `language` 必须是精确的 `language@integer-version`，并在当前 Host scope 的 `ctx.workflowScripts` 中可解析。
- 编译器先执行 runtime `validate(source)`；语法或业务规则错误产生 `NODE_CONFIG_SEMANTIC_INVALID`。
- runtime 只能接收节点 inputs、AbortSignal 和 `maxOperations`，输出必须是一个 lossless JSON object。
- 内置 `dsh.expr@1` 是纯表达式 DSL，不是 JavaScript；禁止 I/O、动态调用、prototype key、时间和随机数。
- 第三方 runtime 是受信任插件扩展点。模板的声明不能给 runtime 新增 authority；需要外部系统或 secret 时必须使用相应 DSH 节点。

## 动态结果的两级校验

1. Core 确定性边界：lossless JSON、secret leak、NodeDefinition output schema、节点 `expects`、字节上限。
2. 可选 Agent 语义复核：作为显式 `dsh.agent@1` 节点，并为其结构化判断声明 `outputSchema/expects`。

Agent 复核是业务判断，不是权限授予，也不能替代第一层。外部数据即使被 Agent 判断为合法，后续动态调用仍需重新满足 `requires + owning Agent scope + DSH policy`。

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
      node: end
      path: [report]
```

输出 binding 必须来自可到达的终态节点，并满足 `outputSchema`。多个 end 节点可支持分支终止，但每条成功路径必须能物化合法输出。

## Policies

```yaml
policies:
  maxConcurrentNodes: 4
  maxNodeRuns: 100
  maxDurationMs: 600000
  maxOutputBytes: 1048576
  subworkflowMaxDepth: 8
```

模板值只能低于等于 deployment ceiling。执行器在完整结果可知的位置应用 size/time/count 上限。

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

- `core.subworkflow@1.with` 必须包含 `{ templateId, revision }`；`inputs` 直接作为 child workflow inputs，输出为 `{ runId, outputs }`。
- `core.foreach@1.with` 必须包含 `{ templateId, revision }`，可选 `maxConcurrency/maxItems`；节点输入是 `{ items, shared? }`，每个 child 收到 `{ item, index, shared }`，节点输出是按原 index 排序的 `{ results: [{ index, runId, outputs }] }`。
- subworkflow/foreach 只解析精确 published revision。Catalog publish 校验版本存在、依赖无环和继承后的最大深度；运行时把有效 depth ceiling 写入每个 child checkpoint。
- 每个 child invocation id 由 parent run/node/item index 稳定派生。同一 invocation 必须绑定同一模板 semantic hash、inputs 和 depth；冲突 fail loud。
- foreach checkpoint 保存每个 item 的 `pending/running/completed` frame。崩溃后 running item 恢复同一 child run，不创建第二个副作用执行。
- `dsh.human-approval@1.with` 必须包含 `{ action, reason }`；任意 `inputs` 作为只读详情。节点在调用 approval seam 前提交 `waiting` checkpoint，结果走 `approved/rejected` 端口。
- `dsh.agent@1.with` 必须包含 `{ provider, prompt }`，可选 `label/outputSchema/maxDepth`；输入以稳定 JSON 附加到 prompt，输出为 `{ runId, content, structured? }`。

## 发布校验

发布至少执行：

1. Envelope schema 与 lossless JSON 检查。
2. ID、edge、start/end、DAG 与 container topology 检查。
3. `uses` 精确解析与 NodeDefinition availability 检查。
4. Node config/input/output/expectation schema 与 definition 语义检查，包括 script runtime/source availability。
5. NodeDefinition capability、固定 resource、secret binding 与 `spec.requires` 完整性检查。
6. Binding 必填项、workflow input、上游性、field path 与可静态判定的 JSON Schema 类型兼容检查；不确定的开放 schema 保留到运行时 validator。
7. Branch port 完整性与每条成功路径 output 可物化检查。
8. Subworkflow revision 存在、依赖无环、深度上限检查。
9. Secret reference 可解析性检查，但不读取或保存 secret value。
10. Template policy 不高于 deployment ceiling 检查。
11. Semantic hash 与 content hash 计算。

诊断使用稳定 code，并尽可能携带 `nodeId` 与 `path`。生成 skill 只自动修复唯一确定的结构问题；未知插件、歧义引用和副作用策略必须由用户或 Agent 明确决策。
