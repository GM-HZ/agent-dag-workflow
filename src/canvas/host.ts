import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  WorkflowCompileError,
  isJsonObject,
  snapshotJsonObject,
  snapshotJsonValue,
  type JsonObject,
  type WorkflowDiagnostic,
  type WorkflowNodeDefinition,
  type WorkflowRunCheckpoint,
  type WorkflowRunEventWindow,
  type WorkflowRunHistoryPage,
  type WorkflowRunMetadata,
  type WorkflowRunRecord,
  type WorkflowNodeRegistry,
  type WorkflowEvent,
  type WorkflowRunResult,
  type WorkflowTemplate,
} from '../core/index.js'
import { resolveWorkflowBindings } from '../core/bindings.js'
import { readBundledOrdersExample } from '../examples/orders.js'
import { readWorkflowEventPage } from '../runtime/journal.js'
import { caseFromRun, createWorkflowEvidence, normalizeWorkflowRedactionFields } from '../journal/index.js'
import type {
  PublishedWorkflowRevision,
  WorkflowCatalogSummary,
  WorkflowDraft,
  WorkflowRevisionPage,
  WorkflowTemplateDiff,
} from '../catalog/index.js'
import type {
  CanvasCatalogSummary,
  CanvasCancelRequest,
  CanvasListRequest,
  CanvasOperationsSnapshot,
  CanvasDraftCreateRequest,
  CanvasDraftDiffRequest,
  CanvasDraftPublishRequest,
  CanvasDraftReadRequest,
  CanvasDraftRunRequest,
  CanvasNodeDefinition,
  CanvasPublishedRevision,
  CanvasPublishedReadRequest,
  CanvasRevisionsPage,
  CanvasRevisionsRequest,
  CanvasResumeRequest,
  CanvasRunRequest,
  CanvasRunDetails,
  CanvasRunExportRequest,
  CanvasRunReceipt,
  CanvasRunStartRequest,
  CanvasScheduleRunRequest,
  CanvasScheduleRunReceipt,
  CanvasRunHistoryPage,
  CanvasRunHistoryRequest,
  CanvasRunResult,
  CanvasTemplateRequest,
  CanvasStarterWorkflow,
  CanvasTrace,
  CanvasTraceRequest,
  CanvasJsonObject,
  CanvasDraftUpdateRequest,
  CanvasTemplateDiff,
  CanvasWorkflowDiagnostic,
  CanvasWorkflowDraft,
  CanvasWorkflowContext,
  CanvasWorkflowTemplate,
  WorkflowCanvasAction,
  WorkflowCanvasConfig,
  WorkflowCanvasPrincipal,
  WorkflowCanvasToolCatalogLike,
} from './types.js'

interface WorkflowCanvasTemplateHost {
  createDraft(template: WorkflowTemplate): Promise<WorkflowDraft>
  readDraft(id: string): Promise<WorkflowDraft>
  updateDraft(id: string, expectedRevision: number, template: WorkflowTemplate): Promise<WorkflowDraft>
  validate(template: WorkflowTemplate): Promise<readonly WorkflowDiagnostic[]>
  diff(id: string, candidate: WorkflowTemplate): Promise<WorkflowTemplateDiff>
  publish(id: string, expectedDraftRevision: number): Promise<PublishedWorkflowRevision>
  getPublished(id: string, revision?: number): Promise<PublishedWorkflowRevision>
  listRevisions?(id: string, query: { readonly limit?: number; readonly before?: number }): Promise<WorkflowRevisionPage>
  list(): Promise<readonly WorkflowCatalogSummary[]>
}

interface WorkflowCanvasRun {
  readonly id: string
  readonly result: Promise<WorkflowRunResult>
  cancel(reason?: string): Promise<void>
  dispose(): Promise<void>
}

interface WorkflowCanvasEngineHost {
  authorityRefFor?(parent: WorkflowCanvasPrincipal['agent']): string | undefined
  validate(template: WorkflowTemplate, inputs: JsonObject, parent: WorkflowCanvasPrincipal['agent']): Promise<readonly WorkflowDiagnostic[]>
  listRuns?(query: CanvasRunHistoryRequest, parent: WorkflowCanvasPrincipal['agent']): Promise<WorkflowRunHistoryPage>
  isActive?(runId: string): boolean
  start(request: {
    readonly template?: WorkflowTemplate
    readonly target?: import('../runtime/index.js').WorkflowLaunchTarget
    readonly inputs: import('../core/index.js').JsonObject
    readonly parent: WorkflowCanvasPrincipal['agent']
    readonly interruptionSignal?: AbortSignal
    readonly idempotencyKey?: string
  }): Promise<WorkflowCanvasRun>
  resume(request: {
    readonly runId: string
    readonly parent: WorkflowCanvasPrincipal['agent']
    readonly interruptionSignal?: AbortSignal
    readonly unknownNodeResolutions?: Readonly<Record<string, 'retry' | 'fail'>>
  }): Promise<WorkflowCanvasRun>
  cancel(request: {
    readonly runId: string
    readonly parent: WorkflowCanvasPrincipal['agent']
    readonly reason?: string
    readonly signal?: AbortSignal
  }): Promise<WorkflowRunResult>
  owns(runId: string, parent: WorkflowCanvasPrincipal['agent']): Promise<boolean>
}

type WorkflowCanvasHostContext = Context & {
  readonly workflowNodes: { list(): readonly WorkflowNodeDefinition[]; registry: WorkflowNodeRegistry }
  readonly workflowTemplates: WorkflowCanvasTemplateHost
  readonly workflowRuns: {
    loadRun(runId: string): Promise<WorkflowRunRecord | undefined>
    getRunMetadata(runId: string): Promise<WorkflowRunMetadata | undefined>
    getCheckpoint(runId: string): Promise<WorkflowRunCheckpoint | undefined>
    getRunInputs(runId: string): Promise<JsonObject | undefined>
    readEvents(runId: string, query?: { readonly afterSeq?: number; readonly limit?: number }): Promise<readonly WorkflowEvent[]>
    queryEvents?(runId: string, query: WorkflowRunEventWindow): Promise<readonly WorkflowEvent[]>
  }
  readonly dagWorkflowEngine: WorkflowCanvasEngineHost
  readonly tools: WorkflowCanvasToolCatalogLike
  readonly agents: { get(id: string): unknown }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    workflowCanvas: WorkflowCanvasGateway
  }
}

export class WorkflowCanvasGateway extends TypertRemoteService {
  static inject = ['tools', 'workflowNodes', 'workflowTemplates', 'workflowRuns', 'dagWorkflowEngine', 'agents']

  constructor(ctx: Context, private readonly config: WorkflowCanvasConfig = {}) {
    super(ctx, 'workflowCanvas')
  }

  private get host(): WorkflowCanvasHostContext {
    return this.ctx as WorkflowCanvasHostContext
  }

  @Remote
  async nodes(sessionId: string): Promise<readonly CanvasNodeDefinition[]> {
    const principal = await this.guard(sessionId, 'nodes:list')
    const nodes = this.host.workflowNodes.list()
      .filter(node => `${node.type}@${node.version}` !== 'tool.call@1')
      .map(node => ({
      catalogId: `${node.type}@${node.version}`,
      kind: 'node' as const,
      uses: `${node.type}@${node.version}`,
      title: node.title,
      description: node.description,
      role: node.role ?? 'regular',
      configSchema: snapshotJsonObject(node.configSchema),
      ...(node.defaultConfig === undefined ? {} : { defaultConfig: snapshotJsonObject(node.defaultConfig) }),
      inputSchema: snapshotJsonObject(node.inputSchema),
      outputSchema: snapshotJsonObject(node.outputSchema),
      outputPorts: [...node.outputPorts],
      requiredOutputPorts: [...(node.requiredOutputPorts ?? [])],
      capabilities: [...node.capabilities],
      dependencyKinds: [...(node.dependencyKinds ?? [])],
      defaultRequirements: [
        ...node.capabilities.map(uses => ({ kind: 'capability', uses })),
        ...(node.defaultConfig === undefined ? [] : node.dependencies?.(node.defaultConfig) ?? []),
      ],
      effects: node.effects,
      retry: node.retry,
    }))
    const tools = this.host.tools
      .schemas(principal.agent)
      .filter(tool => !tool.name.startsWith('workflow_'))
      .map(tool => ({
        catalogId: `tool:${tool.name}`,
        kind: 'tool' as const,
        uses: 'tool.call@1',
        toolName: tool.name,
        title: tool.name,
        description: tool.description,
        role: 'regular' as const,
        configSchema: snapshotJsonObject({
          type: 'object',
          additionalProperties: false,
          required: ['uses'],
          properties: { uses: { type: 'string', enum: [tool.name] } },
        }),
        defaultConfig: snapshotJsonObject({ uses: tool.name }),
        inputSchema: snapshotJsonObject(tool.parameters),
        outputSchema: snapshotJsonObject({
          type: 'object', additionalProperties: false, required: ['result'], properties: { result: {} },
        }),
        outputPorts: ['success'],
        requiredOutputPorts: [],
        capabilities: ['gateway.tool.execute'],
        dependencyKinds: ['tool'],
        defaultRequirements: [
          { kind: 'capability', uses: 'gateway.tool.execute' },
          { kind: 'tool', uses: tool.name },
        ],
        effects: 'external' as const,
        retry: 'never' as const,
      }))
    return [...nodes, ...tools]
  }

  @Remote
  async templates(sessionId: string): Promise<readonly CanvasCatalogSummary[]> {
    await this.guard(sessionId, 'templates:list')
    return snapshotJsonValue(await this.host.workflowTemplates.list()) as unknown as readonly CanvasCatalogSummary[]
  }

  @Remote
  async context(sessionId: string): Promise<CanvasWorkflowContext> {
    const principal = await this.guard(sessionId, 'context:read')
    const authorityRef = this.host.dagWorkflowEngine.authorityRefFor?.(principal.agent)
    return { sessionId: principal.subject, ...(authorityRef === undefined ? {} : { authorityRef }),
      ...(this.config.storage === undefined ? {} : { storage: this.config.storage }) }
  }

  @Remote
  async starterOrders(sessionId: string): Promise<CanvasStarterWorkflow> {
    await this.guard(sessionId, 'templates:list')
    const { template, inputSource } = await readBundledOrdersExample()
    return snapshotJsonValue({ template, inputs: snapshotJsonObject(JSON.parse(inputSource)) }) as unknown as CanvasStarterWorkflow
  }

  @Remote
  async operations(sessionId: string, request: CanvasListRequest): Promise<CanvasOperationsSnapshot> {
    const limit = request.limit ?? 100
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('operations limit must be between 1 and 1000')
    const [bindingPrincipal, ingressPrincipal, deliveryPrincipal] = await Promise.all([
      this.guard(sessionId, 'bindings:list'),
      this.guard(sessionId, 'ingress:list'),
      this.guard(sessionId, 'delivery:list'),
    ])
    const engine = this.host.dagWorkflowEngine
    const bindingAuthority = engine.authorityRefFor?.(bindingPrincipal.agent)
    const ingressAuthority = engine.authorityRefFor?.(ingressPrincipal.agent)
    const deliveryAuthority = engine.authorityRefFor?.(deliveryPrincipal.agent)
    const [bindings, ingressRows, deliveryRows] = await Promise.all([
      bindingAuthority === undefined ? [] : this.config.bindings?.list({ authorityRef: bindingAuthority, limit, latestOnly: true }) ?? [],
      ingressAuthority === undefined ? [] : this.config.ingress?.list({ authorityRef: ingressAuthority, limit }) ?? [],
      deliveryAuthority === undefined ? [] : this.config.delivery?.listAttention({ authorityRef: deliveryAuthority, limit }) ?? [],
    ])

    const bindingOwners = new Map<string, Promise<string | undefined>>()
    const ingress = await Promise.all(ingressRows.slice(0, limit).map(async row => {
      const { id, revision } = row.binding
      const key = `${id}@${revision}`
      let owner = bindingOwners.get(key)
      if (owner === undefined) {
        owner = this.config.bindings?.get(id, revision).then(binding => binding?.spec.authorityRef) ?? Promise.resolve(undefined)
        bindingOwners.set(key, owner)
      }
      if (ingressAuthority === undefined || await owner !== ingressAuthority) return undefined
      const runId = row.runId !== undefined && await engine.owns(row.runId, ingressPrincipal.agent) ? row.runId : undefined
      return { triggerId: row.triggerId, binding: { id, revision }, source: row.source, sourceEventId: row.sourceEventId,
        status: row.status, receivedAt: row.receivedAt, ...(runId === undefined ? {} : { runId }),
        ...(row.reasonCode === undefined ? {} : { reasonCode: row.reasonCode }),
        ...(row.duplicateCount === undefined ? {} : { duplicateCount: row.duplicateCount }) }
    }))
    const deliveryAttention = await Promise.all(deliveryRows.slice(0, limit).map(async row => {
      if (!await engine.owns(row.runId, deliveryPrincipal.agent)) return undefined
      const { invocationId, runId, phase, status, attempts, updatedAt } = row
      return { invocationId, runId, phase, status, attempts, updatedAt }
    }))
    const ownedBindings = bindings.filter(binding => binding.spec.authorityRef === bindingAuthority).slice(0, limit)
    const visibleBindings = await Promise.all(ownedBindings.map(async binding => {
      const { id, revision } = binding.metadata
      let schedule
      if (binding.spec.trigger.uses === 'cron@1' && this.config.schedules !== undefined) {
        try { schedule = await this.config.schedules.inspect(id, revision, bindingPrincipal) }
        catch { schedule = { expression: '', timezone: '', unavailable: true } }
      }
      return {
        metadata: { id, revision },
        spec: { workflow: { id: binding.spec.workflow.id, revision: binding.spec.workflow.revision },
          trigger: { uses: binding.spec.trigger.uses }, enabled: binding.spec.enabled !== false },
        ...(schedule === undefined ? {} : { schedule }),
      }
    }))
    return {
      bindings: visibleBindings,
      ingress: ingress.filter(row => row !== undefined),
      deliveryAttention: deliveryAttention.filter(row => row !== undefined),
    }
  }

  @Remote
  async runSchedule(sessionId: string, request: CanvasScheduleRunRequest): Promise<CanvasScheduleRunReceipt> {
    const principal = await this.guard(sessionId, 'schedule:run', request.id)
    assertPublishedRevision(request.revision)
    if (!/^[a-z][a-z0-9-]{0,127}$/u.test(request.id) || !/^[a-zA-Z0-9_-]{16,128}$/u.test(request.requestId)
      || !Number.isSafeInteger(request.requestedAt) || request.requestedAt < 0 || !Number.isFinite(new Date(request.requestedAt).getTime())) {
      throw new Error('invalid Canvas schedule request')
    }
    if (this.config.schedules === undefined || this.config.bindings === undefined) throw new Error('workflow schedules are unavailable in this host')
    const binding = await this.config.bindings.get(request.id, request.revision)
    const authorityRef = this.host.dagWorkflowEngine.authorityRefFor?.(principal.agent)
    if (binding === undefined || authorityRef === undefined || binding.spec.authorityRef !== authorityRef) throw new Error('workflow schedule access denied')
    if (binding.spec.trigger.uses !== 'cron@1' || binding.spec.enabled === false) throw new Error('workflow schedule is disabled or is not a time schedule')
    return this.config.schedules.runNow(request, principal)
  }

  @Remote
  async createDraft(sessionId: string, request: CanvasDraftCreateRequest): Promise<CanvasWorkflowDraft> {
    await this.guard(sessionId, 'draft:create', request.template.metadata.id)
    return snapshotJsonValue(await this.host.workflowTemplates.createDraft(asTemplate(request.template))) as unknown as CanvasWorkflowDraft
  }

  @Remote
  async readDraft(sessionId: string, request: CanvasDraftReadRequest): Promise<CanvasWorkflowDraft> {
    await this.guard(sessionId, 'draft:read', request.id)
    return snapshotJsonValue(await this.host.workflowTemplates.readDraft(request.id)) as unknown as CanvasWorkflowDraft
  }

  @Remote
  async updateDraft(sessionId: string, request: CanvasDraftUpdateRequest): Promise<CanvasWorkflowDraft> {
    await this.guard(sessionId, 'draft:update', request.id)
    return snapshotJsonValue(await this.host.workflowTemplates.updateDraft(
      request.id,
      request.expectedRevision,
      asTemplate(request.template),
    )) as unknown as CanvasWorkflowDraft
  }

  @Remote
  async validate(sessionId: string, request: CanvasTemplateRequest): Promise<{
    readonly diagnostics: readonly CanvasWorkflowDiagnostic[]
  }> {
    const principal = await this.guard(sessionId, 'draft:validate', request.template.metadata.id)
    const template = asTemplate(request.template)
    const diagnostics = request.inputs === undefined
      ? await this.host.workflowTemplates.validate(template)
      : await this.host.dagWorkflowEngine.validate(template, request.inputs, principal.agent)
    return {
      diagnostics: snapshotJsonValue(diagnostics) as unknown as readonly CanvasWorkflowDiagnostic[],
    }
  }

  @Remote
  async diff(sessionId: string, request: CanvasDraftDiffRequest): Promise<CanvasTemplateDiff> {
    await this.guard(sessionId, 'draft:diff', request.id)
    return snapshotJsonValue(await this.host.workflowTemplates.diff(request.id, asTemplate(request.candidate))) as unknown as CanvasTemplateDiff
  }

  @Remote
  async publish(sessionId: string, request: CanvasDraftPublishRequest): Promise<CanvasPublishedRevision> {
    await this.guard(sessionId, 'draft:publish', request.id)
    return snapshotJsonValue(await this.host.workflowTemplates.publish(request.id, request.expectedRevision)) as unknown as CanvasPublishedRevision
  }

  @Remote
  async readPublished(sessionId: string, request: CanvasPublishedReadRequest): Promise<CanvasPublishedRevision> {
    await this.guard(sessionId, 'revision:read', request.id)
    assertPublishedRevision(request.revision)
    return snapshotJsonValue(await this.host.workflowTemplates.getPublished(request.id, request.revision)) as unknown as CanvasPublishedRevision
  }

  @Remote
  async revisions(sessionId: string, request: CanvasRevisionsRequest): Promise<CanvasRevisionsPage> {
    await this.guard(sessionId, 'revisions:list', request.id)
    const templates = this.host.workflowTemplates
    if (templates.listRevisions === undefined) throw new Error('this workflow host does not support revision history')
    return templates.listRevisions(request.id, request)
  }

  @Remote
  async startRun(sessionId: string, request: CanvasRunStartRequest): Promise<CanvasRunReceipt> {
    const target = request.target
    const id = target.type === 'draft' ? target.template.metadata.id : target.id
    const principal = await this.guard(sessionId, 'run:start', id)
    if (typeof request.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(request.requestId)) {
      throw new Error('Canvas run requestId must contain 1-128 letters, digits, hyphens or underscores')
    }
    const inputs = snapshotJsonObject(request.inputs)
    const common = { inputs, parent: principal.agent, idempotencyKey: `canvas:${request.requestId}` }
    if (target.type === 'draft') {
      const template = asTemplate(target.template)
      await this.assertReady(template, inputs, principal)
      const run = await this.host.dagWorkflowEngine.start({ ...common, template })
      return { runId: run.id, status: 'accepted' }
    }
    assertPublishedRevision(target.revision)
    const published = await this.host.workflowTemplates.getPublished(id, target.revision)
    await this.assertReady(published.template, inputs, principal)
    const run = await this.host.dagWorkflowEngine.start({ ...common, target: { type: 'published', id, revision: target.revision } })
    return { runId: run.id, status: 'accepted' }
  }

  @Remote
  async resumeRun(sessionId: string, request: CanvasResumeRequest): Promise<CanvasRunReceipt> {
    const principal = await this.guard(sessionId, 'run:resume', request.runId)
    await this.assertRunOwner(request.runId, principal)
    const engine = this.host.dagWorkflowEngine
    if (engine.isActive?.(request.runId) !== true) {
      await engine.resume({ runId: request.runId, parent: principal.agent,
        ...(request.unknownNodeResolutions === undefined ? {} : { unknownNodeResolutions: request.unknownNodeResolutions }),
      })
    }
    return { runId: request.runId, status: 'accepted' }
  }

  @Remote
  async run(sessionId: string, request: CanvasRunRequest, signal: AbortSignal): Promise<CanvasRunResult> {
    const principal = await this.guard(sessionId, 'run:start', request.id)
    const inputs = snapshotJsonObject(request.inputs)
    const published = await this.host.workflowTemplates.getPublished(request.id, request.revision)
    await this.assertReady(published.template, inputs, principal)
    signal.throwIfAborted()
    return settle(await this.host.dagWorkflowEngine.start({
      target: { type: 'published', id: request.id, revision: request.revision },
      inputs,
      parent: principal.agent,
      interruptionSignal: signal,
    }))
  }

  @Remote
  async runDraft(sessionId: string, request: CanvasDraftRunRequest, signal: AbortSignal): Promise<CanvasRunResult> {
    const principal = await this.guard(sessionId, 'run:start', request.template.metadata.id)
    const template = asTemplate(request.template)
    const inputs = snapshotJsonObject(request.inputs)
    await this.assertReady(template, inputs, principal)
    signal.throwIfAborted()
    return settle(await this.host.dagWorkflowEngine.start({
      template,
      inputs,
      parent: principal.agent,
      interruptionSignal: signal,
    }))
  }

  @Remote
  async resume(sessionId: string, request: CanvasResumeRequest, signal: AbortSignal): Promise<CanvasRunResult> {
    const principal = await this.guard(sessionId, 'run:resume', request.runId)
    await this.assertRunOwner(request.runId, principal)
    return settle(await this.host.dagWorkflowEngine.resume({
      runId: request.runId,
      parent: principal.agent,
      interruptionSignal: signal,
      ...(request.unknownNodeResolutions === undefined ? {} : {
        unknownNodeResolutions: request.unknownNodeResolutions,
      }),
    }))
  }

  @Remote
  async cancel(sessionId: string, request: CanvasCancelRequest, signal: AbortSignal): Promise<CanvasRunResult> {
    const principal = await this.guard(sessionId, 'run:cancel', request.runId)
    await this.assertRunOwner(request.runId, principal)
    const result = await this.host.dagWorkflowEngine.cancel({
      runId: request.runId,
      parent: principal.agent,
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      signal,
    })
    return projectResult(result)
  }

  @Remote
  async listRuns(sessionId: string, request: CanvasRunHistoryRequest): Promise<CanvasRunHistoryPage> {
    const principal = await this.guard(sessionId, 'run:list', request.templateId)
    const engine = this.host.dagWorkflowEngine
    if (engine.listRuns === undefined) throw new Error('this workflow host does not support run history')
    const { items, nextAfter } = await engine.listRuns(request, principal.agent)
    return {
      items: items.map(item => ({
        runId: item.runId, templateId: item.templateId, templateName: item.templateName,
        ...(item.revision === undefined ? {} : { revision: item.revision }),
        origin: item.origin,
        status: item.status, createdAt: item.createdAt, updatedAt: item.updatedAt,
        checkpointSeq: item.checkpointSeq, needsAttention: item.needsAttention,
        ...(item.status !== 'running' || engine.isActive === undefined ? {} : { active: engine.isActive(item.runId) }),
      })),
      ...(nextAfter === undefined ? {} : { nextAfter }),
    }
  }

  @Remote
  async runDetails(sessionId: string, request: { readonly runId: string }): Promise<CanvasRunDetails> {
    const principal = await this.guard(sessionId, 'run:trace', request.runId)
    await this.assertRunOwner(request.runId, principal)
    const [record, inputs, checkpoint] = await Promise.all([
      this.host.workflowRuns.getRunMetadata(request.runId), this.host.workflowRuns.getRunInputs(request.runId),
      this.host.workflowRuns.getCheckpoint(request.runId),
    ])
    if (record === undefined || inputs === undefined || checkpoint === undefined) throw new Error(`workflow run not found: ${request.runId}`)
    const template = record.plan.root.template
    const nodeInputs: [string, JsonObject][] = []
    const relatedRuns: NonNullable<CanvasRunDetails['relatedRuns']>[number][] = []
    for (const node of template.spec.nodes) {
      if ((checkpoint.nodeAttempts[node.id] ?? 0) > 0) {
        try { nodeInputs.push([node.id, resolveWorkflowBindings(node.inputs, inputs, id => checkpoint.nodeOutputs[id])]) }
        catch { /* Attach only inputs reconstructable from committed upstream outputs. */ }
      }
      const output = checkpoint.nodeOutputs[node.id]
      if (node.uses === 'agent.run@1' && typeof output?.runId === 'string') relatedRuns.push({ nodeId: node.id, kind: 'agent', runId: output.runId })
      if (node.uses === 'workflow.call@1' && typeof output?.runId === 'string') relatedRuns.push({ nodeId: node.id, kind: 'subworkflow', runId: output.runId })
      if (node.uses === 'core.foreach@1' && Array.isArray(output?.results)) for (const item of output.results) {
        if (isJsonObject(item) && typeof item.runId === 'string') relatedRuns.push({ nodeId: node.id, kind: 'subworkflow', runId: item.runId })
      }
    }
    return snapshotJsonValue({
      runId: record.runId, template, inputs, nodeInputs: Object.fromEntries(nodeInputs), relatedRuns, origin: record.execution.origin,
      ...(record.plan.root.revision === undefined ? {} : { revision: record.plan.root.revision }),
    }) as unknown as CanvasRunDetails
  }

  @Remote
  async exportCase(sessionId: string, request: CanvasRunExportRequest): Promise<CanvasJsonObject> {
    const record = await this.exportRecord(sessionId, request.runId)
    return snapshotJsonObject(caseFromRun(record, this.host.workflowNodes.registry, normalizeWorkflowRedactionFields(request.redactFields)))
  }

  @Remote
  async exportEvidence(sessionId: string, request: CanvasRunExportRequest): Promise<CanvasJsonObject> {
    const record = await this.exportRecord(sessionId, request.runId)
    const { artifactStore } = this.config
    return createWorkflowEvidence(record, {
      ...(request.redactFields === undefined ? {} : { redactFields: request.redactFields }),
      ...(request.includeArtifacts !== true || artifactStore === undefined ? {} : { artifactStore }),
    })
  }

  private async exportRecord(sessionId: string, runId: string): Promise<WorkflowRunRecord> {
    const principal = await this.guard(sessionId, 'run:export', runId)
    await this.assertRunOwner(runId, principal)
    const record = await this.host.workflowRuns.loadRun(runId)
    if (record === undefined) throw new Error(`workflow run not found: ${runId}`)
    return record
  }

  @Remote
  async trace(sessionId: string, request: CanvasTraceRequest): Promise<CanvasTrace> {
    const principal = await this.guard(sessionId, 'run:trace', request.runId)
    await this.assertRunOwner(request.runId, principal)
    const [record, checkpoint] = await Promise.all([
      this.host.workflowRuns.getRunMetadata(request.runId),
      this.host.workflowRuns.getCheckpoint(request.runId),
    ])
    if (record === undefined || checkpoint === undefined) throw new Error(`workflow run not found: ${request.runId}`)
    const afterSeq = request.afterSeq ?? 0
    const limit = request.limit ?? 200
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new Error('Canvas trace afterSeq must be a non-negative safe integer')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Canvas trace limit must be between 1 and 1000')
    if (request.throughSeq !== undefined && (!Number.isSafeInteger(request.throughSeq) || request.throughSeq < 0)) {
      throw new Error('Canvas trace throughSeq must be a non-negative safe integer')
    }
    const { events, nextAfterSeq, nextBeforeSeq } = await readWorkflowEventPage(this.host.workflowRuns, request.runId, {
      ...(request.afterSeq === undefined ? {} : { afterSeq }), limit, throughSeq: Math.min(checkpoint.seq, request.throughSeq ?? checkpoint.seq),
      ...(request.window === undefined ? {} : { window: request.window }),
      ...(request.beforeSeq === undefined ? {} : { beforeSeq: request.beforeSeq }),
      ...(request.nodeId === undefined ? {} : { nodeId: request.nodeId }),
      ...(request.failuresOnly === undefined ? {} : { failuresOnly: request.failuresOnly }),
    })
    const needsAttention = Object.keys(checkpoint.nodeStates).filter(nodeId => checkpoint.nodeStates[nodeId] === 'needs_attention').sort()
    return {
      runId: record.runId,
      templateId: record.templateId,
      ...(record.plan.root.revision === undefined ? {} : { revision: record.plan.root.revision }),
      semanticHash: record.semanticHash,
      origin: record.execution.origin,
      createdAt: record.createdAt,
      updatedAt: checkpoint.updatedAt,
      status: checkpoint.status,
      ...(this.host.dagWorkflowEngine.isActive === undefined ? {} : { active: this.host.dagWorkflowEngine.isActive(record.runId) }),
      checkpointSeq: checkpoint.seq,
      nodeStates: request.eventsOnly === true ? {} : checkpoint.nodeStates,
      edgeStates: request.eventsOnly === true ? {} : checkpoint.edgeStates,
      nodeOutputs: request.eventsOnly === true ? {} : checkpoint.nodeOutputs,
      nodeProgress: request.eventsOnly === true ? {} : checkpoint.nodeProgress,
      events: events.map(event => snapshotJsonObject(event)),
      ...(nextAfterSeq === undefined ? {} : { nextAfterSeq }),
      ...(nextBeforeSeq === undefined ? {} : { nextBeforeSeq }),
      ...(request.eventsOnly === true || checkpoint.resultOutputs === undefined ? {} : { outputs: checkpoint.resultOutputs }),
      ...(checkpoint.error === undefined ? {} : { error: checkpoint.error }),
      ...(needsAttention.length === 0 ? {} : { needsAttention }),
    }
  }

  private async guard(
    sessionId: string,
    action: WorkflowCanvasAction,
    resourceId?: string,
  ): Promise<WorkflowCanvasPrincipal> {
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('workflow canvas sessionId is required')
    const agent = this.host.agents.get(sessionId)
    if (agent === null || typeof agent !== 'object'
      || !('session' in agent) || agent.session === null || typeof agent.session !== 'object'
      || !('append' in agent.session) || typeof agent.session.append !== 'function') {
      throw new Error(`workflow canvas access denied for ${action}`)
    }
    const header = 'header' in agent.session && agent.session.header !== null && typeof agent.session.header === 'object'
      ? agent.session.header as { readonly origin?: unknown }
      : undefined
    if (header?.origin === 'subagent') throw new Error(`workflow canvas access denied for ${action}`)
    const scopedAgent = agent as unknown as WorkflowCanvasPrincipal['agent']
    const principal = this.config.authorize === undefined
      ? { subject: sessionId, agent: scopedAgent }
      : await this.config.authorize({
          sessionId,
          agent: scopedAgent,
          action,
          ...(resourceId === undefined ? {} : { resourceId }),
        })
    if (principal === undefined) throw new Error(`workflow canvas access denied for ${action}`)
    if (typeof principal.subject !== 'string' || principal.subject.length === 0) throw new Error('workflow canvas authority returned an invalid subject')
    const authorizedAgent = principal.agent
    if (authorizedAgent === null || typeof authorizedAgent !== 'object' || authorizedAgent.session === null || typeof authorizedAgent.session !== 'object'
      || typeof authorizedAgent.session.append !== 'function') {
      throw new Error('workflow canvas authority returned an invalid DSH Agent')
    }
    return principal
  }

  private async assertRunOwner(runId: string, principal: WorkflowCanvasPrincipal): Promise<void> {
    if (!await this.host.dagWorkflowEngine.owns(runId, principal.agent)) throw new Error(`workflow canvas access denied for run ${runId}`)
  }

  private async assertReady(template: WorkflowTemplate, inputs: JsonObject, principal: WorkflowCanvasPrincipal): Promise<void> {
    const diagnostics = await this.host.dagWorkflowEngine.validate(template, inputs, principal.agent)
    if (diagnostics.some(item => item.severity === 'error')) throw new WorkflowCompileError(diagnostics)
  }
}

function assertPublishedRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Canvas requires an exact positive workflow revision')
}

async function settle(run: WorkflowCanvasRun): Promise<CanvasRunResult> {
  let result: WorkflowRunResult | undefined
  let executionError: unknown
  try { result = await run.result } catch (error: unknown) { executionError = error }
  let disposalError: unknown
  try { await run.dispose() } catch (error: unknown) { disposalError = error }
  if (executionError !== undefined || disposalError !== undefined) {
    const errors = [executionError, disposalError].filter(error => error !== undefined)
    throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'workflow run and disposal failed')
  }
  if (result === undefined) throw new Error('workflow result was not available')
  return projectResult(result)
}

function projectResult(result: WorkflowRunResult): CanvasRunResult {
  return result.status === 'completed'
    ? { runId: result.runId, status: result.status, outputs: result.outputs }
    : {
        runId: result.runId,
        status: result.status,
        error: result.error,
        ...(result.needsAttention === undefined ? {} : { needsAttention: result.needsAttention }),
      }
}

function asTemplate(template: CanvasWorkflowTemplate): WorkflowTemplate {
  return snapshotJsonObject(template) as unknown as WorkflowTemplate
}
