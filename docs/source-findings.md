# 源码对照与设计取舍

## DeepSeek Harness

### 已有能力

- [`docs/architecture.md`](../ref_project/deepseek-harness/docs/architecture.md) 明确 DSH 没有特权 core，插件通过 service、typed event 与可逆 effect 组合；新增 UI/editor 应驱动 Agent 并从 durable event 渲染。
- [`packages/workflow/workflow/README.md`](../ref_project/deepseek-harness/packages/workflow/workflow/README.md) 的现有 `ctx.workflowEngine` 执行模型编写的 orchestration script，`start()` 返回 holder-owned run，结果不 reject，engine 实现可替换。
- 同一 README 明确列出 `No journaling or resume`、`No saved or nested workflows`。因此新系统应补“版本化 DAG + 持久执行”，不应把现有 script seam 改成不兼容的多形请求。
- [`packages/workflow/tool-workflow/src/types.ts`](../ref_project/deepseek-harness/packages/workflow/tool-workflow/src/types.ts) 用仓内已登记的 Session event 记录 run/member 生命周期；仓外插件目前无法登记自己的 Session event，也无法通过 `Session.append()` 设置 `ignorable`，因此 DAG 使用“完整 run store + 实时 Cordis event”，不污染 owning Session 日志。
- [`packages/core/tools/src/index.ts`](../ref_project/deepseek-harness/packages/core/tools/src/index.ts) 的 `ctx.tools.execute()` 是 approval、guard、around/post policy、cancellation 与 observer 的执行边界。DAG tool node 直接调用 definition 会绕过安全策略，因此禁止。
- DSH service `inject` 体现“依赖先声明、由组合器解析”的边界。本项目把该原则扩展到模板：NodeDefinition 声明 capability/resource，`spec.requires` 作为 revision 级 allowlist，运行时再与 owning Agent scope 和 DSH policy 求交集。
- [`packages/skill/skill/README.md`](../ref_project/deepseek-harness/packages/skill/skill/README.md) 提供 scope-aware registry，适合把 workflow builder 做成普通 skill；生成器仍应通过 workflow tools 提交模板，避免 skill 私自实现存储与权限。
- [`packages/client/modules/src/index.ts`](../ref_project/deepseek-harness/packages/client/modules/src/index.ts)、[`packages/client/ui-slots`](../ref_project/deepseek-harness/packages/client/ui-slots/README.md) 与 [`packages/client/ui-layout/src/client/index.ts`](../ref_project/deepseek-harness/packages/client/ui-layout/src/client/index.ts) 证明 Canvas 可作为独立 Client Cordis 插件加载。`shell.overlay` 是适合全屏 Studio 的 additive seat。
- [`packages/goal/goal/src/index.ts`](../ref_project/deepseek-harness/packages/goal/goal/src/index.ts) 展示 `TypertRemoteService` 与 `@Remote` 的业务 service 模式，Canvas 的 template/run RPC 可按此实现。

### 对本项目的约束

1. 新 service 使用 `ctx.dagWorkflowEngine` 等独立 key，避免碰撞现有 `ctx.workflowEngine`。
2. 所有 node/client renderer/service 注册返回 disposer，并有 HMR/unload 测试。
3. 每个 model-visible 最终结果必须进入 Session log；Canvas-only trace 可以留在 workflow run store。
4. workflow run 接受后由 holder/engine 明确拥有资源，不能因 Host plugin 卸载留下悬空 promise。

## Coze Studio

### 值得借鉴

- [`backend/domain/workflow/entity/vo/canvas.go`](../ref_project/coze-studio/backend/domain/workflow/entity/vo/canvas.go) 明确 Canvas 是 frontend schema，node 同时携带 data、UI meta、blocks 与 edges。
- [`backend/domain/workflow/internal/canvas/adaptor/to_schema.go`](../ref_project/coze-studio/backend/domain/workflow/internal/canvas/adaptor/to_schema.go) 将 Canvas 转成运行 WorkflowSchema；[`backend/domain/workflow/internal/compose/workflow.go`](../ref_project/coze-studio/backend/domain/workflow/internal/compose/workflow.go) 再把 schema 编译为 Eino graph。这个“编辑格式 -> 运行 IR -> compiled graph”分层值得保留。
- [`backend/domain/workflow/entity/vo/node.go`](../ref_project/coze-studio/backend/domain/workflow/entity/vo/node.go) 把输入区分为 literal 与 typed reference，引用包含 from-node 与 field path。DSH 模板也采用结构化 binding，不使用需要文本扫描修复的模板字符串作为主协议。
- [`backend/domain/workflow/internal/compose/state.go`](../ref_project/coze-studio/backend/domain/workflow/internal/compose/state.go) 显式保存 executed nodes、inputs、source infos、nested states、resume data 与 intermediate result，说明暂停恢复必须覆盖调度和容器内部状态。
- [`frontend/packages/common/flowgram-adapter/free-layout-editor/src/workflow-json-format.ts`](../ref_project/coze-studio/frontend/packages/common/flowgram-adapter/free-layout-editor/src/workflow-json-format.ts) 和 [`frontend/packages/workflow/nodes/src/workflow-document-with-format.ts`](../ref_project/coze-studio/frontend/packages/workflow/nodes/src/workflow-document-with-format.ts) 提供可组合 init/submit transform；Client node 插件也需要注册式 renderer/form/adapter。
- [`frontend/packages/workflow/playground/src/services/workflow-validation-service.ts`](../ref_project/coze-studio/frontend/packages/workflow/playground/src/services/workflow-validation-service.ts) 同时做 form、port、sub-canvas 与 backend schema validation。DSH Canvas 应展示 core compiler diagnostics，而不是只做前端表单校验。

### 不直接照搬

- Coze 的 Canvas schema 把 UI meta 与 runtime data 放在同一个 node 对象里。DSH 更适合把 `layout` 独立出来，从根上避免 React/Flowgram 字段进入语义 hash。
- Coze 节点类型非常多。DSH 已有 tool plugin 生态，首版把 HTTP、代码、知识库等统一映射为 tool node，避免形成第二套插件市场。

## Dify 与 Graphon

### 值得借鉴

- Dify 当前 [`api/core/workflow/workflow_entry.py`](../ref_project/dify/api/core/workflow/workflow_entry.py) 把运行交给独立 Graphon `GraphEngine`，Dify 自己注入 node factory、variables、limits、observability 与 persistence layer。DSH 也应把通用 scheduler 与 DSH node adapters 分离。
- Graphon [`graph_engine/graph_state_manager.py`](../ref_project/graphon/src/graphon/graph_engine/graph_state_manager.py) 采用 edge `UNKNOWN/TAKEN/SKIPPED`，节点在入边全部 settled 且至少一条 taken 时 ready；这套语义适合 condition + join + skip propagation。
- Graphon [`graph_engine/graph_engine.py`](../ref_project/graphon/src/graphon/graph_engine/graph_engine.py) 分开 state manager、edge processor、worker pool、dispatcher、command channel、event manager 与 layer。DSH v1 可以更小，但 extension layer、command 与 event 不应揉进 node executor。
- Graphon [`runtime/graph_runtime_state.py`](../ref_project/graphon/src/graphon/runtime/graph_runtime_state.py) 的 versioned snapshot 包含 variable pool、ready/deferred queues、graph execution、container frames/runs、node/edge states；这是 pause/resume 的最低参考线。
- Dify [`api/core/app/layers/pause_state_persist_layer.py`](../ref_project/dify/api/core/app/layers/pause_state_persist_layer.py) 在 GraphRunPausedEvent 上同时持久化 runtime state、生成实体、stream filter 与 pause reasons，说明宿主语义需要在通用内核 snapshot 外另存。
- Dify [`api/core/workflow/generator/runner.py`](../ref_project/dify/api/core/workflow/generator/runner.py) 使用 router -> planner -> bounded parallel node builders -> deterministic postprocess -> structural validation。这个拆分非常适合 workflow builder skill。
- [`api/core/workflow/generator/tool_catalogue.py`](../ref_project/dify/api/core/workflow/generator/tool_catalogue.py) 区分“完整 inventory 用于校验”和“截断/路由后的 catalog 用于 prompt”，避免大量插件挤爆上下文，同时不把 catalog 外的真实工具误报为缺失。
- [`web/app/components/workflow/workflow-generator/graph-diff.ts`](../ref_project/dify/web/app/components/workflow/workflow-generator/graph-diff.ts) 和 [`apply.ts`](../ref_project/dify/web/app/components/workflow/workflow-generator/apply.ts) 在覆盖 draft 前展示差异，并用 hash 处理并发编辑。DSH draft API 应直接提供 revision/hash compare-and-swap。
- Dify planner 的 code/template-transform/list-operator/assigner/iteration/loop，以及 Coze 的 code/textprocessor/json/variableassigner，说明成熟 Workflow 需要一层位于“结构化 binding”和“外部 Tool”之间的确定性数据处理面。DSH 采用一个 `core.script@1` adapter + 可插拔纯 runtime registry，先用 `dsh.expr@1` 覆盖高频 JSON 变换，避免复制大量窄节点或开放任意代码执行。

### 不直接照搬

- Dify draft graph 是 React Flow 序列化结构，runtime 与 Canvas 耦合较深；DSH 模板使用 UI-neutral semantic graph + 独立 layout。
- Dify generator 对 `{{#node.variable#}}` 做了大量 deterministic repair。DSH 从 v1 使用结构化 binding，减少字符串引用、重命名和生成修复成本。
- Graphon 是 Python/thread queue 内核；本项目应借鉴状态语义，而不是在 TypeScript DSH 中嵌入 Python engine。
- Coze Plugin Node 最终统一进入 `ExecuteTool`，Dify 也把 Node registry 与 Tool runtime protocol 分开；因此 DSH 不增加 Tool-backed preset 执行层。普通外部集成全部使用 Tool，只有特殊工作流生命周期才实现自定义 Node。

## 综合取舍

| Concern | 采用方案 | 主要来源 |
|---|---|---|
| Plugin lifecycle | Cordis effect + scoped registries | DSH |
| Dynamic one-off orchestration | 保留现有 script workflow | DSH |
| Saved/reusable workflow | 新的 versioned DAG template | DSH gap + Coze/Dify |
| Canvas/runtime separation | semantic template + separate layout + executable IR | Coze 分层，修正 Coze/Dify UI 耦合 |
| Variable binding | literal/ref 的结构化 union + field path | Coze |
| Deterministic data plane | `core.script@1` + versioned pure runtime；内置 bounded `dsh.expr@1` | Dify/Coze 节点族，按 DSH 插件边界重构 |
| Branch/join | edge unknown/taken/skipped | Graphon |
| Pause/resume | versioned full runtime checkpoint + host context | Coze + Dify/Graphon |
| Generation | topology planner + schema-driven node build + deterministic validation | Dify |
| Tool execution | 始终走 `ctx.tools.execute()` | DSH |
| External extension model | 两级：通用 DSH Tool + 自定义 Node；Canvas Tool 条目仍物化为 `dsh.tool@1` | Coze Plugin ExecuteTool + Dify Tool runtime/Node registry 分层 |
| Capability isolation | NodeDefinition declaration + `spec.requires` + scoped Host resolver | DSH inject/policy，扩展为模板协议 |
| Dynamic result contract | definition schema + node `expects` + optional explicit Agent review | Coze/Dify structured outputs，按可审计 checkpoint 边界重构 |
| Canvas host bridge | Typert Remote + Client module + `shell.overlay` | DSH |
