import { Context, Service } from '@deepseek-ai/cordis'
import {
  DagWorkflowEngine as CoreDagWorkflowEngine,
  InMemoryWorkflowRunStore,
  WorkflowExecutionError,
  WorkflowPauseError,
  WorkflowNodeRegistry,
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
} from '@gm-hz/dsh-dag-workflow-core'
import {
  InMemoryWorkflowCatalogRepository,
  WorkflowTemplateCatalog,
  type PublishedWorkflowRevision,
  type WorkflowCatalogRepository,
  type WorkflowCatalogSummary,
  type WorkflowDraft,
  type WorkflowTemplateDiff,
} from '@gm-hz/dsh-dag-workflow-catalog'
import type { WorkflowDiagnostic, WorkflowTemplate } from '@gm-hz/dsh-dag-workflow-core'
import type {
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
  static inject = ['tools', 'subagents', 'approval', 'workflowNodes', 'workflowTemplates', 'workflowRuns']

  private readonly engine: CoreDagWorkflowEngine
  private readonly active = new Map<string, WorkflowRun>()
  constructor(ctx: Context, private readonly config: DshWorkflowPluginConfig = {}) {
    super(ctx)
    const runtime = ctx as DshRuntimeContext
    const tools = runtime.tools
    let engine: CoreDagWorkflowEngine
    engine = new CoreDagWorkflowEngine(ctx.workflowNodes.registry, {
      ...(config.resolveSecret === undefined ? {} : {
        secrets: {
          resolve: async (ref, context) => {
            if (!isDshAgentLike(context.owner)) {
              throw new WorkflowExecutionError('DSH_AGENT_MISSING', 'secret bindings require the owning DSH Agent', { nodeId: context.nodeId })
            }
            return snapshotJsonValue(await config.resolveSecret!({
              ref,
              runId: context.runId,
              nodeId: context.nodeId,
              signal: context.signal,
              parent: context.owner,
            }))
          },
        },
      }),
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
          const content = contentValue as readonly import('@gm-hz/dsh-dag-workflow-core').JsonValue[]
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
      subworkflows: {
        execute: async request => {
          if (!isDshAgentLike(request.owner)) {
            throw new WorkflowExecutionError('DSH_AGENT_MISSING', 'nested workflows require the owning DSH Agent', { nodeId: request.nodeId })
          }
          const published = ctx.workflowTemplates.getPublished(request.templateId, request.revision)
          if (published.revision !== request.revision) {
            throw new WorkflowExecutionError('SUBWORKFLOW_REVISION_MISMATCH', `expected ${request.templateId}@${request.revision}, received revision ${published.revision}`, { nodeId: request.nodeId })
          }
          const observe = createRunObserver(ctx, request.owner)
          const childOwnerRef = ownerReference(config, request.owner)
          const child = engine.invoke({
            invocationId: request.invocationId,
            depth: request.depth,
            subworkflowDepthLimit: request.depthLimit,
            template: published.template,
            inputs: request.inputs,
            owner: request.owner,
            ...(childOwnerRef === undefined ? {} : { ownerRef: childOwnerRef }),
            signal: request.signal,
            onEvent: observe,
          })
          this.active.set(child.id, child)
          let result: Awaited<typeof child.result> | undefined
          let executionError: unknown
          try {
            result = await child.result
          } catch (error: unknown) {
            executionError = error
          }
          if (this.active.get(child.id) === child) this.active.delete(child.id)
          let disposalError: unknown
          try {
            await child.dispose()
          } catch (error: unknown) {
            disposalError = error
          }
          if (executionError !== undefined || disposalError !== undefined) {
            const errors = [executionError, disposalError].filter(error => error !== undefined)
            throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'subworkflow execution and disposal failed')
          }
          if (result === undefined) throw new Error('subworkflow result was not available')
          if (result.status === 'paused') {
            throw new WorkflowPauseError(`subworkflow ${result.runId} requires operator attention: ${result.error}`, result.runId)
          }
          if (result.status !== 'completed') {
            throw new WorkflowExecutionError('SUBWORKFLOW_FAILED', `subworkflow ${result.runId} ${result.status}: ${result.error}`, { nodeId: request.nodeId })
          }
          return { runId: result.runId, outputs: result.outputs }
        },
      },
    }, { runStore: ctx.workflowRuns })
    this.engine = engine
    ctx.effect(() => async () => {
      const runs = [...this.active.values()]
      for (const run of runs) run.cancel('dag workflow provider disposed')
      await Promise.all(runs.map(run => run.dispose()))
      this.active.clear()
    }, 'dsh-dag-workflow: active runs')
  }

  start(request: DshDagWorkflowStartRequest): WorkflowRun {
    const parent = request.parent
    if (!isDshAgentLike(parent)) throw new WorkflowExecutionError('DSH_AGENT_INVALID', 'parent must expose a DSH Session')
    const observe = createRunObserver(this.ctx, parent, request.onEvent)
    const ownerRef = ownerReference(this.config, parent)
    const run = this.engine.start({
      template: request.template,
      inputs: request.inputs,
      owner: parent,
      ...(ownerRef === undefined ? {} : { ownerRef }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      onEvent: observe,
    })
    this.active.set(run.id, run)
    void run.result.then(() => { if (this.active.get(run.id) === run) this.active.delete(run.id) })
    return run
  }

  resume(request: DshDagWorkflowResumeRequest): WorkflowRun {
    const parent = request.parent
    if (!isDshAgentLike(parent)) throw new WorkflowExecutionError('DSH_AGENT_INVALID', 'parent must expose a DSH Session')
    const record = this.ctx.workflowRuns.loadRun(request.runId)
    if (record === undefined) throw new WorkflowExecutionError('RUN_NOT_FOUND', `workflow run not found: ${request.runId}`)
    if (this.active.has(request.runId)) throw new WorkflowExecutionError('RUN_ACTIVE', `workflow run is already active: ${request.runId}`)
    const observe = createRunObserver(this.ctx, parent, request.onEvent)
    const run = this.engine.resume({
      runId: request.runId,
      owner: parent,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.unknownNodeResolutions === undefined ? {} : { unknownNodeResolutions: request.unknownNodeResolutions }),
      onEvent: observe,
    })
    this.active.set(run.id, run)
    void run.result.then(() => { if (this.active.get(run.id) === run) this.active.delete(run.id) })
    return run
  }
}

export class WorkflowRecoveryCoordinatorProvider {
  static inject = ['workflowRuns', 'dagWorkflowEngine']

  constructor(ctx: Context, config: DshWorkflowPluginConfig) {
    if (config.recovery === undefined) return
    ctx.effect(() => {
      const controller = new AbortController()
      const task = recoverPersistedWorkflowRuns(ctx, config.recovery!, controller.signal)
      void task.catch(error => {
        if (!controller.signal.aborted) ctx.logger.error(`dsh-dag-workflow: recovery coordinator failed: ${renderError(error)}`)
      })
      return async () => {
        controller.abort('workflow recovery coordinator disposed')
        await task.catch(() => {})
      }
    }, 'dsh-dag-workflow: recover persisted runs')
  }
}

export async function recoverPersistedWorkflowRuns(
  ctx: Context,
  recovery: NonNullable<DshWorkflowPluginConfig['recovery']>,
  signal: AbortSignal,
): Promise<readonly string[]> {
  const started: string[] = []
  for (const record of ctx.workflowRuns.listRecoverableRuns()) {
    signal.throwIfAborted()
    if (record.checkpoint.status !== 'running') continue
    if (record.ownerRef === undefined) {
      ctx.logger.warn(`dsh-dag-workflow: run ${record.runId} cannot auto-recover without an owner reference`)
      continue
    }
    try {
      const parent = await recovery.resolve(record.ownerRef, { runId: record.runId, signal })
      signal.throwIfAborted()
      if (parent === undefined) {
        ctx.logger.warn(`dsh-dag-workflow: authority unavailable for run ${record.runId}; leaving it recoverable`)
        continue
      }
      if (!isDshAgentLike(parent)) {
        ctx.logger.warn(`dsh-dag-workflow: authority returned an invalid Agent for run ${record.runId}`)
        continue
      }
      if (recovery.reference(parent) !== record.ownerRef) {
        ctx.logger.warn(`dsh-dag-workflow: authority owner reference mismatch for run ${record.runId}`)
        continue
      }
      ctx.dagWorkflowEngine.resume({ runId: record.runId, parent, signal })
      started.push(record.runId)
    } catch (error: unknown) {
      if (signal.aborted) throw error
      ctx.logger.warn(`dsh-dag-workflow: failed to recover run ${record.runId}: ${renderError(error)}`)
    }
  }
  return started
}

function createRunObserver(
  ctx: Context,
  parent: DshAgentLike,
  requestObserver?: (event: WorkflowEvent) => void,
): (event: WorkflowEvent) => void {
  return event => {
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

function ownerReference(config: DshWorkflowPluginConfig, parent: DshAgentLike): string | undefined {
  if (config.recovery === undefined) return undefined
  const reference = config.recovery.reference(parent)
  if (typeof reference !== 'string' || reference.length === 0 || reference.length > 1024) {
    throw new WorkflowExecutionError('RUN_OWNER_REFERENCE_INVALID', 'recovery.reference must return 1-1024 characters')
  }
  return reference
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
