# 先选入口

你不需要先理解完整架构。根据当前环境选择一条入口，所有入口最终调用同一个 `WorkflowRuntime`。

| 你的环境 | 首选入口 | 原因 |
| --- | --- | --- |
| 本地终端、Codex、CI | `adw` CLI | 零常驻上下文，契约最完整 |
| 只能使用 MCP 的 Agent | 固定 MCP Gateway | Workflow 数量不会增加 MCP Tool 数量 |
| DeepSeek Harness | DSH Plugin | 复用 Session、Tool、Agent、Skill 与 Canvas |
| 应用代码 | TypeScript SDK | 直接嵌入 Runtime 与 Store |
| Cron、Webhook、消息平台 | Trigger Binding | 外部协议不进入 DAG 图 |

第一次使用建议直接进入 [5 分钟快速开始](./quickstart)。

## 不需要先学习的内容

- 不需要建立模型 Provider；
- 不需要为每个 Workflow 启动一个 MCP Server；
- 不需要把 Tool 实现在 Workflow 节点里；
- 不需要理解 Worker，除非部署环境需要后台恢复；
- 不需要使用 Canvas 才能运行 JSON Workflow。
