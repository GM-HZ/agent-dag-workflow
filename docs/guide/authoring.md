# 创作与发布 Workflow

Workflow 是可调用、可发布、可恢复的实体，不是一次性的 Agent Prompt。

## 最小 Envelope

```json
{
  "apiVersion": "workflow.gm-hz.dev/v1",
  "kind": "WorkflowTemplate",
  "metadata": { "id": "my-flow", "name": "My flow" },
  "spec": {
    "inputSchema": { "type": "object" },
    "outputSchema": { "type": "object" },
    "nodes": [],
    "edges": [],
    "outputs": {}
  }
}
```

完整字段以仓库的 `spec/workflow-template-v1.md` 为准。

## 节点选择

| 需求 | 使用 |
| --- | --- |
| 纯 JSON map/filter/sort | `core.script@1` |
| 选择静态分支 | `core.condition@1` |
| 每项调用外部能力 | `core.foreach@1` |
| 调用 Host Tool | `tool.call@1` |
| 调用 Host Agent | `agent.run@1` |
| 等待人工决定 | `human.approval@1` |
| 复用固定流程修订 | `workflow.call@1` |

Script 没有网络、文件、环境变量、密钥或 `eval`。外部结果必须声明 `expects`，并在进入 Journal 前完成 Schema 校验。

## 安全发布顺序

```bash
adw nodes search
adw validate my-flow.workflow.yaml
adw draft put my-flow.workflow.yaml
adw diff my-flow my-flow.workflow.yaml
adw publish my-flow --expected <draftRevision>
```

草稿使用 CAS revision；发布修订不可变。Tool 名、子 Workflow revision 和依赖必须在模板中固定声明。
