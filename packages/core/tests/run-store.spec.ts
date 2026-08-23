import { describe, expect, it } from 'vitest'
import {
  DagWorkflowEngine,
  InMemoryWorkflowRunStore,
  registerCoreNodes,
  WorkflowNodeRegistry,
  type WorkflowEvent,
  type JsonValue,
  type WorkflowRunCheckpoint,
  type WorkflowToolRequest,
  type WorkflowTemplate,
} from '../src/index.js'
import { toolWorkflowTemplate } from './fixtures.js'

class OneShotFailingStore extends InMemoryWorkflowRunStore {
  private armed = true

  constructor(private readonly shouldFail: (events: readonly WorkflowEvent[]) => boolean) {
    super()
  }

  override commit(runId: string, expectedSeq: number, checkpoint: WorkflowRunCheckpoint, events: readonly WorkflowEvent[]): void {
    if (this.armed && this.shouldFail(events)) {
      this.armed = false
      throw new Error('simulated process crash before checkpoint commit')
    }
    super.commit(runId, expectedSeq, checkpoint, events)
  }
}

function registry(): WorkflowNodeRegistry {
  const result = new WorkflowNodeRegistry()
  registerCoreNodes(result)
  return result
}

function tools(onCall?: () => void) {
  return {
    async execute(request: WorkflowToolRequest): Promise<JsonValue> {
      onCall?.()
      return { echo: request.input.message ?? null }
    },
  }
}

function approvalWorkflowTemplate(): WorkflowTemplate {
  return {
    apiVersion: 'dsh.workflow/v1alpha1',
    kind: 'WorkflowTemplate',
    metadata: { id: 'approval-flow', name: 'Approval flow' },
    spec: {
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['approved'],
        properties: { approved: { type: 'boolean' } },
      },
      nodes: [
        { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
        {
          id: 'approval',
          uses: 'dsh.human-approval@1',
          with: { action: 'publish', reason: 'Publish this artifact?' },
          inputs: { artifact: { literal: 'report' } },
        },
        {
          id: 'end',
          uses: 'core.end@1',
          with: {},
          inputs: { approved: { output: { node: 'approval', path: ['approved'] } } },
        },
      ],
      edges: [
        { id: 'start-approval', source: 'start', target: 'approval' },
        { id: 'approval-end-yes', source: 'approval', target: 'end', sourcePort: 'approved' },
        { id: 'approval-end-no', source: 'approval', target: 'end', sourcePort: 'rejected' },
      ],
      outputs: { approved: { output: { node: 'end', path: ['approved'] } } },
    },
  }
}

describe('workflow run store and recovery', () => {
  it('journals contiguous events and a terminal checkpoint', async () => {
    const store = new InMemoryWorkflowRunStore()
    const engine = new DagWorkflowEngine(registry(), { tools: tools() }, { runStore: store, now: () => 100 })
    const run = engine.start({ template: toolWorkflowTemplate(), inputs: { message: 'persisted' } })
    const result = await run.result
    const record = store.loadRun(run.id)

    expect(result.status).toBe('completed')
    expect(record?.checkpoint).toMatchObject({ status: 'completed', resultOutputs: { answer: 'persisted' } })
    expect(record?.checkpoint.seq).toBe(record?.events.length)
    expect(record?.events.map(event => event.seq)).toEqual(record?.events.map((_, index) => index + 1))
    expect(record?.checkpoint.nodeOutputs.end).toEqual({ answer: 'persisted' })
    expect(store.listRecoverableRuns()).toEqual([])
  })

  it('retries a safe node from its last running checkpoint', async () => {
    const store = new OneShotFailingStore(events => events.some(event => event.type === 'node.completed' && event.nodeId === 'start'))
    let toolCalls = 0
    const firstEngine = new DagWorkflowEngine(registry(), { tools: tools(() => { toolCalls++ }) }, { runStore: store })
    const first = firstEngine.start({ template: toolWorkflowTemplate(), inputs: { message: 'resume-safe' } })
    const interrupted = await first.result

    expect(interrupted).toMatchObject({ status: 'failed', error: 'simulated process crash before checkpoint commit' })
    expect(store.loadRun(first.id)?.checkpoint.nodeStates.start).toBe('running')
    expect(toolCalls).toBe(0)

    const resumed = new DagWorkflowEngine(registry(), { tools: tools(() => { toolCalls++ }) }, { runStore: store }).resume({ runId: first.id })
    const result = await resumed.result

    expect(result.status).toBe('completed')
    expect(toolCalls).toBe(1)
    expect(store.loadRun(first.id)?.events).toContainEqual(expect.objectContaining({ type: 'run.resumed' }))
  })

  it('pauses an unknown side-effect node until an operator explicitly retries it', async () => {
    const store = new OneShotFailingStore(events => events.some(event => event.type === 'node.completed' && event.nodeId === 'call'))
    let sideEffects = 0
    const firstEngine = new DagWorkflowEngine(registry(), { tools: tools(() => { sideEffects++ }) }, { runStore: store })
    const first = firstEngine.start({ template: toolWorkflowTemplate(), inputs: { message: 'side-effect' } })
    expect((await first.result).status).toBe('failed')
    expect(sideEffects).toBe(1)
    expect(store.loadRun(first.id)?.checkpoint.nodeStates.call).toBe('running')

    const recoveryEngine = new DagWorkflowEngine(registry(), { tools: tools(() => { sideEffects++ }) }, { runStore: store })
    const paused = await recoveryEngine.resume({ runId: first.id }).result
    expect(paused).toMatchObject({ status: 'paused', needsAttention: ['call'] })
    expect(sideEffects).toBe(1)
    expect(store.loadRun(first.id)?.checkpoint.nodeStates.call).toBe('needs_attention')

    const retried = await recoveryEngine.resume({
      runId: first.id,
      unknownNodeResolutions: { call: 'retry' },
    }).result
    expect(retried.status).toBe('completed')
    expect(sideEffects).toBe(2)
  })

  it('does not reset the total duration budget when a run is resumed', async () => {
    const store = new OneShotFailingStore(events => events.some(event => event.type === 'node.completed' && event.nodeId === 'start'))
    const baseTemplate = toolWorkflowTemplate()
    const template = {
      ...baseTemplate,
      spec: {
        ...baseTemplate.spec,
        policies: { ...baseTemplate.spec.policies, maxDurationMs: 10 },
      },
    }
    let now = 0
    let toolCalls = 0
    const firstEngine = new DagWorkflowEngine(
      registry(),
      { tools: tools(() => { toolCalls++ }) },
      { runStore: store, now: () => now },
    )
    const first = firstEngine.start({ template, inputs: { message: 'expired' } })
    expect((await first.result).status).toBe('failed')

    now = 100
    const result = await new DagWorkflowEngine(
      registry(),
      { tools: tools(() => { toolCalls++ }) },
      { runStore: store, now: () => now },
    ).resume({ runId: first.id }).result

    expect(result).toMatchObject({ status: 'failed', error: 'workflow duration exceeded' })
    expect(toolCalls).toBe(0)
    expect(store.loadRun(first.id)?.checkpoint.status).toBe('failed')
  })

  it('commits a waiting checkpoint before calling the approval gateway', async () => {
    const store = new InMemoryWorkflowRunStore()
    let durableStatusAtRequest: string | undefined
    let waitingEventWasDurable = false
    const engine = new DagWorkflowEngine(registry(), {
      approvals: {
        async request(request) {
          const record = store.loadRun(request.runId)
          durableStatusAtRequest = record?.checkpoint.nodeStates[request.nodeId]
          waitingEventWasDurable = record?.events.some(event => event.type === 'node.waiting' && event.nodeId === request.nodeId) ?? false
          return 'allowed-once'
        },
      },
    }, { runStore: store })

    const result = await engine.start({ template: approvalWorkflowTemplate(), inputs: {} }).result

    expect(result).toMatchObject({ status: 'completed', outputs: { approved: true } })
    expect(durableStatusAtRequest).toBe('waiting')
    expect(waitingEventWasDurable).toBe(true)
  })
})
