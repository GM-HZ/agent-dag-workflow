# DSH DAG Workflow

基于 DeepSeek Harness（DSH）插件体系构建可生成、可执行、可恢复、可视化的 DAG Workflow。

当前仓库已经完成基础内核、DSH 装配、Template Catalog 和第一版持久化恢复。目标不是把 Coze Studio 或 Dify 嵌入 DSH，而是吸收它们的图语义、生成链路和 Canvas 经验，形成 DSH 原生能力：节点调用继续经过 DSH 的 tool、subagent、approval、session、sandbox 与 UI 插件边界。

## v0.1 已实现

- TypeScript 核心包 [`@gm-hz/dsh-workflow-core`](packages/core/README.md)。
- `WorkflowTemplate v1alpha1` 解析、结构/拓扑/binding/provider 校验和结构化 diagnostics。
- 可处置的节点注册表与精确 `type@version` 解析。
- 有界并发内存调度器、`unknown/taken/skipped` 边状态、分支 skip propagation、取消和运行事件。
- `core.start@1`、`core.end@1`、`core.condition@1`、`dsh.tool@1`。
- 窄接口 DSH Tool adapter，Host 侧可把调用接入 `ctx.tools.execute()`。
- DSH Cordis 插件包 [`@gm-hz/dsh-workflow-dsh`](packages/dsh/README.md)，提供真实 `ctx.workflowNodes`、`ctx.dagWorkflowEngine`、Session 摘要与卸载收敛。
- Template Catalog 包 [`@gm-hz/dsh-workflow-catalog`](packages/catalog/README.md) 与 [Node SQLite provider](packages/sqlite/README.md)，提供 draft CAS、发布校验和不可变 revision。
- 内存与 SQLite Run Store，提供顺序事件日志、原子 checkpoint、崩溃恢复、未知副作用暂停和显式恢复决策。
- `dsh.agent@1` 与 `dsh.human-approval@1`，分别严格经过 `ctx.subagents` 与 `ctx.approval`；人工等待先提交 checkpoint 再发问。
- 所有模板、输入、binding 和节点输出进入执行/存储前经过 lossless JSON materialize + 深冻结。

```bash
pnpm install
pnpm check
```

## 当前结论

这个方向值得做，并且 DSH 已经提供了很好的落点：

- DSH 已有 `ctx.workflowEngine`，用于执行模型生成的 JavaScript 编排脚本并扇出 subagent，但源码明确暂不支持保存、嵌套、journal 与 resume。DAG Workflow 应作为互补能力，不应破坏或改写现有 dynamic workflow。
- DSH 的 Cordis effect、scoped tool registry、skill registry、Typert Remote、client module 和 UI slot 已覆盖插件生命周期、Agent 可见能力、前后端 RPC 与 Canvas 装载所需的主要基础设施。
- Coze Studio 证明了“Canvas 数据 -> 运行 Schema -> 编译后执行图”的分层价值；Dify/Graphon 证明了 ready queue、边状态、运行快照、暂停恢复、执行 layer 与生成预览/差异确认的价值。

## 设计入口

- [总体架构](docs/architecture.md)
- [源码对照与取舍](docs/source-findings.md)
- [Workflow Template v1 语义](spec/workflow-template-v1.md)
- [示例模板](examples/research-report.workflow.yaml)
- [v0.1 可运行 Tool 示例](examples/tool-echo.workflow.yaml)
- [参考仓库版本与检出方式](ref_project/README.md)
- [实现状态与完成审计](docs/implementation-status.md)

## 建议实施顺序

1. 增加 `agent/foreach/subworkflow/human_approval` 及其可恢复 checkpoint 语义。
2. 提供 Agent 工具与 `workflow-builder` 引导 skill，形成“规划 -> 构建 -> 校验 -> 预览 diff -> 发布”的生成闭环。
3. 接入 Canvas Host RPC 与 Client overlay；Canvas 只编辑和投影同一份模板，不拥有第二套运行 DSL。
4. 在完整 Harness composition 中跑兼容、安全和端到端门禁。

## License

[MIT](LICENSE)
