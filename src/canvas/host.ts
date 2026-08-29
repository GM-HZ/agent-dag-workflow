import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  snapshotJsonObject,
  snapshotJsonValue,
  type WorkflowDiagnostic,
  type WorkflowNodeDefinition,
  type WorkflowRunCheckpoint,
  type WorkflowRunMetadata,
  type WorkflowEvent,
  type WorkflowRunResult,
  type WorkflowTemplate,
} from '../core/index.js'
import type {
  PublishedWorkflowRevision,
  WorkflowCatalogSummary,
  WorkflowDraft,
  WorkflowTemplateDiff,
} from '../catalog/index.js'
import type {
  CanvasCatalogSummary,
  CanvasListRequest,
  CanvasOperationsSnapshot,
  CanvasDraftCreateRequest,
  CanvasDraftDiffRequest,
  CanvasDraftPublishRequest,
  CanvasDraftReadRequest,
  CanvasDraftRunRequest,
  CanvasNodeDefinition,
  CanvasPublishedRevision,
  CanvasResumeRequest,
  CanvasRunRequest,
  CanvasRunResult,
  CanvasTemplateRequest,
  CanvasTrace,
  CanvasTraceRequest,
  CanvasDraftUpdateRequest,
  CanvasTemplateDiff,
  CanvasWorkflowDiagnostic,
  CanvasWorkflowDraft,
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
  list(): Promise<readonly WorkflowCatalogSummary[]>
}

interface WorkflowCanvasRun {
  readonly id: string
  readonly result: Promise<WorkflowRunResult>
  cancel(reason?: string): Promise<void>
  dispose(): Promise<void>
}

interface WorkflowCanvasEngineHost {
  start(request: {
    readonly template?: WorkflowTemplate
    readonly target?: import('../runtime/index.js').WorkflowLaunchTarget
    readonly inputs: import('../core/index.js').JsonObject
    readonly parent: WorkflowCanvasPrincipal['agent']
    readonly signal: AbortSignal
  }): Promise<WorkflowCanvasRun>
  resume(request: {
    readonly runId: string
    readonly parent: WorkflowCanvasPrincipal['agent']
    readonly signal: AbortSignal
    readonly unknownNodeResolutions?: Readonly<Record<string, 'retry' | 'fail'>>
  }): Promise<WorkflowCanvasRun>
}

type WorkflowCanvasHostContext = Context & {
  readonly workflowNodes: { list(): readonly WorkflowNodeDefinition[] }
  readonly workflowTemplates: WorkflowCanvasTemplateHost
  readonly workflowRuns: {
    getRunMetadata(runId: string): Promise<WorkflowRunMetadata | undefined>
    getCheckpoint(runId: string): Promise<WorkflowRunCheckpoint | undefined>
    readEvents(runId: string, query?: { readonly afterSeq?: number; readonly limit?: number }): Promise<readonly WorkflowEvent[]>
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
  async operations(sessionId: string, request: CanvasListRequest): Promise<CanvasOperationsSnapshot> {
    await Promise.all([
      this.guard(sessionId, 'bindings:list'),
      this.guard(sessionId, 'ingress:list'),
      this.guard(sessionId, 'delivery:list'),
    ])
    const [bindings, ingress, deliveryAttention] = await Promise.all([
      this.config.bindings?.list() ?? Promise.resolve([]),
      this.config.ingress?.list(request) ?? Promise.resolve([]),
      this.config.delivery?.listAttention(request) ?? Promise.resolve([]),
    ])
    return snapshotJsonValue({ bindings, ingress, deliveryAttention }) as unknown as CanvasOperationsSnapshot
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
    await this.guard(sessionId, 'draft:validate', request.template.metadata.id)
    return {
      diagnostics: snapshotJsonValue(await this.host.workflowTemplates.validate(asTemplate(request.template))) as unknown as readonly CanvasWorkflowDiagnostic[],
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
  async run(sessionId: string, request: CanvasRunRequest, signal: AbortSignal): Promise<CanvasRunResult> {
    const principal = await this.guard(sessionId, 'run:start', request.id)
    return settle(await this.host.dagWorkflowEngine.start({
      target: { type: 'published', id: request.id, revision: request.revision },
      inputs: snapshotJsonObject(request.inputs),
      parent: principal.agent,
      signal,
    }))
  }

  @Remote
  async runDraft(sessionId: string, request: CanvasDraftRunRequest, signal: AbortSignal): Promise<CanvasRunResult> {
    const principal = await this.guard(sessionId, 'run:start', request.template.metadata.id)
    return settle(await this.host.dagWorkflowEngine.start({
      template: asTemplate(request.template),
      inputs: snapshotJsonObject(request.inputs),
      parent: principal.agent,
      signal,
    }))
  }

  @Remote
  async resume(sessionId: string, request: CanvasResumeRequest, signal: AbortSignal): Promise<CanvasRunResult> {
    const principal = await this.guard(sessionId, 'run:resume', request.runId)
    return settle(await this.host.dagWorkflowEngine.resume({
      runId: request.runId,
      parent: principal.agent,
      signal,
      ...(request.unknownNodeResolutions === undefined ? {} : {
        unknownNodeResolutions: request.unknownNodeResolutions,
      }),
    }))
  }

  @Remote
  async trace(sessionId: string, request: CanvasTraceRequest): Promise<CanvasTrace> {
    await this.guard(sessionId, 'run:trace', request.runId)
    const [record, checkpoint] = await Promise.all([
      this.host.workflowRuns.getRunMetadata(request.runId),
      this.host.workflowRuns.getCheckpoint(request.runId),
    ])
    if (record === undefined || checkpoint === undefined) throw new Error(`workflow run not found: ${request.runId}`)
    const afterSeq = request.afterSeq ?? 0
    const limit = request.limit ?? 200
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new Error('Canvas trace afterSeq must be a non-negative safe integer')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Canvas trace limit must be between 1 and 1000')
    const page = await this.host.workflowRuns.readEvents(request.runId, { afterSeq, limit: limit + 1 })
    const events = page.slice(0, limit)
    const nextAfterSeq = page.length > limit ? events.at(-1)?.seq : undefined
    return {
      runId: record.runId,
      templateId: record.templateId,
      semanticHash: record.semanticHash,
      createdAt: record.createdAt,
      status: checkpoint.status,
      checkpointSeq: checkpoint.seq,
      nodeStates: checkpoint.nodeStates,
      edgeStates: checkpoint.edgeStates,
      nodeOutputs: checkpoint.nodeOutputs,
      nodeProgress: checkpoint.nodeProgress,
      events: events.map(event => snapshotJsonObject(event)),
      ...(nextAfterSeq === undefined ? {} : { nextAfterSeq }),
      ...(checkpoint.error === undefined ? {} : { error: checkpoint.error }),
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
