# 创作与发布 Workflow

Workflow 是可调用、可发布、可恢复的实体，不是一次性的 Agent Prompt。

## 从可运行的模板开始

按 [快速开始](./quickstart) 生成并跑通 `orders@1`。打开生成的 `workflow.json`，可以看到完整的输入与输出 Schema、固定的边，以及负责订单整理的 `normalize` 节点。先改 `input.json` 运行几次，再尝试调整 `normalize.with.source` 的汇总格式。完整字段见仓库的 `spec/workflow-template-v1.md`。

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

## 校验并发布一次修改

在快速开始创建的项目里修改 `workflow.json`，保持 `metadata.id` 为 `orders`。下面假设现有草稿修订是 `1`。

```bash
npm exec -- adw validate workflow.json --input input.json --strict
npm exec -- adw diff orders workflow.json
npm exec -- adw draft put workflow.json --expected 1
npm exec -- adw publish orders --expected 2
npm exec -- adw run orders@2 --input input.json
```

后续更新用 `draft get orders --view summary` 确认当前草稿修订，保存后以返回的修订运行 `publish`。已发布的 `orders@1` 仍可调用。Tool 名、子 Workflow 修订和依赖必须在模板中固定声明。

`validate` 只做检查。传 `--input input.json` 或 `--input-json '{}'` 时，还会检查输入与宿主能力。使用 `--strict` 时，错误返回非零退出码，适合脚本和 CI。可以通过 `--input -` 从 stdin 读取输入，或把模板文件设为 `-` 从 stdin 读取模板。

## 从不同目录打开同一个项目

CLI 从当前目录向上查找最近的 `.agent-dag-workflow.json`，到 Git 工作区根目录或文件系统根目录为止。若当前目录已有独立数据库且没有自己的配置，则保留该数据库。`--config` 可以从任何目录指定项目配置。配置文件里的相对路径以配置目录为准。

单独使用 `--db` 会选择该数据库并跳过自动查找。显式传入 `--config` 后，`--db`、`--host` 与 `--authority` 可以覆盖配置值，`--db` 和 `--host` 的相对路径仍以配置目录为准。自动发现的配置如果含 `hostModule`，需要用 `--config` 或 `--host` 显式选择后才会加载代码。`adw doctor` 会显示数据库、配置来源、宿主模块和执行身份。
