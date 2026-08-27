# Showcase workflows

这些示例不是截图用的假流程，而是与 Runtime、Agent 工具和 Canvas 共用同一个 `WorkflowTemplate` 的可编译模板。它们刻意把不确定逻辑交给 Agent，把外部能力交给 DSH Tool，把可重复决策交给受限脚本，并在模板顶层声明全部依赖。

| 场景 | 模板 | 展示的核心能力 |
| --- | --- | --- |
| AI 模型周报 | [`weekly-ai-model-news.workflow.json`](../examples/weekly-ai-model-news.workflow.json) | 内置 `web_search` 13 路并行检索、最多 100 条候选、Agent 评分 overlay、`joinBy` 防篡改合并、稳定 Top 10、结构化摘要 |
| 生产发布门禁 | [`secure-release-guardian.workflow.yaml`](../examples/secure-release-guardian.workflow.yaml) | 并行架构/安全 Agent、确定性最高风险聚合、条件分支、一次性人工授权、完整审计链 |
| 批量合同审查 | [`batch-contract-review.workflow.yaml`](../examples/batch-contract-review.workflow.yaml) + [`contract-clause-review-worker.workflow.yaml`](../examples/contract-clause-review-worker.workflow.yaml) | 固定发布版本的子 Workflow、并发 `foreach`、逐项持久化 frame、崩溃恢复、汇总 Agent |
| 多源尽调 | [`multi-source-due-diligence.workflow.yaml`](../examples/multi-source-due-diligence.workflow.yaml) | Agent 查询规划、三路 `web_search`、不可信内容隔离、证据 Schema、确定性排序、带引用报告 |

## 与 Coze / Dify 工作流的共同点

- 可视化 DAG、节点目录、输入输出绑定、条件分支、批处理、运行轨迹。
- Agent、Tool、脚本和人工节点可以组合成可复用模板。
- 草稿、校验、差异、发布和运行形成完整创作闭环。

## DSH DAG 的差异点

1. **能力先声明**：`spec.requires` 是 allowlist。节点只能取得模板声明且 Agent 当前会话本来就有权使用的 Tool、审批动作、脚本 Runtime 或子 Workflow；Agent 节点继承当前会话 scope。
2. **外部调用不藏进脚本**：`core.script@1` 只变换 JSON，没有网络、文件、时间、随机数、密钥或 `eval`。外部能力始终走 DSH Tool/Agent，日志不会出现旁路。
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

在 DSH Canvas 中导入模板时，先通过 `CHECK` 查看依赖声明是否完整。批量合同示例固定引用 `contract-clause-review-worker` revision 2，需要先发布该 revision，再发布并运行父模板。外部 Tool 名称由当前 DSH profile 提供；模板不会自动扩大当前 Agent 的权限。

也可以把整套 Showcase 作为草稿一键装入本机 DSH（脚本会自动准备批量合同示例依赖的 worker revision 2）：

```bash
pnpm showcase:install
```

默认数据库是 `~/.dsh/dsh-dag-workflow/workflows.db`；验证隔离数据库时可传入 `--db`：

```bash
pnpm showcase:install -- --db /absolute/path/to/workflows.db
```
