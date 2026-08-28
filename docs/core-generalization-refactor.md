# Agent DAG Workflow 核心通用化重构方案

> 状态：Proposed
>
> 目标分支：`codex/generalize-workflow-core`
>
> 基线：`main@4e4f40a`
>
> 目标版本：`0.3.0`（破坏性重构，不保留运行时兼容层）

## 1. 决策摘要

本次重构不另写一套引擎，也不继续拆分更多 npm 包。现有编译器、DAG 调度器、Checkpoint、Catalog、SQLite、Canvas 和 DSH 集成继续作为实现基础，重构为：

```text
一个仓库
一个公开 npm 包
一种 WorkflowTemplate JSON
一个稳定执行内核
多个按需启用的 Host / Control / Trigger Adapter
```

公开安装保持一次完成：

```bash
npm install @gm-hz/agent-dag-workflow
```

包内通过 subpath exports 暴露不同入口，而不是要求用户安装一组相互匹配的包：

```ts
import { WorkflowRuntime } from '@gm-hz/agent-dag-workflow'
import { createDshAdapter } from '@gm-hz/agent-dag-workflow/dsh'
import { createMcpServer } from '@gm-hz/agent-dag-workflow/mcp'
import { createCronTrigger } from '@gm-hz/agent-dag-workflow/triggers/cron'
```

包名是工作名，发布前再检查 npm 可用性。Core、模板协议和序列化数据中不再出现 DSH 标识；DSH 只存在于 `dsh` Adapter 入口。

## 2. 产品定位

重构后的产品不是另一个 Coze/Dify 平台，而是一个可嵌入任何 Agent Host 的持久化 DAG 执行内核：

> 将 Agent、Tool、Skill、MCP 和受控本地能力编排为可保存、可校验、可恢复、可审计、可重放的 WorkflowTemplate。

内核负责流程稳定性，宿主负责能力生态：

| 内核负责 | 宿主或 Adapter 负责 |
| --- | --- |
| 模板、编译、拓扑和绑定 | 模型与 Agent Runtime |
| 节点调度、并发和状态机 | Tool、MCP Tool 和 Skill 发现 |
| Schema、依赖和结果契约 | 身份、凭据和最终权限判断 |
| Journal、Checkpoint 和 Replay | DSH Session、CLI、钉钉、Webhook |
| 发布修订、恢复和审计 | 消息协议、定时器和平台 API |

## 3. 重构目标与非目标

### 3.1 目标

1. 同一份模板可以由 DSH、CLI、MCP Agent 或嵌入式 SDK 驱动。
2. Core 不导入 DSH/Cordis 类型，不包含 DSH 节点名、能力名和日志格式。
3. 保持两级扩展：通用节点 + 自定义生命周期节点。
4. Tool、MCP 和受控本地命令统一走 Tool Gateway，不建立 Provider 层。
5. Skill 作为 Agent 运行依赖或创作引导，不建立独立调用总线。
6. Execution Journal 成为跨宿主的权威运行记录。
7. Checkpoint 支持恢复，Recorded Replay 支持不调用外部能力的历史复现。
8. Trigger 与 DAG 模板分离，同一发布修订可绑定 Agent、CLI、Cron、Webhook、钉钉等入口。
9. Trigger 作为所有外部驱动的统一入站协议，直接调用与事件绑定最终收敛到同一个 Launch API。
10. 参数、环境引用、流式事件、后台 Worker 和 Migration 都使用显式、可版本化契约。
11. 只有一个公开安装包，并保证未使用的 Adapter 不在运行时加载。
12. 用一套 conformance tests 约束所有 Host Adapter 的语义一致性。

### 3.2 非目标

1. 不建设模型 Provider、凭据中心、Skill 市场或 MCP 市场。
2. 不实现任意 JavaScript/Python `eval` 节点。
3. 不让模板直接执行任意 shell 命令。
4. 不承诺 Agent/Tool 的实时重新执行能产生相同结果。
5. 不在 `0.3.0` 同时完成所有消息平台和分布式调度能力。
6. 不保留 `dsh.workflow/*`、`dsh.tool@1`、`dsh.agent@1` 的双轨运行时兼容。
7. 不为了目录边界继续拆出一组独立版本的 npm 包。
8. 不提供可被并发节点任意读写的全局变量池，也不让模板隐式读取宿主进程环境变量。
9. 不在 `0.3.0` 实现任意 `while`、无限循环或按节点创建操作系统进程。

## 4. 为什么采用单包

现有多包结构在实现阶段帮助分层，但对最终用户会带来版本匹配和安装理解成本。通用版本将模块边界保留在源码目录和导出入口中，将发布边界收敛到一个 package manifest。

目标源码结构：

```text
src/
  core/                 模板、编译器、节点定义、DAG 状态机
  runtime/              WorkflowRuntime 门面与后台 Run 协调
  journal/              Event、Checkpoint、Artifact、Replay
  catalog/              草稿、发布修订、diff、语义 hash
  storage/
    memory/             测试和嵌入式使用
    sqlite/             默认本地持久化
  adapters/
    dsh/                DSH Tool/Agent/Skill/Session/Canvas 适配
    mcp/                Workflow 控制面的 MCP Server
    cli/                CLI 控制面
  triggers/
    core/               Trigger Envelope、Binding、幂等入口
    cron/               定时触发适配
    webhook/            HTTP/Webhook 适配
    dingtalk/           钉钉签名、身份和消息回执适配
  canvas/               Host-neutral Canvas 与 DSH 挂载入口
  index.ts              默认 SDK 出口
```

目标导出：

```json
{
  "exports": {
    ".": "./lib/index.js",
    "./core": "./lib/core/index.js",
    "./dsh": "./lib/adapters/dsh/index.js",
    "./mcp": "./lib/adapters/mcp/index.js",
    "./cli": "./lib/adapters/cli/index.js",
    "./canvas": "./lib/canvas/index.js",
    "./triggers": "./lib/triggers/core/index.js",
    "./triggers/cron": "./lib/triggers/cron/index.js",
    "./triggers/webhook": "./lib/triggers/webhook/index.js",
    "./triggers/dingtalk": "./lib/triggers/dingtalk/index.js"
  },
  "bin": {
    "agent-workflow": "./lib/cli.js"
  }
}
```

可选 Adapter 使用动态加载和 optional peer dependency。安装一个包不等于自动启动 DSH、MCP、HTTP Server 或 Cron Worker。

## 5. 目标架构

```mermaid
flowchart TB
  subgraph Entrances["控制与触发入口"]
    SDK["Embedded SDK"]
    CLI["CLI"]
    MCP["MCP Server"]
    DSH["DSH Agent / Canvas"]
    Cron["Cron"]
    Webhook["Webhook"]
    DingTalk["钉钉"]
  end

  subgraph Runtime["稳定运行时"]
    Control["Workflow Control API"]
    Trigger["Trigger Ingress"]
    Catalog["Catalog"]
    Compiler["Compiler"]
    Engine["DAG Engine"]
    Journal["Execution Journal"]
    Checkpoint["Checkpoint"]
    Artifact["Artifact Store"]
  end

  subgraph Host["Host Adapter"]
    Authority["Execution Authority"]
    Tool["Tool Gateway"]
    Agent["Agent Gateway"]
    Skill["Skill Resolver"]
    Approval["Approval Gateway"]
    Observer["Log / Trace Exporter"]
  end

  SDK --> Control
  CLI --> Control
  MCP --> Control
  DSH --> Control
  Cron --> Trigger
  Webhook --> Trigger
  DingTalk --> Trigger
  Trigger --> Control
  Control --> Catalog
  Control --> Compiler
  Control --> Engine
  Engine --> Journal
  Engine --> Checkpoint
  Journal --> Artifact
  Engine --> Authority
  Engine --> Tool
  Engine --> Agent
  Engine --> Skill
  Engine --> Approval
  Journal --> Observer
```

## 6. 中立模板协议

### 6.1 Envelope

`0.3.0` 使用新的中立 API Version：

```json
{
  "apiVersion": "workflow.gm-hz.dev/v1alpha1",
  "kind": "WorkflowTemplate",
  "metadata": {
    "id": "weekly-ai-news",
    "name": "AI 模型周报"
  },
  "spec": {
    "inputSchema": {},
    "outputSchema": {},
    "requires": [],
    "nodes": [],
    "edges": [],
    "outputs": {},
    "policies": {}
  },
  "layout": {}
}
```

`layout` 仍不参与语义 hash。模板、Agent Builder、CLI、MCP 和 Canvas 使用同一结构，不增加第二套 DSL。

### 6.2 标准节点

| 新节点 | 责任 |
| --- | --- |
| `core.start@1` | 校验并暴露 Workflow 输入 |
| `core.end@1` | 组装终态输出 |
| `core.condition@1` | 固定运算符条件分支 |
| `core.script@1` | 受限、纯 JSON、确定性变换 |
| `core.foreach@1` | 有界批处理容器和 item checkpoint |
| `workflow.call@1` | 调用固定发布修订 |
| `tool.call@1` | 通过 Host Tool Gateway 调用能力 |
| `agent.run@1` | 通过 Host Agent Gateway 执行结构化 Agent 任务 |
| `human.approval@1` | 通过 Host Approval Gateway 暂停和恢复 |

旧 DSH 节点不会在 Core 注册别名。现有示例、数据库 fixture 和测试模板直接迁移到新节点名。

### 6.3 两级扩展规则

第一级是标准节点。普通 HTTP、数据库、DMS、消息、存储、MCP Tool 和受控本地命令都通过 `tool.call@1`。

第二级是自定义 `WorkflowNodeDefinition`。只有需要以下生命周期语义时才允许定制节点：

- 长任务进度 checkpoint；
- 人工等待或外部回调恢复；
- 事务补偿；
- 专属容器控制流；
- 普通 Tool 无法表达的原子提交边界。

自定义 Capability Resolver 是节点能力的 fail-closed 投影，不是第三种 Provider 或 Tool Bus。

### 6.4 参数、常量与环境引用

当前 Core 已有两种基础参数：Workflow 的 `inputSchema` 和启动 `inputs`，以及节点的 `with` 配置和显式 `inputs` binding。通用化版本保留这条数据流，不再建立 Coze/Dify 式可变全局变量池。

参数分为四层：

| 层级 | 生命周期 | 是否进入模板/Journal | 规则 |
| --- | --- | --- | --- |
| Node `with` | 发布修订 | 是 | 节点静态配置，参与 semantic hash |
| Workflow Input | 单次 run | 是 | 由 `inputSchema` 校验，是业务参数唯一入口 |
| Binding Mapping | 部署/入口 | 是 | 将 Trigger payload 映射为 Workflow Input |
| Host Config / Secret Ref | 部署环境 | 只保存引用 | 由 Authority 和 Host Adapter 解析，Core 不读取值 |

JSON Schema 已能表达默认值、说明、枚举和自定义 UI metadata，因此“自定义参数”首先是模板输入的创作体验，不需要新造变量系统。重复的固定值可继续使用 literal binding；只有出现大量真实重复时，才增加只读、版本化、参与 semantic hash 的 `spec.constants`。

不提供以下能力：

- `process.env` 或宿主全局环境变量的隐式访问；
- 可由并发节点原地修改的 Workflow global/context 变量；
- 把会话记忆、用户画像或租户配置复制进 Core 的变量池。

需要环境配置时，模板声明 `requires` 和不透明引用，Host 在实际 Tool/Agent 调用时解析。需要触发用户、群、定时窗口等业务数据时，Binding 显式映射到 Workflow Input。这样模板在 CLI、MCP、DSH 和后台 Worker 中仍具有同一语义，也不会因可变共享状态破坏 DAG、恢复和 Replay。

### 6.5 循环与批处理

`core.script@1` 和 `core.foreach@1` 解决的是两类不同问题：

| 场景 | 使用能力 | 原因 |
| --- | --- | --- |
| 对一个 JSON 数组做 map/filter/reduce/sort | `core.script@1` | 纯数据、无副作用、一次确定性提交 |
| 对每个 item 调用 Tool/Agent/子工作流 | `core.foreach@1` | 需要并发限制、逐项 checkpoint、失败策略和恢复 |
| 直到外部条件满足才继续 | 暂不支持通用 `while` | 容易产生无限运行、可变中间状态和不可预测副作用 |

因此 foreach 是核心能力，不能被脚本替代。它必须保持 `maxItems`、`maxConcurrency`、固定子工作流修订、逐项 invocationId 和 checkpoint。通用 `loop/while` 不进入首版；若真实 Case 证明需要，只增加有明确 `maxIterations`、deadline、每轮 checkpoint 和退出条件的 `core.repeat@1`，永远不支持无界循环。

## 7. Host-neutral 执行接口

### 7.1 Execution Authority

当前 `owner?: unknown` 重构为明确但保持不透明的 Authority：

```ts
interface WorkflowExecutionContext {
  authorityRef: string
  authority?: unknown
  origin: WorkflowRunOrigin
  traceContext?: {
    traceId: string
    parentSpanId?: string
  }
}

interface WorkflowAuthorityResolver {
  resolve(authorityRef: string, signal: AbortSignal): Promise<unknown | undefined>
}
```

Core 只持久化 `authorityRef`，不持久化 Session、Token 或 Agent 对象。每次恢复由 Host 重新解析，并重新执行宿主权限策略。

### 7.2 Tool Gateway

```ts
interface WorkflowToolGateway {
  list?(authority: unknown): Promise<readonly WorkflowToolDescriptor[]>
  execute(request: WorkflowToolRequest): Promise<JsonValue>
}
```

MCP Tool 在 Host 注册为普通 Tool。模板不包含 MCP Client、Server Token 或连接实现。

受控本地命令也注册为固定 Tool，例如 `local.git.status`，模板不能传入任意可执行文件和 shell 字符串。

### 7.3 Agent 与 Skill

```ts
interface WorkflowAgentRequest {
  invocationId: string
  prompt: string
  inputs: JsonObject
  outputSchema?: JsonSchema
  tools?: readonly string[]
  skills?: readonly string[]
  authority: unknown
  signal: AbortSignal
}
```

Skill 有两种用途：

1. Authoring Skill：指导 Agent 生成和修改 WorkflowTemplate；
2. Runtime Skill：由 `agent.run@1` 声明并交给 Host 加载。

Runtime Skill 进入 `spec.requires`：

```json
{ "kind": "skill", "uses": "financial-analysis" }
```

Skill 不作为一个可以绕过 Agent/Tool 策略的独立执行节点。

### 7.4 WorkflowRuntime 门面

所有入口复用同一个 API：

```ts
interface WorkflowRuntime {
  validate(template: WorkflowTemplate, context?: ValidationContext): WorkflowValidationResult
  createDraft(request: CreateDraftRequest): Promise<WorkflowDraft>
  updateDraft(request: UpdateDraftRequest): Promise<WorkflowDraft>
  publish(request: PublishRequest): Promise<WorkflowRevision>
  launch(request: WorkflowLaunchRequest): WorkflowRun
  resume(request: WorkflowResumeRequest): WorkflowRun
  getRun(runId: string): Promise<WorkflowRunSummary | undefined>
  readEvents(runId: string, query?: EventQuery): Promise<WorkflowEventPage>
  replay(request: WorkflowReplayRequest): WorkflowRun
}
```

CLI、MCP、DSH 工具和 Canvas 只是该门面的授权适配，不复制业务逻辑。

## 8. Execution Journal、Checkpoint 与 Trace

### 8.1 四层边界

| 层 | 是否权威 | 用途 |
| --- | --- | --- |
| Execution Journal | 是 | 不可变运行事实、调用关联和审计 |
| Checkpoint | 是，但属于快照 | 快速恢复当前状态 |
| Trace Projection | 否，可重建 | Canvas 时间线、性能和 OpenTelemetry |
| Host Log | 否 | DSH Session、CLI、MCP/Agent 用户可见记录 |

DSH Log 不再是 Core 的依赖。DSH Adapter 把标准 Journal/Trace 映射为 DSH observer 和 model-visible tool result；Cron、CLI 或钉钉运行不需要伪造 DSH Session。

### 8.2 Event Envelope

```ts
interface WorkflowEventEnvelope {
  schemaVersion: 1
  eventId: string
  runId: string
  seq: number
  type: WorkflowEventType
  occurredAt: number
  workflow: {
    id: string
    revision?: number
    semanticHash: string
  }
  node?: {
    id: string
    uses: string
    attempt: number
    invocationId: string
  }
  correlation: {
    traceId: string
    spanId: string
    parentSpanId?: string
    parentRunId?: string
    causationEventId?: string
  }
  origin: WorkflowRunOrigin
  payload: JsonObject
}
```

首批事件：

```text
trigger.received / trigger.deduplicated / trigger.rejected
run.accepted / run.started / run.resumed
node.scheduled / node.started / node.progress
capability.requested / capability.completed / capability.failed
node.output-validated / node.output-committed
node.completed / node.failed / node.waiting / node.needs-attention
edge.taken / edge.skipped
checkpoint.committed
run.completed / run.failed / run.cancelled / run.paused
```

必须区分“外部调用已返回”和“节点输出已提交”。进程在两者之间崩溃时，恢复流程才能准确判断是使用录制结果、人工决定还是安全重试。

### 8.3 原子提交不变量

保留并强化当前正确设计：

1. Event `seq` 在单个 run 内严格连续；
2. Event batch 与新 Checkpoint 在一个 Store 事务提交；
3. Store 使用 `expectedSeq` CAS；
4. Observer 只在持久化成功后接收事件；
5. Observer、Canvas 或 OTel 失败不能改变执行结果；
6. 节点输出只有通过 lossless JSON、大小、Definition Schema 和实例 `expects` 后才能提交；
7. 已提交的未知副作用不会因为 Host 重启而盲目重放。

### 8.4 Artifact Store

大输入输出不直接重复写入 Event：

```ts
interface WorkflowArtifactRef {
  digest: string
  size: number
  mediaType: string
  redacted: boolean
}
```

Event 保存输入/输出 hash 和 ArtifactRef；SQLite 初版可以把内容寻址 Artifact 存在同一数据库。Secret 永远只保存引用，不能进入 Journal、Checkpoint 或 Artifact。

Capture Policy 由部署者决定，模板不能扩大记录权限：

```ts
interface WorkflowCapturePolicy {
  mode: 'metadata' | 'standard' | 'replayable'
  maxArtifactBytes: number
  retentionDays?: number
  encryptArtifacts?: boolean
}
```

### 8.5 Replay

提供三个明确模式：

| 模式 | 是否调用外部能力 | 用途 |
| --- | --- | --- |
| `inspect` | 否 | 从 Journal 重建历史状态和时间线 |
| `recorded` | 否 | 使用录制的 Tool/Agent 结果重新计算确定性下游 |
| `live` | 是 | 创建新 run，重新调用并与历史 hash 比较 |

`live` 只能称为 rerun，不能承诺 Agent、网络和数据库结果完全相同。Core 不记录隐藏思维链，只记录显式 Prompt、结构化输入、Tool 调用、公开内容和结构化输出，并遵守 Capture Policy。

### 8.6 Journal 查询接口

避免 `loadRun()` 一次加载全部历史：

```ts
interface WorkflowJournalStore {
  createRun(record: WorkflowRunRecord): void
  commit(request: WorkflowCommitRequest): void
  getRun(runId: string): WorkflowRunSummary | undefined
  getCheckpoint(runId: string): WorkflowRunCheckpoint | undefined
  readEvents(runId: string, query: { afterSeq?: number; limit?: number }): WorkflowEventPage
  readArtifacts(refs: readonly WorkflowArtifactRef[]): readonly WorkflowArtifact[]
  listRecoverableRuns(query?: RecoverableRunQuery): readonly WorkflowRunSummary[]
}
```

实时订阅放在 `WorkflowEventBus`，不要求每种 Store 都实现长连接。

### 8.7 流式输出

流式输出是 Agent、消息 Channel 和 Canvas 的重要体验能力，但不是新的执行事实来源。Core 区分两条通道：

1. **Authoritative Journal**：节点开始、调用、终态输出、Checkpoint 和失败等可恢复事实；
2. **Ephemeral Live Stream**：Agent token、长任务进度、局部预览等低延迟增量。

```ts
interface WorkflowLiveEvent {
  schemaVersion: 1
  runId: string
  nodeId: string
  invocationId: string
  liveSeq: number
  type: 'node.output.delta' | 'node.progress' | 'node.message.delta'
  channel?: string
  data: JsonValue
}
```

Host Adapter 可以将同一 Live Stream 投影为 SSE、WebSocket、MCP progress、CLI stdout、DSH observer 或钉钉更新消息。Core 不把每个 token 写进 Journal，避免数据库膨胀和泄漏模型内部信息；只持久化节流后的公开进度、最终公开内容、结构化输出和 Artifact hash。最终输出仍必须经过 Schema 校验并原子提交，断线重连以 Journal 状态为准，不能把已看到的 delta 当成已完成副作用。

`0.3.0` 先冻结事件、背压、取消和终态提交协议，再实现 Agent Gateway 到各 Adapter 的完整 token streaming。任何情况下都不记录隐藏思维链。

## 9. Trigger 模型

### 9.1 Trigger 是统一外部入站协议

Workflow 是一个可被调用、可被事件触发的发布实体。所有入口最终都转换为同一个启动请求：

```ts
interface WorkflowLaunchRequest {
  workflow: { id: string; revision: number }
  inputs: JsonObject
  authorityRef: string
  origin: WorkflowRunOrigin
  idempotencyKey?: string
  replyTo?: JsonObject
}
```

入口分为两类：

- **直接调用**：SDK、CLI、MCP Tool、DSH/普通 Agent 已经知道目标 workflow 和输入，直接生成 `WorkflowLaunchRequest`；
- **事件触发**：Cron、Webhook、消息和事件总线先生成 `WorkflowTriggerEnvelope`，再通过 `WorkflowBinding` 选定固定发布修订、映射输入和 Authority。

二者在 Input Schema 校验、幂等 launch、run 创建和 Journal 写入处汇合，不维护两套执行路径。

### 9.2 Trigger 不属于 DAG 拓扑

Trigger 使用独立的 `WorkflowBinding`，避免同一个流程为了不同入口复制模板：

```json
{
  "apiVersion": "workflow.gm-hz.dev/v1alpha1",
  "kind": "WorkflowBinding",
  "metadata": { "id": "weekly-ai-cron" },
  "spec": {
    "workflow": { "id": "weekly-ai-news", "revision": 3 },
    "trigger": {
      "uses": "cron@1",
      "with": {
        "expression": "0 9 * * 1",
        "timezone": "Asia/Shanghai"
      }
    },
    "inputMapping": {},
    "authorityRef": "service:ai-news-bot"
  }
}
```

同一发布修订可以同时绑定 Cron、Webhook、钉钉命令和 Agent 控制入口。

### 9.3 Trigger Envelope

```ts
interface WorkflowTriggerEnvelope {
  schemaVersion: 1
  triggerId: string
  source: 'cron' | 'webhook' | 'dingtalk' | 'feishu' | 'wechat' | 'eventbus' | string
  sourceEventId: string
  receivedAt: number
  occurredAt?: number
  idempotencyKey: string
  authorityRef: string
  payload: JsonObject
  metadata?: JsonObject
}
```

统一处理流水线：

```text
接收 → 验签 → 身份映射 → 幂等去重 → 读取固定发布修订
    → 输入映射 → Input Schema 校验 → 创建 run → 保存回执
```

Trigger 默认按至少一次投递设计。`source + sourceEventId + binding revision` 形成幂等键；重复事件返回已有 run，不创建第二次副作用。

### 9.4 Channel、MCP、Skill 与结果投递

Trigger 类似 Channel 的统一入站协议，但不等于完整 Channel：

| 概念 | 责任 |
| --- | --- |
| Trigger Adapter | 接收、验签、去重、身份映射并产生 Envelope |
| Workflow Binding | 选择固定发布修订、映射输入和 Authority |
| Launch Service | 校验并幂等创建 run |
| Result Delivery | 将回执、进度或终态结果投递回来源 |

钉钉、飞书、微信属于双向 Channel Adapter，可以同时实现 Trigger ingress 和 Result Delivery。简单回复使用 `replyTo` 关联；复杂主动发送仍调用显式声明的消息 Tool，不能让 Trigger 获得额外发送权限。

MCP 有两个角色：它既可以提供 workflow 控制面，也可以将已发布 workflow 投影成普通 MCP Tool。Skill 不是传输协议或 Trigger；它负责指导 Agent 创作模板或执行任务，Agent 最终仍通过 SDK、MCP、CLI 等入口发起明确调用。来源信息可以记录 `skillRef`，但不能因此绕过 `requires`、Authority 或 Host policy。

### 9.5 钉钉

支持两种入口：

1. 确定性命令，例如 `/weekly-ai 2026-08-21 2026-08-28`；
2. 自然语言，由宿主 Agent 在允许的发布工作流集合中选择并生成符合 Schema 的参数。

钉钉 Adapter 负责签名、用户/群身份映射、消息去重和最终回执；它不能授予模板未声明或 Authority 未拥有的能力。高风险工作流仍通过 `human.approval@1` 或 Host policy 明确确认。

### 9.6 后台执行与多进程边界

“多进程”不是每个节点 `fork` 一个进程，也不应暴露为模板功能。Core Engine 可以继续在单个 Worker 进程内调度 DAG；生产级 Trigger 需要的是多个 Worker 竞争同一持久化运行队列时仍保持一致的协调语义：

Cron、Webhook 和钉钉进入生产前必须具备：

- durable background queue 或可恢复 run 扫描；
- 原子 claim、Worker lease、heartbeat 与过期接管；
- `expectedSeq`/CAS 防止两个 Worker 同时提交；
- 幂等 launch；
- 稳定 invocationId 和副作用不确定状态；
- 运行超时和取消；
- recoverable run 扫描；
- 失败队列或 operator attention；
- Trigger 回执和最终结果关联。

单进程 SQLite 是本地和嵌入式 reference runtime，可以完成全部语义验证；多 Worker 部署后再增加服务端 Store/Queue Adapter。Core 现在必须冻结 lease、claim、幂等和恢复契约，但 `0.3.0` 不需要同时交付一个分布式调度平台，也不能宣称 exactly-once。

## 10. DSH、CLI、MCP 和 Canvas

### 10.1 DSH Adapter

DSH Adapter 继续提供完整体验：

- 将 `ctx.tools` 映射到 Tool Gateway；
- 将 `ctx.subagents` 映射到 Agent Gateway；
- 将 Skill 可见性映射到 Skill Resolver；
- 将 approval 映射到 Approval Gateway；
- 将 owning Agent/session 映射到 Authority；
- 将 Journal/Trace 投影到 DSH observer、标准 Tool result 和 Canvas；
- 保持 DSH policy pipeline，不直接调用 Tool definition。

DSH Market 安装的是同一个公开包的 DSH 入口，而不是另一套 Core。

### 10.2 CLI

```bash
agent-workflow validate workflow.json
agent-workflow run workflow.json --input input.json
agent-workflow run weekly-ai --revision 3 --input input.json
agent-workflow trace <run-id> --follow
agent-workflow replay <run-id> --mode recorded
agent-workflow resume <run-id>
```

CLI 是最短开发反馈链路，也用于 CI。默认只能使用明确配置的本地 Adapter；不会自动继承用户 shell 的全部环境权限。

### 10.3 MCP Server

MCP 暴露控制面 Tool：

```text
workflow_nodes_list
workflow_templates_list
workflow_draft_create
workflow_draft_update
workflow_validate
workflow_publish
workflow_run
workflow_trace
workflow_replay
workflow_resume
```

MCP Agent 和 DSH Agent 调用同一个 Runtime 门面。Tool 的完整结构化结果由协议返回，用户可见文本保持紧凑，不在对话中回显大型模板和 Trace。

### 10.4 Canvas

Canvas 仍然是 WorkflowTemplate 和 Trace 的投影：

- 不保存第二份流程模型；
- 不编码 Host 私有数据；
- 节点表单来自 NodeDefinition Schema；
- DSH 可以挂载 Canvas，其他 Host 也可以通过相同 Control API 使用；
- 默认展示业务 Trace，基础设施 Event 按需展开；
- Recorded Replay 可以在原图上展示历史状态。

## 11. 安全不变量

通用化不能降低当前安全边界：

1. 模板 `spec.requires` 是 allowlist，不是权限授予；
2. 有效能力是 `Node 声明 ∩ Template requires ∩ Authority scope ∩ Deployment policy`；
3. Tool/MCP/本地命令始终通过 Host policy gateway；
4. Script 只允许纯 JSON、无网络、无文件、无密钥、无时间/随机数和无动态代码；
5. Agent 输出在 Checkpoint 前必须通过结构化 Schema；
6. Secret 只保存引用；
7. Trigger 必须验签、映射 Authority 并幂等去重；
8. Replay 默认不产生外部副作用；
9. 未知副作用状态必须进入 `needs_attention`，不能自动猜测成功或失败；
10. Journal Capture Policy 不能由不受信任模板放宽。

## 12. Migration 策略

### 12.1 分支与发布

```text
main                              当前 0.2.x 稳定线
release/0.2                       必要的严重 Bug/安全修复
codex/generalize-workflow-core    0.3.0 通用化重构
```

在 0.3.0 达到验收门禁前，不发布 npm、不修改 DSH Market 稳定条目。

### 12.2 不保留双轨兼容

- Core 不同时注册新旧节点名；
- Parser 不同时接受两个 API Version；
- 不在执行路径中增加 legacy 分支；
- 旧 npm/tag 保留，可继续运行原有 0.2.x；
- 仓库中的示例和测试一次性迁移；
- 如果真实用户数据需要迁移，只提供独立、可删除、非运行时的离线转换命令。

### 12.3 单包收敛

现有 workspace 包按以下顺序收敛到根包源码：

1. Core 和 Catalog 先移动，保持 API 行为；
2. SQLite 移入 `storage/sqlite`；
3. DSH Host 移入 `adapters/dsh`；
4. Canvas 移入 `canvas`；
5. 删除内部跨包版本依赖和重复 package manifest；
6. 根包建立 subpath exports 和单一版本；
7. CI 验证 pack 后一次安装即可获得需要的入口。

移动过程中不同时进行大规模语义修改。先机械收敛并保持测试通过，再中立化协议和重构 Journal，降低定位成本。

### 12.4 四类 Migration 的边界

Migration 是稳定内核的核心能力，但必须按对象拆开，不能用一个“自动兼容旧数据”的开关覆盖所有情况。

| 类型 | 是否必须 | `0.3.0` 策略 |
| --- | --- | --- |
| Store Schema | 必须 | 保留并强化 `user_version`、顺序迁移、事务、备份提示和幂等测试 |
| Template Protocol | 必须有明确路径 | 0.2 → 0.3 使用一次性离线转换，运行时只接受新 API Version |
| Node Definition/Config | 需要版本契约 | 发布新 revision 时显式迁移并重新校验，不静默修改已发布模板 |
| In-flight Checkpoint | 首版不自动迁移 | run 固定 engine/checkpoint schema；升级前 drain，或由旧 Worker 完成 |

当前 SQLite 已有版本化 Store migration，这是正确基础，需要增加真实旧库 fixture、崩溃回滚和重复启动测试。模板 migration 只服务真实用户数据，不为尚未发布的初期协议保留永久兼容分支。NodeDefinition 后续可选提供 authoring-time `migrate(fromVersion, config)`，转换结果必须生成新的模板修订和 semantic hash。

不尝试迁移正在执行到一半的任意节点栈。若 Worker 遇到不支持的 checkpoint schema，必须明确拒绝并进入 operator attention；生产升级通过版本化 Worker、drain 和灰度解决，而不是猜测旧状态含义。

## 13. 与 Coze/Dify 的差距和核心能力分级

Coze 和 Dify 已经具备丰富变量池、Loop/Iteration、流式响应、异步 Worker、Trigger/Channel 生态和可视化编辑器。这些是成熟平台能力，但不等于本项目都要复制。我们的核心竞争力应是更小的嵌入面、更明确的数据流，以及复用任意 Agent Host 已有的 Tool、Skill 和 MCP 生态。

### 13.1 能力判断

| 能力 | Coze/Dify 的典型做法 | 本项目判断 | 优先级 |
| --- | --- | --- | --- |
| 自定义运行参数 | Schema/变量选择器/表单 | 已有 Input Schema，补齐默认值、说明和入口映射体验 | P0 |
| 环境变量/Secret | 平台变量池与凭据配置 | 只保存引用，由 Host/Authority 解析，禁止隐式 `process.env` | P0 |
| 可变全局/会话变量 | Variable Pool、Assigner/Aggregator | 不进入 Core；共享可变状态会破坏 DAG、并发和 Replay | 不做 |
| Iteration/Batch | 数组迭代、批处理并发 | `core.foreach@1` 是外部调用编排的核心 | P0 |
| Loop/While | 中间变量、break/continue、甚至无限循环 | 纯数组逻辑走 Script；通用 while 暂缓，只预留有界 repeat | P2 |
| 流式输出 | SSE/stream event/token delta | 冻结 Live Event 协议，终态仍由 Journal/Schema 权威提交 | P1 |
| 异步/多 Worker | 后台任务队列和 Worker | 冻结 claim/lease/CAS/idempotency；生产 Trigger 前实现 | P1 |
| Storage Migration | 数据库版本迁移 | 已有基础，必须成为持续门禁 | P0 |
| Template/Node Migration | DSL 和节点版本升级 | 离线、显式、新 revision；不保留运行时双解析 | P0 |
| Trigger/Channel | Cron、Webhook、消息生态 | 统一 Trigger ingress；Channel 双向能力留在 Adapter | P1/P2 |
| 模型/Tool/Plugin Provider | 平台自建生态 | 复用 Host Tool/Skill/MCP，不建立 Provider 层 | 不做 |
| 可视化变量和调试 UI | 平台内建工作台 | Canvas 投影同一模板和 Journal，逐步补体验 | P2 |

### 13.2 真正的稳定核心

```text
模板协议 + 显式输入/依赖
        ↓
编译、DAG/foreach、Schema 与策略校验
        ↓
运行状态机 + Journal + Checkpoint + Replay
        ↓
Authority + Tool/Agent Gateway + 幂等副作用
        ↓
Launch/Trigger 协议 + Migration 契约
```

这五层是类似 Coze/Dify 的 workflow 能长期稳定运行所必需的内核。流式输出和多 Worker 很重要，但分别是输出协议和部署执行模式，不能反向污染模板语义。钉钉、飞书、微信、Cron、HTTP、MCP、Skill 和 DSH 都是这套内核的入口或能力 Adapter，不应各自拥有一套 Workflow Engine。

### 13.3 当前投入顺序

1. **P0 正确性**：中立模板、显式参数、foreach、Authority、Journal/Checkpoint/Replay、Store/Template migration；
2. **P1 可运行性**：Live Stream 协议、后台 run、claim/lease、统一 Launch/Trigger、CLI/MCP reference adapter；
3. **P2 产品体验**：钉钉/飞书/微信 Adapter、Canvas 创作与 Trace、可选 bounded repeat；
4. **明确不做**：可变全局变量池、无限循环、任意 eval/shell、按节点进程模型、重复 Provider 生态。

### 13.4 本地源码对照依据

- Dify 的 `api/core/workflow/workflow_entry.py` 使用 `VariablePool` 和 `ResponseStreamFilter`，说明变量池与流式过滤已经深入平台运行时；本项目只吸收显式输入和流式事件契约，不复制整套可变变量语义。
- Dify 的 `api/services/async_workflow_service.py` 将执行投递给后台 Celery Worker，说明生产 Trigger 需要异步执行层；本项目将其抽象为 queue/claim/lease/CAS，而不绑定某个任务框架。
- Coze 的 `backend/domain/workflow/internal/nodes/loop/loop.go` 同时支持 array、count 和 infinite loop，`nodes/batch/batch.go` 还承担批量 checkpoint 和并发。这证明通用 Loop 的状态空间明显大于 foreach，因此首版只保留可恢复批处理。
- Coze 的 `internal/execute/event.go`、`callback.go` 和 `schema/stream.go` 将 streaming 作为节点和字段级协议。本项目首轮先采用更窄的 run/node Live Event，避免流类型传播侵入整个 JSON DAG 类型系统。

源码对照的目的不是达到节点数量对等，而是识别哪些语义一旦缺失会破坏正确性、恢复或宿主接入。平台 UI、Provider 市场和大量业务节点不属于内核差距。

## 14. 实施阶段

### 阶段 A：单包基线

- 将现有 workspace 收敛为一个公开 package；
- 保留内部目录边界；
- 建立 subpath exports；
- 所有现有测试和本机 DSH Case 继续通过；
- `npm pack` 后只安装一个 tarball 完成验证。

退出门禁：功能零回归，且源码中不存在内部 npm 包相互依赖。

### 阶段 B：中立 Core

- 修改 API Version、标准节点和能力名；
- 明确 Workflow Input、Binding Mapping 和 Host Config/Secret Ref；
- 引入 ExecutionContext/Authority；
- DSH 逻辑全部移动到 Adapter；
- 重建示例、Skill 和 Canvas 文案；
- 删除旧协议分支。

退出门禁：Core 源码与测试不出现 `dsh`、Cordis、Session 或 `ctx.*` 类型。

### 阶段 C：Journal 与 Replay

- Event Envelope v1；
- 调用事件、attempt、invocationId、origin 和 trace correlation；
- Journal 分页查询；
- Artifact 和 Capture Policy；
- inspect/recorded/live 三种模式；
- Live Event 协议以及与 Journal 终态的边界；
- SQLite 原子提交和故障注入测试。

退出门禁：可以在不调用外部 Tool/Agent 的情况下 Recorded Replay 一个复杂运行，并得到相同确定性终态。

### 阶段 D：三宿主验证

- Embedded SDK；
- CLI；
- DSH Adapter；
- MCP 控制面；
- Host Adapter conformance suite。

退出门禁：同一个模板在 SDK、CLI、DSH、MCP 四个入口产生一致的编译结果、依赖拒绝、节点状态和输出契约。

### 阶段 E：后台与 Trigger Core

- background run；
- 原子 claim、Worker lease、heartbeat 和 CAS；
- Trigger Binding/Envelope 与统一 Launch API；
- 幂等 ingress；
- Cron 和 Webhook reference adapter。

退出门禁：重复投递不会产生第二个 run，Worker 崩溃后不会盲目重放未知副作用。

### 阶段 F：钉钉与体验收口

- 钉钉命令、自然语言路由和身份映射；
- 消息回执与 run 关联；
- Canvas Trigger/Trace 页面；
- 文档、示例和本机复杂验收。

退出门禁：钉钉重复事件、超时、权限拒绝、人工审批、成功回复和失败重放均有完整 Journal 证据。

## 15. 测试体系

### 15.1 Core 单元测试

- Parser、Schema 和 semantic hash；
- DAG、分支、foreach 和 subworkflow；
- requires、expects、Authority 和 Capability projection；
- 取消、超时、并发和 retry mode；
- deterministic script sandbox；
- Script 数据循环与 foreach 外部调用循环的边界；
- 不允许隐式环境变量和可变全局状态。

### 15.2 Store 与故障注入

- Event/Checkpoint 同事务；
- `expectedSeq` 冲突；
- capability 返回后、output commit 前崩溃；
- output commit 后、observer 前崩溃；
- waiting checkpoint；
- Worker lease 过期接管；
- 双 Worker claim/CAS 冲突；
- Artifact 损坏和 hash 不一致。

### 15.3 Adapter Conformance

每个 Host Adapter 必须通过同一组测试：

- Tool 参数和 Authority 透传；
- 不可见 Tool/Skill 拒绝；
- Agent 结构化输出校验；
- cancellation 透传；
- invocationId 稳定；
- Host observer 失败不影响运行；
- Secret 不进入 Journal；
- 运行恢复重新解析 Authority。

### 15.4 Replay

- inspect 不执行节点；
- recorded 不调用 Tool/Agent；
- deterministic 节点重算 hash 一致；
- live 创建新 run，不覆盖历史；
- 脱敏或缺失 Artifact 时明确拒绝不可满足的 replay。

### 15.5 Trigger

- 签名错误；
- 身份映射失败；
- 重复 sourceEventId；
- 输入映射错误；
- 固定发布修订；
- 同一事件并发投递；
- 回执失败和重试；
- Cron 时区和错过执行策略。

### 15.6 Stream 与 Migration

- delta 顺序、背压、取消和断线后以 Journal 终态恢复；
- delta 不逐 token 写入 Journal，也不包含隐藏思维链；
- Store 从每个历史 schema fixture 顺序升级并可重复启动；
- 旧 Template 只能经离线命令转成新 revision；
- 不支持的 in-flight checkpoint 明确进入 operator attention。

### 15.7 端到端基准 Case

必须长期保留：

1. 两节点回显：最快 smoke；
2. 风险条件分支：端口与汇合；
3. 批量合同：foreach、子工作流和恢复；
4. AI 模型周报：多路 Tool、Agent、确定性排序、Top 10 和完整 Trace；
5. Trigger Case：Cron/钉钉重复投递与幂等回执。

## 16. 性能与运维基线

初版目标不是极限吞吐，而是稳定、可诊断：

- Journal 分页，Canvas 不一次加载全部事件；
- Artifact 内容寻址，避免 Event 重复保存大对象；
- 单 run Event seq 严格有序，不要求全局顺序；
- 每次 Commit 有明确大小上限；
- Background Worker 有租约、心跳和优雅停止；
- Trace exporter 有界队列，拥塞时不能阻塞 DAG Commit；
- SQLite 保持默认本地体验，Store 接口允许后续实现服务端数据库。

## 17. 主要风险与控制

| 风险 | 控制方式 |
| --- | --- |
| 过度抽象、迟迟不可用 | 只以 DSH、CLI、MCP 三个真实 Host 证明接口 |
| 单包体积过大 | subpath exports、动态加载、optional peer dependency |
| 通用化降低安全性 | Authority + requires + Host policy 四层交集保持 fail-closed |
| Journal 保存敏感数据 | Capture Policy、脱敏、Artifact 加密、Secret reference-only |
| Replay 被误认为确定性重跑 | 明确区分 inspect、recorded 和 live |
| Trigger 重复副作用 | source event 幂等键、固定发布修订、原子 launch |
| 重构范围太大难定位 | 机械单包收敛与语义重构分阶段进行 |
| DSH 用户受影响 | main/0.2.x 保持稳定，0.3.0 门禁通过后再切换 |

## 18. 完成定义

满足以下条件才认为通用化核心完成：

1. 用户只安装一个公开包；
2. Core 序列化协议和源码没有 DSH 标识；
3. DSH 作为 Adapter 仍能运行现有复杂 Case；
4. CLI 可以脱离 DSH 完成 validate/run/trace/replay；
5. 普通 Agent 可以通过 MCP 创建、校验和运行同一模板；
6. Journal 能回答“谁、从哪里、以哪个修订、调用了什么、提交了什么”；
7. Checkpoint 能跨进程恢复，不重跑已经确认提交的副作用；
8. Recorded Replay 不访问外部 Tool/Agent；
9. Trigger 重复投递不会创建重复 run；
10. 多 Worker 竞争通过 claim/lease/CAS 维持单次权威提交；
11. Live Stream 可以实时展示进度，断线后仍由 Journal 恢复权威终态；
12. Store 和模板 Migration 具备明确、可测试、非静默的升级路径；
13. 全部 Adapter、故障注入、安全和复杂端到端测试通过；
14. 代码中没有旧协议兼容分支和重复 Provider/Tool 总线；
15. README、架构、CLI、MCP、DSH 和 Trigger 文档描述同一套事实模型。

## 19. 当前明确决策

以下事项不再作为开放问题：

- 不新建第二套 Workflow 引擎；
- 不长期维护两个实现仓库；
- 不继续拆更多公开 npm 包；
- 不引入 Provider 层；
- 不为 MCP、Skill、本地命令分别创造调用节点；
- 不把 Trigger 放进 DAG 拓扑；
- Trigger 是统一外部入站协议，Channel 的结果投递属于 Adapter；
- 不增加可变全局变量池，环境和 Secret 只通过显式 Host 引用解析；
- 保留 foreach，不增加无界 loop/while；
- 流式增量不是 Journal 权威事实，最终输出仍需 Schema 校验和提交；
- 多进程是 Worker 协调/部署能力，不是模板节点能力；
- Store/Template/Node/Checkpoint Migration 分开处理，不做万能兼容层；
- 不把 DSH Session Log 当作权威运行记录；
- 不保留 0.2 协议的运行时兼容代码；
- 不在通用 Core 中处理宿主凭据和最终授权。

发布前仍需确认的只有品牌包名、npm 可用性、默认 Artifact 保留期限，以及 `0.3.0` 是否一次包含 Trigger Adapter；这些决策不影响上述核心边界。
