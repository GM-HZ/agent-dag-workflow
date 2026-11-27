# Codex、Skill 与 MCP

核心原则是：有 CLI 就不启动 MCP；Workflow 多寡不应转化为常驻上下文成本。

## Codex Plugin

在现有 npm 项目根目录执行。`skill install` 会把包内的 Skill 安装到项目的 `.agents/skills`。同样的文件会被复用，已修改的 Skill 会保留。

```bash
npm install @gm-hz/agent-dag-workflow
npm exec --no -- adw skill install
npm exec --no -- adw doctor
```

从这个项目打开新的 Codex 会话。第一次可以输入 `用 $workflow-builder 运行内置订单示例，告诉我总金额和 Run ID`。预期总金额为 `100`。CLI 就从项目的 npm 安装中调用，Skill 按需读取。

从源码开发 Plugin 时，也可以安装本地 marketplace。

```bash
codex plugin marketplace add "$PWD/integrations/codex"
codex plugin add agent-dag-workflow@agent-dag-workflow-local
```

对发布过的流程，Skill 会用以下顺序发现并运行固定修订。

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

没有本地命令能力时，从现有项目启动固定 Gateway。用配置文件的绝对路径将它指向同一个项目，也可以先用 `--doctor` 核对数据库和执行身份。

```bash
npm exec --no -- agent-workflow-mcp --config "$PWD/.agent-dag-workflow.json" --doctor
npm exec --no -- agent-workflow-mcp --config "$PWD/.agent-dag-workflow.json" --profile invoke
```

在 MCP 客户端中配置命令时，命令、包和配置应指向同一个项目。从其他工作目录启动时，可直接在参数中指定包内 `lib/mcp-cli.js` 的绝对路径。显式使用 `--config` 后，默认执行身份与 CLI 一样是 `cli:local`。也可以在配置中设置 `authorityRef`，或使用 `--authority` 覆盖。没有 `--config` 的独立实例继续使用 `mcp:local` 默认身份。配置可以引用 JavaScript Host，只选用你信任的项目配置。

`invoke` 始终只有六个 Tool。Agent 先搜索并描述选中的 Workflow，再按需读取其 Schema；不会为每个流程注册新 MCP Tool。
