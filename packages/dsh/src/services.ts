import { Context, Service } from '@deepseek-ai/cordis'
import {
  DagWorkflowEngine as CoreDagWorkflowEngine,
  InMemoryWorkflowRunStore,
  WorkflowExecutionError,
  WorkflowNodeRegistry,
  compileWorkflowOrThrow,
  registerCoreNodes,
  snapshotJsonValue,
  stableJsonStringify,
  type WorkflowEvent,
  type WorkflowNodeDefinition,
  type WorkflowNodeDisposer,
  type WorkflowRun,
  type WorkflowRunCheckpoint,
  type WorkflowRunRecord,
  type WorkflowRunStore,
} from '@gm-hz/dsh-workflow-core'
import {
  InMemoryWorkflowCatalogRepository,
  WorkflowTemplateCatalog,
  type PublishedWorkflowRevision,
  type WorkflowCatalogRepository,
  type WorkflowCatalogSummary,
  type WorkflowDraft,
  type WorkflowTemplateDiff,
} from '@gm-hz/dsh-workflow-catalog'
import type { WorkflowDiagnostic, WorkflowTemplate } from '@gm-hz/dsh-workflow-core'
import type {
  DagWorkflowNodeEndData,
  DagWorkflowNodeStartData,
  DagWorkflowNodeWaitData,
  DagWorkflowRunEndData,
  DagWorkflowRunStartData,
  DshAgentLike,
  DshDagWorkflowResumeRequest,
  DshDagWorkflowStartRequest,
  DshToolRuntimeLike,
  DshSubagentRuntimeLike,
  DshApprovalRuntimeLike,
  DshWorkflowPluginConfig,
} from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    workflowNodes: WorkflowNodeRegistryService
    workflowTemplates: WorkflowTemplatesService
    workflowRuns: WorkflowRunsService
    dagWorkflowEngine: DagWorkflowEngineService
  }

  interface Events {
    'dag-workflow/event'(event: WorkflowEvent, parent: DshAgentLike): void
  }
}

type DshRuntimeContext = Context & {
  readonly tools: DshToolRuntimeLike
  readonly subagents: DshSubagentRuntimeLike
  readonly approval: DshApprovalRuntimeLike
}

export class WorkflowNodeRegistryService extends Service {
  readonly registry = new WorkflowNodeRegistry()

  constructor(ctx: Context) {
    super(ctx, 'workflowNodes')
    ctx.effect(() => registerCoreNodes(this.registry), 'dsh-dag-workflow: core nodes')
  }

  register(definition: WorkflowNodeDefinition): WorkflowNodeDisposer {
    return this.registry.register(definition)
  }

  resolve(uses: string): WorkflowNodeDefinition | undefined {
    return this.registry.resolve(uses)
  }

  list(): readonly WorkflowNodeDefinition[] {
    return this.registry.list()
  }
}

export abstract class DagWorkflowEngineService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'dagWorkflowEngine')
  }

  abstract start(request: DshDagWorkflowStartRequest): WorkflowRun
  abstract resume(request: DshDagWorkflowResumeRequest): WorkflowRun
}

export abstract class WorkflowRunsService extends Service implements WorkflowRunStore {
  constructor(ctx: Context) {
    super(ctx, 'workflowRuns')
  }

  abstract createRun(record: WorkflowRunRecord): void
  abstract commit(runId: string, expectedSeq: number, checkpoint: WorkflowRunCheckpoint, events: readonly WorkflowEvent[]): void
  abstract loadRun(runId: string): WorkflowRunRecord | undefined
  abstract listRecoverableRuns(): readonly WorkflowRunRecord[]
}

export class InMemoryWorkflowRunsProvider extends WorkflowRunsService {
  private readonly store = new InMemoryWorkflowRunStore()

  createRun(record: WorkflowRunRecord): void { this.store.createRun(record) }
  commit(runId: string, expectedSeq: number, checkpoint: WorkflowRunCheckpoint, events: readonly WorkflowEvent[]): void {
    this.store.commit(runId, expectedSeq, checkpoint, events)
  }
  loadRun(runId: string): WorkflowRunRecord | undefined { return this.store.loadRun(runId) }
  listRecoverableRuns(): readonly WorkflowRunRecord[] { return this.store.listRecoverableRuns() }
}

export abstract class WorkflowTemplatesService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'workflowTemplates')
  }

  abstract createDraft(template: WorkflowTemplate): WorkflowDraft
  abstract readDraft(id: string): WorkflowDraft
  abstract updateDraft(id: string, expectedRevision: number, template: WorkflowTemplate): WorkflowDraft
  abstract validate(template: WorkflowTemplate): readonly WorkflowDiagnostic[]
  abstract diff(id: string, candidate: WorkflowTemplate): WorkflowTemplateDiff
  abstract publish(id: string, expectedDraftRevision: number): PublishedWorkflowRevision
  abstract getPublished(id: string, revision?: number): PublishedWorkflowRevision
  abstract list(): readonly WorkflowCatalogSummary[]
}

export abstract class RepositoryWorkflowTemplatesProvider extends WorkflowTemplatesService {
  private readonly catalog: WorkflowTemplateCatalog

  constructor(ctx: Context, repository: WorkflowCatalogRepository) {
    super(ctx)
    this.catalog = new WorkflowTemplateCatalog(repository, ctx.workflowNodes.registry)
  }

  createDraft(template: WorkflowTemplate): WorkflowDraft { return this.catalog.createDraft(template) }
  readDraft(id: string): WorkflowDraft { return this.catalog.readDraft(id) }
  updateDraft(id: string, expectedRevision: number, template: WorkflowTemplate): WorkflowDraft {
    return this.catalog.updateDraft(id, expectedRevision, template)
  }
  validate(template: WorkflowTemplate): readonly WorkflowDiagnostic[] { return this.catalog.validate(template) }
  diff(id: string, candidate: WorkflowTemplate): WorkflowTemplateDiff { return this.catalog.diff(id, candidate) }
  publish(id: string, expectedDraftRevision: number): PublishedWorkflowRevision { return this.catalog.publish(id, expectedDraftRevision) }
  getPublished(id: string, revision?: number): PublishedWorkflowRevision { return this.catalog.getPublished(id, revision) }
  list(): readonly WorkflowCatalogSummary[] { return this.catalog.list() }
}

export class InMemoryWorkflowTemplatesProvider extends RepositoryWorkflowTemplatesProvider {
  static inject = ['workflowNodes']

  constructor(ctx: Context) {
    super(ctx, new InMemoryWorkflowCatalogRepository())
  }
}

export class DagWorkflowEngineProvider extends DagWorkflowEngineService {
  static inject = ['tools', 'subagents', 'approval', 'workflowNodes', 'workflowRuns']

  private readonly engine: CoreDagWorkflowEngine
  private readonly active = new Set<WorkflowRun>()
  private readonly recordSessionEvents: boolean

  constructor(ctx: Context, config: DshWorkflowPluginConfig = {}) {
    super(ctx)
    const runtime = ctx as DshRuntimeContext
    const tools = runtime.tools
    this.recordSessionEvents = config.recordSessionEvents ?? true
    this.engine = new CoreDagWorkflowEngine(ctx.workflowNodes.registry, {
      tools: {
        execute: async request => {
          if (!isDshAgentLike(request.owner)) {
            throw new WorkflowExecutionError('DSH_AGENT_MISSING', 'dsh.tool requires the owning DSH Agent', { nodeId: request.nodeId })
          }
          const result = await tools.execute({
            callId: `${request.runId}:${request.nodeId}`,
            name: request.name,
            arguments: request.input,
            signal: request.signal,
            agent: request.owner,
          })
          if (result.isError) {
            throw new WorkflowExecutionError('DSH_TOOL_FAILED', renderError(result.error), { nodeId: request.nodeId })
          }
          return result.value
        },
      },
      agents: {
        execute: async request => {
          if (!isDshAgentLike(request.owner)) {
            throw new WorkflowExecutionError('DSH_AGENT_MISSING', 'dsh.agent requires the owning DSH Agent', { nodeId: request.nodeId })
          }
          const run = await runtime.subagents.start(request.provider, {
            prompt: [{ type: 'text', text: request.prompt }],
            parent: request.owner,
            signal: request.signal,
            ...(request.label === undefined ? {} : { label: request.label }),
            ...(request.outputSchema === undefined ? {} : { outputSchema: request.outputSchema }),
            ...(request.maxDepth === undefined ? {} : { maxDepth: request.maxDepth }),
          })
          let execution: Awaited<typeof run.result> | undefined
          let executionError: unknown
          try {
            execution = await run.result
          } catch (error: unknown) {
            executionError = error
          }
          let disposalError: unknown
          try {
            await run.dispose()
          } catch (error: unknown) {
            disposalError = error
          }
          if (executionError !== undefined || disposalError !== undefined) {
            const errors = [executionError, disposalError].filter(error => error !== undefined)
            throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'subagent execution and disposal failed')
          }
          if (execution === undefined) throw new Error('subagent result was not available')
          if (execution.stopReason !== 'completed') {
            const diagnostic = execution.diagnostic === undefined ? '' : `: ${execution.diagnostic}`
            throw new WorkflowExecutionError('DSH_AGENT_FAILED', `subagent stopped with ${execution.stopReason}${diagnostic}`, { nodeId: request.nodeId })
          }
          const contentValue = snapshotJsonValue(execution.output)
          if (!Array.isArray(contentValue)) throw new Error('subagent output was not a JSON array')
          const content = contentValue as readonly import('@gm-hz/dsh-workflow-core').JsonValue[]
          const structured = execution.structured === undefined ? undefined : snapshotJsonValue(execution.structured)
          return {
            runId: run.id,
            content,
            ...(structured === undefined ? {} : { structured }),
          }
        },
      },
      approvals: {
        request: async request => {
          if (!isDshAgentLike(request.owner)) {
            throw new WorkflowExecutionError('DSH_AGENT_MISSING', 'dsh.human-approval requires the owning DSH Agent', { nodeId: request.nodeId })
          }
          const details = Object.keys(request.details).length === 0
            ? ''
            : `\nWorkflow details: ${stableJsonStringify(request.details)}`
          return runtime.approval.request({
            agent: request.owner,
            toolName: request.action,
            callId: request.token,
            reason: `${request.reason}${details}`,
            signal: request.signal,
          })
        },
      },
    }, { runStore: ctx.workflowRuns })
    ctx.effect(() => async () => {
      const runs = [...this.active]
      for (const run of runs) run.cancel('dag workflow provider disposed')
      await Promise.all(runs.map(run => run.dispose()))
      this.active.clear()
    }, 'dsh-dag-workflow: active runs')
  }

  start(request: DshDagWorkflowStartRequest): WorkflowRun {
    const parent = request.parent
    if (!isDshAgentLike(parent)) throw new WorkflowExecutionError('DSH_AGENT_INVALID', 'parent must expose a DSH Session')
    const compiled = compileWorkflowOrThrow(request.template, this.ctx.workflowNodes.registry)
    const observe = createRunObserver(this.ctx, parent, request.template.metadata.id, compiled.semanticHash, this.recordSessionEvents, request.onEvent)
    const run = this.engine.start({
      template: request.template,
      inputs: request.inputs,
      owner: parent,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      onEvent: observe,
    })
    this.active.add(run)
    void run.result.then(() => { this.active.delete(run) })
    return run
  }

  resume(request: DshDagWorkflowResumeRequest): WorkflowRun {
    const parent = request.parent
    if (!isDshAgentLike(parent)) throw new WorkflowExecutionError('DSH_AGENT_INVALID', 'parent must expose a DSH Session')
    const record = this.ctx.workflowRuns.loadRun(request.runId)
    if (record === undefined) throw new WorkflowExecutionError('RUN_NOT_FOUND', `workflow run not found: ${request.runId}`)
    const observe = createRunObserver(this.ctx, parent, record.template.metadata.id, record.semanticHash, this.recordSessionEvents, request.onEvent)
    const run = this.engine.resume({
      runId: request.runId,
      owner: parent,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.unknownNodeResolutions === undefined ? {} : { unknownNodeResolutions: request.unknownNodeResolutions }),
      onEvent: observe,
    })
    this.active.add(run)
    void run.result.then(() => { this.active.delete(run) })
    return run
  }
}

function appendSessionSummary(
  parent: DshAgentLike,
  event: WorkflowEvent,
  templateId: string,
  semanticHash: string,
): void {
  switch (event.type) {
    case 'run.started': {
      const data: DagWorkflowRunStartData = { runId: event.runId, templateId, semanticHash }
      parent.session.append('dsh-dag-workflow/run-start', data)
      return
    }
    case 'run.resumed':
      parent.session.append('dsh-dag-workflow/run-resume', { runId: event.runId })
      return
    case 'node.started': {
      const data: DagWorkflowNodeStartData = { runId: event.runId, nodeId: event.nodeId }
      parent.session.append('dsh-dag-workflow/node-start', data)
      return
    }
    case 'node.waiting': {
      const data: DagWorkflowNodeWaitData = { runId: event.runId, nodeId: event.nodeId }
      parent.session.append('dsh-dag-workflow/node-wait', data)
      return
    }
    case 'node.completed':
    case 'node.skipped': {
      const data: DagWorkflowNodeEndData = {
        runId: event.runId,
        nodeId: event.nodeId,
        status: event.type === 'node.completed' ? 'completed' : 'skipped',
      }
      parent.session.append('dsh-dag-workflow/node-end', data)
      return
    }
    case 'node.cancelled':
    case 'node.needs-attention': {
      const data: DagWorkflowNodeEndData = {
        runId: event.runId,
        nodeId: event.nodeId,
        status: event.type === 'node.cancelled' ? 'cancelled' : 'needs_attention',
      }
      parent.session.append('dsh-dag-workflow/node-end', data)
      return
    }
    case 'node.failed': {
      const data: DagWorkflowNodeEndData = {
        runId: event.runId,
        nodeId: event.nodeId,
        status: 'failed',
        error: event.error,
      }
      parent.session.append('dsh-dag-workflow/node-end', data)
      return
    }
    case 'run.completed': {
      const data: DagWorkflowRunEndData = { runId: event.runId, status: 'completed' }
      parent.session.append('dsh-dag-workflow/run-end', data)
      return
    }
    case 'run.failed':
    case 'run.cancelled': {
      const data: DagWorkflowRunEndData = {
        runId: event.runId,
        status: event.type === 'run.failed' ? 'failed' : 'cancelled',
        error: event.type === 'run.failed' ? event.error : event.reason,
      }
      parent.session.append('dsh-dag-workflow/run-end', data)
      return
    }
    case 'run.paused': {
      const data: DagWorkflowRunEndData = { runId: event.runId, status: 'paused', error: event.reason }
      parent.session.append('dsh-dag-workflow/run-end', data)
      return
    }
    default:
      return
  }
}

function createRunObserver(
  ctx: Context,
  parent: DshAgentLike,
  templateId: string,
  semanticHash: string,
  recordSessionEvents: boolean,
  requestObserver?: (event: WorkflowEvent) => void,
): (event: WorkflowEvent) => void {
  let recordingEnabled = recordSessionEvents
  return event => {
    if (recordingEnabled) {
      try {
        appendSessionSummary(parent, event, templateId, semanticHash)
      } catch (error: unknown) {
        recordingEnabled = false
        ctx.logger.warn(`dsh-dag-workflow: disabled Session recording: ${renderError(error)}`)
      }
    }
    try { ctx.emit('dag-workflow/event', event, parent) } catch (error: unknown) {
      ctx.logger.warn(`dsh-dag-workflow: event listener failed: ${renderError(error)}`)
    }
    try { requestObserver?.(event) } catch (error: unknown) {
      ctx.logger.warn(`dsh-dag-workflow: request observer failed: ${renderError(error)}`)
    }
  }
}

function isDshAgentLike(value: unknown): value is DshAgentLike {
  if (value === null || typeof value !== 'object' || !('session' in value)) return false
  const session = value.session
  return session !== null && typeof session === 'object' && 'append' in session && typeof session.append === 'function'
}

function renderError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error !== null && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message
  try {
    return String(error)
  } catch {
    return '[unrenderable error]'
  }
}
