# Workflow Template v1 语义

状态：`v1alpha1` 设计草案。

## Envelope

```yaml
apiVersion: dsh.workflow/v1alpha1
kind: WorkflowTemplate
metadata:
  id: research-report
  name: Research report
  description: Research a topic and produce a structured report.
spec:
  inputSchema: {}
  outputSchema: {}
  nodes: []
  edges: []
  outputs: {}
  policies: {}
layout: {}
```

`metadata.id` 是 lower-kebab-case 稳定标识。draft revision、published revision、content hash、created/updated time 由 catalog store 管理，不允许 Agent 在文档中伪造。

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
  policy:
    timeoutMs: 120000
    retry:
      maxAttempts: 1
```

- `id` 在模板内唯一且稳定，不使用 Canvas 顺序作为身份。
- `uses` 必须是精确的 `type@integer-version`。draft 可以经显式 migration 升级，published revision 不做运行时静默迁移。
- `with` 由节点定义的 `configSchema` 校验。
- `inputs` 的每个值是 binding；它必须满足节点 `inputSchema`。
- `policy` 只能收紧 deployment/node provider 上限，不能提升权限或资源额度。

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

首版不提供任意 binding expression。条件逻辑只存在于 `core.condition@1` 的受限 config schema 中，禁止模板执行 JS。

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
  engine: xyflow
  viewport: { x: 0, y: 0, zoom: 0.9 }
  nodes:
    start: { x: 0, y: 120 }
    collect: { x: 320, y: 120 }
    summarize: { x: 640, y: 120 }
```

`layout` 不参与 semantic hash，也不进入 executable IR。未知 layout 字段按 layout schema/version 处理，不能影响运行结果。

## 发布校验

发布至少执行：

1. Envelope schema 与 lossless JSON 检查。
2. ID、edge、start/end、DAG 与 container topology 检查。
3. `uses` 精确解析与 node provider availability 检查。
4. Node config/input/output schema 检查。
5. Binding 上游性、field path 与类型兼容检查。
6. Branch port 完整性与每条成功路径 output 可物化检查。
7. Subworkflow revision 存在、依赖无环、深度上限检查。
8. Secret reference 可解析性检查，但不读取或保存 secret value。
9. Template policy 不高于 deployment ceiling 检查。
10. Semantic hash 与 content hash 计算。

诊断使用稳定 code，并尽可能携带 `nodeId` 与 `path`。生成 skill 只自动修复唯一确定的结构问题；未知插件、歧义引用和副作用策略必须由用户或 Agent 明确决策。
