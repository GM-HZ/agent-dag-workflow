import { Context, Service } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import {
  DagWorkflowEngine as CoreDagWorkflowEngine,
  InMemoryWorkflowRunStore,
  WorkflowCapabilityRegistry,
  WorkflowExecutionError,
  WorkflowPauseError,
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
  type WorkflowRunStore,
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

export class InMemoryWorkflowRunsService extends WorkflowRunsService {
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

export abstract class RepositoryWorkflowTemplatesService extends WorkflowTemplatesService {
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

export class InMemoryWorkflowTemplatesService extends RepositoryWorkflowTemplatesService {
  static inject = ['workflowNodes']

  constructor(ctx: Context) {
    super(ctx, new InMemoryWorkflowCatalogRepository())
  }
}

export class DshDagWorkflowEngineService extends DagWorkflowEngineService {
  static inject = ['tools', 'subagents', 'approval', 'workflowCapabilities', 'workflowNodes', 'workflowTemplates', 'workflowRuns']

  private readonly engine: CoreDagWorkflowEngine
  private readonly active = new Map<string, WorkflowRun>()
  private readonly authorityRefs = new WeakMap<object, string>()
  constructor(ctx: Context, private readonly config: DshWorkflowPluginConfig = {}) {
    super(ctx)
    const runtime = ctx as DshRuntimeContext
    const tools = runtime.tools
    let engine: CoreDagWorkflowEngine
    engine = new CoreDagWorkflowEngine(ctx.workflowNodes.registry, {
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
      subworkflows: {
        execute: async request => {
          if (!isDshAgentLike(request.authority)) {
            throw new WorkflowExecutionError('DSH_AGENT_MISSING', 'nested workflows require the owning DSH Agent', { nodeId: request.nodeId })
          }
          const published = ctx.workflowTemplates.getPublished(request.templateId, request.revision)
          if (published.revision !== request.revision) {
            throw new WorkflowExecutionError('SUBWORKFLOW_REVISION_MISMATCH', `expected ${request.templateId}@${request.revision}, received revision ${published.revision}`, { nodeId: request.nodeId })
          }
          const observe = createRunObserver(ctx, request.authority)
          const childAuthorityRef = this.authorityReference(request.authority)
          const child = engine.invoke({
            invocationId: request.invocationId,
            depth: request.depth,
            subworkflowDepthLimit: request.depthLimit,
            template: published.template,
            inputs: request.inputs,
            execution: {
              authorityRef: childAuthorityRef,
              authority: request.authority,
              origin: { type: 'host', source: 'dsh-subworkflow', sourceRef: request.parentRunId },
            },
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
      for (const run of runs) run.cancel('dag workflow service disposed')
      await Promise.all(runs.map(run => run.dispose()))
      this.active.clear()
    }, 'dsh-dag-workflow: active runs')
  }

  start(request: DshDagWorkflowStartRequest): WorkflowRun {
    const parent = request.parent
    if (!isDshAgentLike(parent)) throw new WorkflowExecutionError('DSH_AGENT_INVALID', 'parent must expose a DSH Session')
    const observe = createRunObserver(this.ctx, parent, request.onEvent)
    const authorityRef = this.authorityReference(parent)
    const run = this.engine.start({
      template: request.template,
      inputs: request.inputs,
      execution: { authorityRef, authority: parent, origin: { type: 'host', source: 'dsh' } },
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
      execution: { authorityRef: record.execution.authorityRef, authority: parent, origin: { type: 'host', source: 'dsh-resume' } },
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.unknownNodeResolutions === undefined ? {} : { unknownNodeResolutions: request.unknownNodeResolutions }),
      onEvent: observe,
    })
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
  for (const record of ctx.workflowRuns.listRecoverableRuns()) {
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
