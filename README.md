# DSH DAG Workflow

基于 DeepSeek Harness（DSH）插件体系构建可生成、可执行、可恢复、可视化的 DAG Workflow。

当前仓库已经完成首版内核、DSH 装配、Template Catalog、持久化恢复、生成 Skill 和 Canvas Studio。目标不是把 Coze Studio 或 Dify 嵌入 DSH，而是吸收它们的图语义、生成链路和 Canvas 经验，形成 DSH 原生能力：节点调用继续经过 DSH 的 tool、subagent、approval、session、sandbox 与 UI 插件边界。

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
- `core.subworkflow@1` 与 `core.foreach@1`，只调用固定 published revision；确定性 child invocation、item container frame 与继承深度上限支持崩溃恢复。
- 八个受策略保护的 `workflow_*` Agent tools 与随包发布的 `workflow-builder` Skill，形成 topology → draft CAS → validate → diff → publish → exact-revision run 闭环。
- Canvas 包 [`@gm-hz/dsh-workflow-canvas`](packages/canvas/README.md)：12 个 Typert Remote 端点、Host fail-closed authority、DSH `shell.overlay` 浮动入口与全屏 XYFlow Studio。
- Canvas 直接编辑唯一 `WorkflowTemplate`，支持 provider palette、schema config form、edge/node 编辑、diagnostics、CAS save、diff、publish、draft test run、持久 trace 与 unknown-side-effect resume 决策。
- 可选 Host restart coordinator 通过持久 `ownerRef` 重新取得真实 Agent；没有 authority、paused 或无 owner 的 run 保持不动。
- secret binding 只经 scoped resolver 进入瞬时节点输入；原值出现在节点输出时拒绝持久化。
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
- [安全与恢复边界](docs/security.md)

## 包

- `@gm-hz/dsh-workflow-core`：协议、编译器、调度器、核心节点和 RunStore contract。
- `@gm-hz/dsh-workflow-catalog`：draft CAS、diff、不可变 published revision。
- `@gm-hz/dsh-workflow-dsh`：Cordis services、DSH capability adapters、Agent tools 与 Skill。
- `@gm-hz/dsh-workflow-sqlite`：SQLite catalog/run/checkpoint providers 与 v1→v3 migration。
- `@gm-hz/dsh-workflow-canvas`：Typert Host/Client Remote 与 Canvas Studio。

## License

[MIT](LICENSE)
