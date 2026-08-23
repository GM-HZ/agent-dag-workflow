import { describe, expect, it } from 'vitest'
import {
  DagWorkflowEngine,
  InMemoryWorkflowRunStore,
  registerCoreNodes,
  WorkflowNodeRegistry,
  WorkflowPauseError,
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

function foreachWorkflowTemplate(): WorkflowTemplate {
  return {
    apiVersion: 'dsh.workflow/v1alpha1',
    kind: 'WorkflowTemplate',
    metadata: { id: 'foreach-flow', name: 'For each flow' },
    spec: {
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['items'],
        properties: { items: { type: 'array' } },
      },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['results'],
        properties: { results: { type: 'array' } },
      },
      nodes: [
        { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
        {
          id: 'map',
          uses: 'core.foreach@1',
          with: { templateId: 'item-worker', revision: 1, maxConcurrency: 1, maxItems: 4 },
          inputs: { items: { input: 'items' }, shared: { literal: { topic: 'test' } } },
        },
        { id: 'end', uses: 'core.end@1', with: {}, inputs: { results: { output: { node: 'map', path: ['results'] } } } },
      ],
      edges: [
        { id: 'start-map', source: 'start', target: 'map' },
        { id: 'map-end', source: 'map', target: 'end' },
      ],
      outputs: { results: { output: { node: 'end', path: ['results'] } } },
    },
  }
}

function subworkflowParentTemplate(): WorkflowTemplate {
  return {
    apiVersion: 'dsh.workflow/v1alpha1',
    kind: 'WorkflowTemplate',
    metadata: { id: 'subworkflow-parent', name: 'Subworkflow parent' },
    spec: {
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['value'],
        properties: { value: { type: 'string' } },
      },
      nodes: [
        { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
        { id: 'child', uses: 'core.subworkflow@1', with: { templateId: 'child', revision: 1 }, inputs: {} },
        { id: 'end', uses: 'core.end@1', with: {}, inputs: { value: { output: { node: 'child', path: ['outputs', 'value'] } } } },
      ],
      edges: [
        { id: 'start-child', source: 'start', target: 'child' },
        { id: 'child-end', source: 'child', target: 'end' },
      ],
      outputs: { value: { output: { node: 'end', path: ['value'] } } },
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

  it('reuses a deterministic nested invocation instead of replaying its effects', async () => {
    const store = new InMemoryWorkflowRunStore()
    let toolCalls = 0
    const engine = new DagWorkflowEngine(registry(), { tools: tools(() => { toolCalls++ }) }, { runStore: store })
    const request = {
      invocationId: 'parent:node:item:0',
      depth: 1,
      subworkflowDepthLimit: 8,
      template: toolWorkflowTemplate(),
      inputs: { message: 'nested' },
    } as const

    const first = await engine.invoke(request).result
    const second = await engine.invoke(request).result

    expect(first).toMatchObject({ status: 'completed', outputs: { answer: 'nested' } })
    expect(second).toMatchObject({ status: 'completed', runId: first.runId, outputs: { answer: 'nested' } })
    expect(toolCalls).toBe(1)
    expect(() => engine.invoke({ ...request, inputs: { message: 'different' } })).toThrowError(/different immutable inputs/)
  })

  it('recovers foreach container frames after a completed child result commit crashes', async () => {
    let progressCommits = 0
    const store = new OneShotFailingStore(events => {
      if (!events.some(event => event.type === 'node.progress' && event.nodeId === 'map')) return false
      progressCommits++
      return progressCommits === 3
    })
    const completed = new Map<string, { readonly runId: string; readonly outputs: { readonly value: JsonValue } }>()
    let childEffects = 0
    const subworkflows = {
      async execute(request: import('../src/index.js').WorkflowSubworkflowRequest) {
        const existing = completed.get(request.invocationId)
        if (existing !== undefined) return existing
        childEffects++
        const result = { runId: `child-${childEffects}`, outputs: { value: request.inputs.item! } }
        completed.set(request.invocationId, result)
        return result
      },
    }
    const firstEngine = new DagWorkflowEngine(registry(), { subworkflows }, { runStore: store })
    const first = firstEngine.start({ template: foreachWorkflowTemplate(), inputs: { items: ['a', 'b'] } })

    expect(await first.result).toMatchObject({ status: 'failed', error: 'simulated process crash before checkpoint commit' })
    expect(store.loadRun(first.id)?.checkpoint.nodeStates.map).toBe('running')
    expect(store.loadRun(first.id)?.checkpoint.nodeProgress.map).toMatchObject({
      kind: 'foreach',
      items: [{ index: 0, status: 'running' }, { index: 1, status: 'pending' }],
    })

    const result = await new DagWorkflowEngine(registry(), { subworkflows }, { runStore: store }).resume({ runId: first.id }).result

    expect(result).toMatchObject({
      status: 'completed',
      outputs: {
        results: [
          { index: 0, runId: 'child-1', outputs: { value: 'a' } },
          { index: 1, runId: 'child-2', outputs: { value: 'b' } },
        ],
      },
    })
    expect(childEffects).toBe(2)
  })

  it('pauses a parent when its durable child needs attention and resumes after an explicit retry', async () => {
    const store = new InMemoryWorkflowRunStore()
    let childResolved = false
    const subworkflows = {
      async execute() {
        if (!childResolved) throw new WorkflowPauseError('child run child-1 requires operator attention', 'child-1')
        return { runId: 'child-1', outputs: { value: 'resolved' } }
      },
    }
    const engine = new DagWorkflowEngine(registry(), { subworkflows }, { runStore: store })
    const run = engine.start({ template: subworkflowParentTemplate(), inputs: {} })
    const paused = await run.result

    expect(paused).toMatchObject({ status: 'paused', needsAttention: ['child'] })
    expect(store.loadRun(run.id)?.checkpoint.nodeStates.child).toBe('needs_attention')

    childResolved = true
    const result = await engine.resume({ runId: run.id, unknownNodeResolutions: { child: 'retry' } }).result
    expect(result).toMatchObject({ status: 'completed', outputs: { value: 'resolved' } })
  })
})
