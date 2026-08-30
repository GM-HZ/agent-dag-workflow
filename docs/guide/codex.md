# Codex、Skill 与 MCP

核心原则是：有 CLI 就不启动 MCP；Workflow 多寡不应转化为常驻上下文成本。

## Codex Plugin

源码仓库中的 Plugin 同时携带按需 `workflow-builder` Skill 和 CLI wrapper：

```bash
codex plugin marketplace add "$PWD/integrations/codex"
codex plugin add agent-dag-workflow@agent-dag-workflow-local
```

新会话命中 Workflow 任务后，Skill 才会指导 Codex 使用：

```text
search → describe(schema) → run(exact revision) → run-get / trace
```

Skill 不包含另一套执行逻辑，也不会把完整 Catalog 塞进上下文。

## 完整 Codex 访问回归

仓库内 9 个 Example 会经过真实 Plugin wrapper：

```bash
pnpm examples:codex
```

回归同时覆盖创作和调用路径：

```text
validate → draft put → publish
→ search → describe → run → run-get → trace
```

确定性 Host 不联网，适合 CI。它验证的是 Plugin/Skill 使用的访问契约，不把随机模型质量伪装成稳定测试。

## MCP-only Agent

没有本地命令能力时启动一个固定 Gateway：

```bash
agent-workflow-mcp --db workflows.db --profile invoke
```

`invoke` 始终只有六个 Tool。Agent 先搜索并描述选中的 Workflow，再按需读取其 Schema；不会为每个流程注册新 MCP Tool。
