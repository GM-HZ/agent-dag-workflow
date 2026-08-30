# Showcase workflows

这些示例不是截图用的假流程，而是与 Runtime、Agent 工具和 Canvas 共用同一个 `WorkflowTemplate` 的可编译模板。它们刻意把不确定逻辑交给 Agent，把外部能力交给 Host Tool，把可重复决策交给受限脚本，并在模板顶层声明全部依赖。

| 场景 | 模板 | 展示的核心能力 |
| --- | --- | --- |
| AI 模型周报 | [`weekly-ai-model-news.workflow.json`](https://github.com/GM-HZ/agent-dag-workflow/blob/main/examples/weekly-ai-model-news.workflow.json) | Host `web_search` 13 路并行检索、最多 100 条候选、Agent 评分 overlay、`joinBy` 防篡改合并、稳定 Top 10、结构化摘要 |
| 生产发布门禁 | [`secure-release-guardian.workflow.yaml`](https://github.com/GM-HZ/agent-dag-workflow/blob/main/examples/secure-release-guardian.workflow.yaml) | 并行架构/安全 Agent、确定性最高风险聚合、条件分支、一次性人工授权、完整审计链 |
| 批量合同审查 | [`batch-contract-review.workflow.yaml`](https://github.com/GM-HZ/agent-dag-workflow/blob/main/examples/batch-contract-review.workflow.yaml) + [`contract-clause-review-worker.workflow.yaml`](https://github.com/GM-HZ/agent-dag-workflow/blob/main/examples/contract-clause-review-worker.workflow.yaml) | 固定发布版本的子 Workflow、并发 `foreach`、逐项持久化 frame、崩溃恢复、汇总 Agent |
| 多源尽调 | [`multi-source-due-diligence.workflow.yaml`](https://github.com/GM-HZ/agent-dag-workflow/blob/main/examples/multi-source-due-diligence.workflow.yaml) | Agent 查询规划、三路 `web_search`、不可信内容隔离、证据 Schema、确定性排序、带引用报告 |

## 与 Coze / Dify 工作流的共同点

- 可视化 DAG、节点目录、输入输出绑定、条件分支、批处理、运行轨迹。
- Agent、Tool、脚本和人工节点可以组合成可复用模板。
- 草稿、校验、差异、发布和运行形成完整创作闭环。

## Agent DAG 的差异点

1. **能力先声明**：`spec.requires` 是 allowlist。节点只能取得模板声明且当前 Authority 本来就有权使用的 Tool、审批动作、脚本 Runtime 或子 Workflow。
2. **外部调用不藏进脚本**：`core.script@1` 只变换 JSON，没有网络、文件、时间、随机数、密钥或 `eval`。外部能力始终走 Host Tool/Agent Gateway，Journal 不会出现旁路。
3. **Agent 输出先过 Schema**：Agent 只负责语义判断，输出必须满足节点的 `outputSchema` 和 `expects`；排序、合并、截断等关键规则再由确定性脚本完成。
4. **恢复不是重新开始**：SQLite checkpoint、节点事件、审批 waiting 状态和 foreach item frame 都持久化。恢复时不会盲目重放已经提交的副作用。
5. **组合固定版本**：子 Workflow 引用 `templateId@revision`，避免上游模板更新后静默改变生产行为。

## 使用方式

先完成构建和模板校验：

```bash
pnpm install
pnpm build
pnpm test
```

在 Canvas 中导入模板时，先通过 `校验` 查看依赖声明是否完整。批量合同示例固定引用 `contract-clause-review-worker` revision 2，需要先发布该 revision，再发布并运行父模板。外部 Tool 名称由 Host 提供；模板不会自动扩大当前 Authority 的权限。

也可以把整套 Showcase 作为草稿一键装入本机 DSH（脚本会自动准备批量合同示例依赖的 worker revision 2）：

```bash
pnpm showcase:install
```

默认数据库是 `~/.dsh/agent-dag-workflow/workflows.db`；验证隔离数据库时可传入 `--db`：

```bash
pnpm showcase:install -- --db /absolute/path/to/workflows.db
```

## 运行 AI 模型周报

该模板需要 Host 提供 `web_search` Tool。它不是 Workflow 自己实现的 Provider：13 个检索节点都通过通用 `tool.call@1` 调用 Host Tool，模板只声明精确依赖。

不接外部网络也可以用一条命令验证完整 DAG。示例驱动器会使用持久化 SQLite，依次完成模板校验、草稿安装、不可变 revision 发布、运行，并打印结果和读取完整 Trace 的命令：

```bash
pnpm example:weekly
```

默认数据写入当前目录的 `.agent-dag-workflow.db`，不会创建一次性 Runtime。重复运行时，相同模板复用既有发布 revision；模板语义发生变化才发布新 revision。默认 Mock Host 是确定性离线验收数据，13 次检索合计覆盖 100 条候选，不代表实时新闻。

接入真实 Tool/Agent Gateway 时仍运行同一模板，只替换 Host Adapter：

```bash
pnpm example:weekly -- --host /absolute/path/to/my-host.mjs \
  --input /absolute/path/to/inputs.json \
  --db /absolute/path/to/workflows.db
```

Host 模块只需要实现通用 `services.tools.execute` 和 `services.agents.execute`；无需创建 `Provider`、无需修改模板节点，也不能绕过模板的 `spec.requires` 和输出 Schema。自动化程序在构建后可直接执行 Runner 的 `--json` 模式，stdout 只有一个包含 `workflowRef`、`runId`、最终输出、审计计数与可执行 Trace 命令的 JSON 对象：

```bash
pnpm build
node examples/run-weekly-ai-model-news.mjs --json > weekly-result.json
```

在 DSH 中运行真实检索时：

1. 运行 `pnpm showcase:install`，然后启动使用同一 DSH home 的 Web profile。
2. 打开一个拥有 `web_search` 的顶层会话，点击右下角 `工作流`。
3. 选择 `AI 模型周报`，点击 `校验`。如果当前 profile 没有 `web_search`，问题面板会明确显示 Tool 不可用。
4. 在运行输入中填写 `from` 和 `to` 日期窗口，点击 `试运行`。模板内部已经把候选上限固定为 100 条。
5. 底部先显示 13 路 Tool 调用，再显示 Agent 结构化评分与确定性脚本合并/排序；最终输出只保留 Top 10。

完整验收仍以 [weekly-ai-model-news.workflow.json](https://github.com/GM-HZ/agent-dag-workflow/blob/main/examples/weekly-ai-model-news.workflow.json) 中声明的 input Schema 为准，不要在脚本节点中放入网络调用、密钥或动态代码。
