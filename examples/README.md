# Executable Workflow Examples

`manifest.json` 是示例目录的唯一清单。每个条目绑定当前 v1 Workflow、可复现输入、期望输出子集、固定发布修订和确定性 Host。模板仍保留原路径，避免破坏已有链接。

完整 Codex Plugin 访问回归：

```bash
pnpm examples:codex
```

该命令使用真实 Plugin wrapper，逐个完成：

```text
validate → draft put → publish → search → describe(schema)
→ run(exact revision) → run-get → trace(events)
```

默认数据库是执行期间创建并清理的测试库。如需保留权威 Journal 以便手工检查：

```bash
pnpm examples:codex -- --db output/example-regression.db --keep
adw trace <runId> --events --db output/example-regression.db \
  --host examples/deterministic-host.mjs
```

`deterministic-host.mjs` 只提供示例清单声明的 Tool、Agent 和 Approval fixture，不访问网络、文件、凭据或真实外部系统。它用于契约回归，不代表真实业务结果。

单独运行 AI 模型周报仍可使用：

```bash
pnpm example:weekly
```
