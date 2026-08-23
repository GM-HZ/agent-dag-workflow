# DSH DAG Workflow

基于 DeepSeek Harness（DSH）插件体系构建可生成、可执行、可恢复、可视化的 DAG Workflow。

当前仓库处于源码研究与架构设计阶段。目标不是把 Coze Studio 或 Dify 嵌入 DSH，而是吸收它们的图语义、生成链路和 Canvas 经验，形成 DSH 原生能力：节点调用继续经过 DSH 的 tool、subagent、approval、session、sandbox 与 UI 插件边界。

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
- [参考仓库版本与检出方式](ref_project/README.md)

## 建议实施顺序

1. 先完成模板协议、节点注册表、编译校验和内存执行器，只实现 `start/end/tool/condition`。
2. 接入独立的运行事件存储与 checkpoint，再增加 `agent/foreach/subworkflow/human_approval`。
3. 提供 Agent 工具与 `workflow-builder` 引导 skill，形成“规划 -> 构建 -> 校验 -> 预览 diff -> 发布”的生成闭环。
4. 最后接 Canvas；Canvas 只编辑和投影同一份模板，不拥有第二套运行 DSL。
