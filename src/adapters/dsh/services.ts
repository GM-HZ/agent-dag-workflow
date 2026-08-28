import { Context, Service } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import {
  InMemoryWorkflowRunStore,
  WorkflowCapabilityRegistry,
  WorkflowExecutionError,
  WorkflowNodeRegistry,
  WorkflowScriptRuntimeRegistry,
  jsonExpressionRuntime,
  registerCoreNodes,
  snapshotJsonValue,
  stableJsonStringify,
  type WorkflowEvent,
  type WorkflowCapabilityDisposer,
  type WorkflowNodeDefinition,
  type WorkflowNodeDisposer,
  type WorkflowScriptRuntimeDefinition,
  type WorkflowScriptRuntimeDisposer,
  type WorkflowRun,
  type WorkflowRunCheckpoint,
  type WorkflowRunRecord,
  type WorkflowRunMetadata,
  type WorkflowRunStore,
  type WorkflowEngineServices,
} from '../../core/index.js'
import {
  InMemoryWorkflowCatalogRepository,
  WorkflowTemplateCatalog,
  type PublishedWorkflowRevision,
  type WorkflowCatalogRepository,
  type WorkflowCatalogSummary,
  type WorkflowDraft,
  type WorkflowTemplateDiff,
} from '../../catalog/index.js'
import type { WorkflowDiagnostic, WorkflowTemplate } from '../../core/index.js'
import { WorkflowRuntime, type WorkflowRunHandle } from '../../runtime/index.js'
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
    workflowCapabilities: WorkflowCapabilityRegistryService
    workflowScripts: WorkflowScriptRuntimeRegistryService
    workflowTemplates: WorkflowTemplatesService
    workflowRuns: WorkflowRunsService
    dagWorkflowEngine: DagWorkflowEngineService
  }

  interface Events {
    'dag-workflow/event'(event: WorkflowEvent, parent: DshAgentLike): void
  }
}

export class WorkflowCapabilityRegistryService extends Service {
  readonly registry = new WorkflowCapabilityRegistry()

  constructor(ctx: Context) {
    super(ctx, 'workflowCapabilities')
  }

  register<T>(capability: string, service: T): WorkflowCapabilityDisposer {
    return this.registry.register(capability, service)
  }

  resolve<T = unknown>(capability: string): T | undefined {
    return this.registry.resolve<T>(capability)
  }

  list(): readonly string[] {
    return this.registry.list()
  }
}

export class WorkflowScriptRuntimeRegistryService extends Service {
  readonly registry = new WorkflowScriptRuntimeRegistry()

  constructor(ctx: Context) {
    super(ctx, 'workflowScripts')
    ctx.effect(() => this.registry.register(jsonExpressionRuntime), 'agent-dag-workflow: json.expr runtime')
  }

  register(definition: WorkflowScriptRuntimeDefinition): WorkflowScriptRuntimeDisposer {
    return this.registry.register(definition)
  }

  resolve(uses: string): WorkflowScriptRuntimeDefinition | undefined {
    return this.registry.resolve(uses)
  }

  list(): readonly WorkflowScriptRuntimeDefinition[] {
    return this.registry.list()
  }
}

type DshRuntimeContext = Context & {
  readonly tools: DshToolRuntimeLike
  readonly subagents: DshSubagentRuntimeLike
  readonly approval: DshApprovalRuntimeLike
}

export class WorkflowNodeRegistryService extends Service {
  static inject = ['workflowScripts']

  readonly registry = new WorkflowNodeRegistry()

  constructor(ctx: Context) {
    super(ctx, 'workflowNodes')
    ctx.effect(() => registerCoreNodes(this.registry, {
      scriptRuntimes: ctx.workflowScripts.registry,
    }), 'dsh-dag-workflow: core nodes')
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

  abstract start(request: DshDagWorkflowStartRequest): Promise<WorkflowRun>
  abstract resume(request: DshDagWorkflowResumeRequest): Promise<WorkflowRun>
}

export abstract class WorkflowRunsService extends Service implements WorkflowRunStore {
  constructor(ctx: Context) {
    super(ctx, 'workflowRuns')
  }

  abstract createRun(record: WorkflowRunRecord): Promise<void>
  abstract commit(runId: string, expectedSeq: number, checkpoint: WorkflowRunCheckpoint, events: readonly WorkflowEvent[]): Promise<void>
  abstract loadRun(runId: string): Promise<WorkflowRunRecord | undefined>
  abstract getRunMetadata(runId: string): Promise<WorkflowRunMetadata | undefined>
  abstract getCheckpoint(runId: string): Promise<WorkflowRunCheckpoint | undefined>
  abstract readEvents(runId: string, query?: { readonly afterSeq?: number; readonly limit?: number }): Promise<readonly WorkflowEvent[]>
  abstract listRecoverableRuns(): Promise<readonly WorkflowRunRecord[]>
}

export class InMemoryWorkflowRunsService extends WorkflowRunsService {
  private readonly store = new InMemoryWorkflowRunStore()

  async createRun(record: WorkflowRunRecord): Promise<void> { await this.store.createRun(record) }
  async commit(runId: string, expectedSeq: number, checkpoint: WorkflowRunCheckpoint, events: readonly WorkflowEvent[]): Promise<void> {
    await this.store.commit(runId, expectedSeq, checkpoint, events)
  }
  async loadRun(runId: string): Promise<WorkflowRunRecord | undefined> { return this.store.loadRun(runId) }
  async getRunMetadata(runId: string): Promise<WorkflowRunMetadata | undefined> { return this.store.getRunMetadata(runId) }
  async getCheckpoint(runId: string): Promise<WorkflowRunCheckpoint | undefined> { return this.store.getCheckpoint(runId) }
  async readEvents(runId: string, query?: { readonly afterSeq?: number; readonly limit?: number }): Promise<readonly WorkflowEvent[]> { return this.store.readEvents(runId, query) }
  async listRecoverableRuns(): Promise<readonly WorkflowRunRecord[]> { return this.store.listRecoverableRuns() }
}

export abstract class WorkflowTemplatesService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'workflowTemplates')
  }

  abstract createDraft(template: WorkflowTemplate): Promise<WorkflowDraft>
  abstract readDraft(id: string): Promise<WorkflowDraft>
  abstract updateDraft(id: string, expectedRevision: number, template: WorkflowTemplate): Promise<WorkflowDraft>
  abstract validate(template: WorkflowTemplate): Promise<readonly WorkflowDiagnostic[]>
  abstract diff(id: string, candidate: WorkflowTemplate): Promise<WorkflowTemplateDiff>
  abstract publish(id: string, expectedDraftRevision: number): Promise<PublishedWorkflowRevision>
  abstract getPublished(id: string, revision?: number): Promise<PublishedWorkflowRevision>
  abstract list(): Promise<readonly WorkflowCatalogSummary[]>
}

export abstract class RepositoryWorkflowTemplatesService extends WorkflowTemplatesService {
  private readonly catalog: WorkflowTemplateCatalog

  constructor(ctx: Context, repository: WorkflowCatalogRepository) {
    super(ctx)
    this.catalog = new WorkflowTemplateCatalog(repository, ctx.workflowNodes.registry)
  }

  async createDraft(template: WorkflowTemplate): Promise<WorkflowDraft> { return this.catalog.createDraft(template) }
  async readDraft(id: string): Promise<WorkflowDraft> { return this.catalog.readDraft(id) }
  async updateDraft(id: string, expectedRevision: number, template: WorkflowTemplate): Promise<WorkflowDraft> {
    return this.catalog.updateDraft(id, expectedRevision, template)
  }
  async validate(template: WorkflowTemplate): Promise<readonly WorkflowDiagnostic[]> { return this.catalog.validate(template) }
  async diff(id: string, candidate: WorkflowTemplate): Promise<WorkflowTemplateDiff> { return this.catalog.diff(id, candidate) }
  async publish(id: string, expectedDraftRevision: number): Promise<PublishedWorkflowRevision> { return this.catalog.publish(id, expectedDraftRevision) }
  async getPublished(id: string, revision?: number): Promise<PublishedWorkflowRevision> { return this.catalog.getPublished(id, revision) }
  async list(): Promise<readonly WorkflowCatalogSummary[]> { return this.catalog.list() }
}

export class InMemoryWorkflowTemplatesService extends RepositoryWorkflowTemplatesService {
  static inject = ['workflowNodes']

  constructor(ctx: Context) {
    super(ctx, new InMemoryWorkflowCatalogRepository())
  }
}

export class DshDagWorkflowEngineService extends DagWorkflowEngineService {
  static inject = ['tools', 'subagents', 'approval', 'workflowCapabilities', 'workflowNodes', 'workflowTemplates', 'workflowRuns']

  private readonly runtime: WorkflowRuntime
  private readonly active = new Map<string, WorkflowRun>()
  private readonly authorityRefs = new WeakMap<object, string>()
  constructor(ctx: Context, private readonly config: DshWorkflowPluginConfig = {}) {
    super(ctx)
    const runtime = ctx as DshRuntimeContext
    const tools = runtime.tools
    const services: WorkflowEngineServices = {
      capabilities: ctx.workflowCapabilities.registry,
      tools: {
        execute: async request => {
          if (!isDshAgentLike(request.authority)) {
            throw new WorkflowExecutionError('DSH_AGENT_MISSING', 'tool.call requires the owning DSH Agent', { nodeId: request.nodeId })
          }
          const result = await tools.execute({
            callId: request.invocationId,
            name: request.uses,
            arguments: request.inputs,
            signal: request.signal,
            agent: request.authority,
          })
          if (result.isError) {
            throw new WorkflowExecutionError('DSH_TOOL_FAILED', renderError(result.error), { nodeId: request.nodeId })
          }
          return result.value
        },
      },
      agents: {
        execute: async request => {
          if (!isDshAgentLike(request.authority)) {
            throw new WorkflowExecutionError('DSH_AGENT_MISSING', 'agent.run requires the owning DSH Agent', { nodeId: request.nodeId })
          }
          const target = selectCurrentAgentTarget(runtime.subagents, {
            structuredOutput: request.outputSchema !== undefined,
            depthLimit: false,
          })
          const run = await runtime.subagents.start(target, {
            label: request.nodeId,
            prompt: [{ type: 'text', text: request.prompt }],
            parent: request.authority,
            signal: request.signal,
            ...(request.outputSchema === undefined ? {} : { outputSchema: request.outputSchema }),
            ...(request.tools === undefined ? {} : { tools: request.tools }),
            ...(request.skills === undefined ? {} : { skills: request.skills }),
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
          const content = contentValue as readonly import('../../core/index.js').JsonValue[]
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
          if (!isDshAgentLike(request.authority)) {
            throw new WorkflowExecutionError('DSH_AGENT_MISSING', 'human.approval requires the owning DSH Agent', { nodeId: request.nodeId })
          }
          const details = Object.keys(request.details).length === 0
            ? ''
            : `\nWorkflow details: ${stableJsonStringify(request.details)}`
          return runtime.approval.request({
            agent: request.authority,
            toolName: request.action,
            callId: request.invocationId,
            reason: `${request.reason}${details}`,
            signal: request.signal,
          })
        },
      },
    }
    this.runtime = new WorkflowRuntime({
      nodes: ctx.workflowNodes.registry,
      catalog: ctx.workflowTemplates as unknown as WorkflowTemplateCatalog,
      runStore: ctx.workflowRuns,
      services,
    })
    ctx.effect(() => async () => {
      const runs = [...this.active.values()]
      for (const run of runs) run.cancel('dag workflow service disposed')
      await Promise.all(runs.map(run => run.dispose()))
      this.active.clear()
    }, 'dsh-dag-workflow: active runs')
  }

  async start(request: DshDagWorkflowStartRequest): Promise<WorkflowRun> {
    const parent = request.parent
    if (!isDshAgentLike(parent)) throw new WorkflowExecutionError('DSH_AGENT_INVALID', 'parent must expose a DSH Session')
    const observe = createRunObserver(this.ctx, parent, request.onEvent)
    const authorityRef = this.authorityReference(parent)
    const handle = await this.runtime.launch({
      target: request.target ?? { type: 'inline', template: request.template },
      inputs: request.inputs,
      authorityRef,
      authority: parent,
      origin: { type: 'host', source: 'dsh' },
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      onEvent: observe,
    })
    const run = adaptRunHandle(handle)
    this.active.set(run.id, run)
    void run.result.then(() => { if (this.active.get(run.id) === run) this.active.delete(run.id) })
    return run
  }

  async resume(request: DshDagWorkflowResumeRequest): Promise<WorkflowRun> {
    const parent = request.parent
    if (!isDshAgentLike(parent)) throw new WorkflowExecutionError('DSH_AGENT_INVALID', 'parent must expose a DSH Session')
    const record = await this.ctx.workflowRuns.loadRun(request.runId)
    if (record === undefined) throw new WorkflowExecutionError('RUN_NOT_FOUND', `workflow run not found: ${request.runId}`)
    if (this.active.has(request.runId)) throw new WorkflowExecutionError('RUN_ACTIVE', `workflow run is already active: ${request.runId}`)
    const observe = createRunObserver(this.ctx, parent, request.onEvent)
    const handle = await this.runtime.resume({
      runId: request.runId,
      authorityRef: record.execution.authorityRef,
      authority: parent,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.unknownNodeResolutions === undefined ? {} : { unknownNodeResolutions: request.unknownNodeResolutions }),
      onEvent: observe,
    })
    const run = adaptRunHandle(handle)
    this.active.set(run.id, run)
    void run.result.then(() => { if (this.active.get(run.id) === run) this.active.delete(run.id) })
    return run
  }

  private authorityReference(parent: DshAgentLike): string {
    if (this.config.recovery !== undefined) return ownerReference(this.config, parent)
    const existing = this.authorityRefs.get(parent)
    if (existing !== undefined) return existing
    const reference = `dsh-session:${randomUUID()}`
    this.authorityRefs.set(parent, reference)
    return reference
  }
}

export class WorkflowRecoveryCoordinator {
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
  for (const record of await ctx.workflowRuns.listRecoverableRuns()) {
    signal.throwIfAborted()
    if (record.checkpoint.status !== 'running') continue
    try {
      const parent = await recovery.resolve(record.execution.authorityRef, { runId: record.runId, signal })
      signal.throwIfAborted()
      if (parent === undefined) {
        ctx.logger.warn(`dsh-dag-workflow: authority unavailable for run ${record.runId}; leaving it recoverable`)
        continue
      }
      if (!isDshAgentLike(parent)) {
        ctx.logger.warn(`dsh-dag-workflow: authority returned an invalid Agent for run ${record.runId}`)
        continue
      }
      if (recovery.reference(parent) !== record.execution.authorityRef) {
        ctx.logger.warn(`dsh-dag-workflow: authority reference mismatch for run ${record.runId}`)
        continue
      }
      await ctx.dagWorkflowEngine.resume({ runId: record.runId, parent, signal })
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

function adaptRunHandle(handle: WorkflowRunHandle): WorkflowRun {
  return {
    id: handle.runId,
    result: handle.result,
    cancel: reason => handle.cancel(reason),
    async dispose() { await handle.result },
  }
}

function isDshAgentLike(value: unknown): value is DshAgentLike {
  if (value === null || typeof value !== 'object' || !('session' in value)) return false
  const session = value.session
  return session !== null && typeof session === 'object' && 'append' in session && typeof session.append === 'function'
}

function ownerReference(config: DshWorkflowPluginConfig, parent: DshAgentLike): string {
  if (config.recovery === undefined) throw new Error('recovery configuration is required')
  const reference = config.recovery.reference(parent)
  if (typeof reference !== 'string' || reference.length === 0 || reference.length > 1024) {
    throw new WorkflowExecutionError('RUN_OWNER_REFERENCE_INVALID', 'recovery.reference must return 1-1024 characters')
  }
  return reference
}

function selectCurrentAgentTarget(
  runtime: DshSubagentRuntimeLike,
  required: { readonly structuredOutput: boolean; readonly depthLimit: boolean },
): string {
  const listed = [...(runtime.list?.() ?? [])]
  const compatible = listed.filter(name => {
    const capabilities = runtime.getProvider?.(name)?.capabilities
    return (!required.structuredOutput || capabilities?.outputSchema !== false)
      && (!required.depthLimit || capabilities?.depthLimit !== false)
  })
  const candidates = compatible.length > 0 ? compatible : listed
  for (const preferred of ['spawn', 'general-purpose']) {
    if (candidates.includes(preferred)) return preferred
  }
  if (candidates[0] !== undefined) return candidates[0]
  // Older DSH runtimes did not expose list(); spawn is their canonical child seam.
  return 'spawn'
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
