import { Context, Service } from '@deepseek-ai/cordis'
import {
  DagWorkflowEngine as CoreDagWorkflowEngine,
  WorkflowExecutionError,
  WorkflowNodeRegistry,
  compileWorkflowOrThrow,
  registerCoreNodes,
  type WorkflowEvent,
  type WorkflowNodeDefinition,
  type WorkflowNodeDisposer,
  type WorkflowRun,
} from '@gm-hz/dsh-workflow-core'
import type {
  DagWorkflowNodeEndData,
  DagWorkflowNodeStartData,
  DagWorkflowRunEndData,
  DagWorkflowRunStartData,
  DshAgentLike,
  DshDagWorkflowStartRequest,
  DshToolRuntimeLike,
  DshWorkflowPluginConfig,
} from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    workflowNodes: WorkflowNodeRegistryService
    dagWorkflowEngine: DagWorkflowEngineService
  }

  interface Events {
    'dag-workflow/event'(event: WorkflowEvent, parent: DshAgentLike): void
  }
}

type DshRuntimeContext = Context & { readonly tools: DshToolRuntimeLike }

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
}

export class DagWorkflowEngineProvider extends DagWorkflowEngineService {
  static inject = ['tools', 'workflowNodes']

  private readonly engine: CoreDagWorkflowEngine
  private readonly active = new Set<WorkflowRun>()
  private readonly recordSessionEvents: boolean

  constructor(ctx: Context, config: DshWorkflowPluginConfig = {}) {
    super(ctx)
    const tools = (ctx as DshRuntimeContext).tools
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
    })
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
    let recordingEnabled = this.recordSessionEvents
    const observe = (event: WorkflowEvent): void => {
      if (recordingEnabled) {
        try {
          appendSessionSummary(parent, event, request.template.metadata.id, compiled.semanticHash)
        } catch (error: unknown) {
          recordingEnabled = false
          this.ctx.logger.warn(`dsh-dag-workflow: disabled Session recording: ${renderError(error)}`)
        }
      }
      try {
        this.ctx.emit('dag-workflow/event', event, parent)
      } catch (error: unknown) {
        this.ctx.logger.warn(`dsh-dag-workflow: event listener failed: ${renderError(error)}`)
      }
      try {
        request.onEvent?.(event)
      } catch (error: unknown) {
        this.ctx.logger.warn(`dsh-dag-workflow: request observer failed: ${renderError(error)}`)
      }
    }
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
    case 'node.started': {
      const data: DagWorkflowNodeStartData = { runId: event.runId, nodeId: event.nodeId }
      parent.session.append('dsh-dag-workflow/node-start', data)
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
    default:
      return
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
