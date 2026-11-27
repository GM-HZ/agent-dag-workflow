# 5 分钟快速开始

用 npm 包自带的订单整理 Workflow 完成第一次运行。这份示例用固定输入处理三笔订单，无需模型账号或外部 Tool。

## 1. 运行内置示例

需要 Node.js 22.19 或更新版本。可以在任意有写权限的目录运行这条命令。

```bash
npx --package @gm-hz/agent-dag-workflow adw demo
```

如果项目已经通过 `npm install @gm-hz/agent-dag-workflow` 装好了包，直接用本地 CLI。

```bash
npm exec -- adw demo
```

输出的 `data.status` 为 `completed`，`data.outputs` 会显示客户 `GM-HZ`、三笔订单、总金额 `100` 和已批准的订单 ID。示例只在 SQLite 里记录一次运行及其轨迹。默认数据库是当前目录下的 `.agent-dag-workflow.db`，用 `--db` 可以选择其他文件。

## 2. 运行自己的订单流程

用同一个 npm 包创建可编辑的 Workflow 和输入。`init` 会创建新目录，不覆盖已有项目。

```bash
npx --package @gm-hz/agent-dag-workflow adw init orders-workflow
cd orders-workflow
npm init -y
npm install @gm-hz/agent-dag-workflow

npm exec -- adw doctor
npm exec -- adw validate workflow.json --input input.json --strict
npm exec -- adw draft put workflow.json
npm exec -- adw publish orders --expected 1
npm exec -- adw run orders@1 --input input.json
```

第一次执行会得到 `orders@1` 的运行结果。改 `input.json` 里的客户或订单后，直接再次调用 `orders@1`。改流程逻辑时才需要保存草稿和发布新修订。生成的 `.agent-dag-workflow.json` 固定项目数据库路径，子目录里的命令也可以找到同一个数据库。

## 3. 找回运行并导出日志

忘记 Run ID 时，用 `runs` 查看最近的运行。历史和轨迹查询使用同一个数据库及执行身份。

```bash
npm exec -- adw runs --workflow orders --format table
npm exec -- adw trace --latest --workflow orders --events
```

需要追查某一次运行时，从结果复制 `data.runId`。如果指定了 `--db`，查询时也用同一个数据库。

```bash
npm exec -- adw trace RUN_ID --events
```

如果只运行了第一步的 `demo`，用原目录里的 `npx --package @gm-hz/agent-dag-workflow adw runs --workflow script-transform-demo` 找回运行。`demo` 输出的 `data.traceCommand` 也包含实际 Run ID 和数据库路径。

完整导出用 `--all`。JSONL 的第一行是运行快照，之后按序记录截至导出开始时已提交的所有 Journal 事件。运行完成、失败、取消或暂停都可以导出。

```bash
npm exec -- adw trace RUN_ID --all --output run.jsonl
```

## 下一步

- 让 Codex 自动发现和运行工作流，参考 [Codex / Skill](./codex)。
- 创建自己的流程并发布以供重复调用，参考 [创作与发布](./authoring)。
- 将已发布的流程设为定时任务，参考 [个人定时任务](../operations#个人定时任务)。
- 接入 Tool 或 Agent，参考 [Host Adapter](../host-adapter)。
- 试用审批、并行调用等能力，查看 [9 个可执行示例](../examples/)。
