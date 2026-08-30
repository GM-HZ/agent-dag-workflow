import { describe, expect, it, vi } from 'vitest'
import {
  DagWorkflowEngine,
  InMemoryWorkflowRunStore,
  MAX_WORKFLOW_COMMIT_BYTES,
  registerCoreNodes,
  validateRunStoreCommit,
  WorkflowNodeRegistry,
  WorkflowPauseError,
  type WorkflowEvent,
  type JsonValue,
  type WorkflowRunCheckpoint,
  type WorkflowToolRequest,
  type WorkflowTemplate,
} from '../../src/core/index.js'
import { toolWorkflowTemplate } from './fixtures.js'

const testExecution = { authorityRef: 'test:user', authority: { id: 'test-user' }, origin: { type: 'sdk' } } as const

class OneShotFailingStore extends InMemoryWorkflowRunStore {
  private armed = true

  constructor(private readonly shouldFail: (events: readonly WorkflowEvent[]) => boolean) {
    super()
  }

  override async commit(runId: string, expectedSeq: number, checkpoint: WorkflowRunCheckpoint, events: readonly WorkflowEvent[]): Promise<void> {
    if (this.armed && this.shouldFail(events)) {
      this.armed = false
      throw new Error('simulated process crash before checkpoint commit')
    }
    await super.commit(runId, expectedSeq, checkpoint, events)
  }
}

class DelayedCapturingStore extends InMemoryWorkflowRunStore {
  readonly commits: Array<{ readonly checkpoint: WorkflowRunCheckpoint; readonly events: readonly WorkflowEvent[] }> = []

  override async commit(runId: string, expectedSeq: number, checkpoint: WorkflowRunCheckpoint, events: readonly WorkflowEvent[]): Promise<void> {
    this.commits.push({ checkpoint: structuredClone(checkpoint), events: structuredClone(events) })
    await new Promise(resolve => setTimeout(resolve, 1))
    await super.commit(runId, expectedSeq, checkpoint, events)
  }
}

function registry(): WorkflowNodeRegistry {
  const result = new WorkflowNodeRegistry()
  registerCoreNodes(result)
  return result
}

function tools(onCall?: (request: WorkflowToolRequest) => void) {
  return {
    async execute(request: WorkflowToolRequest): Promise<JsonValue> {
      onCall?.(request)
      return { echo: request.inputs.message ?? null }
    },
  }
}

function approvalWorkflowTemplate(): WorkflowTemplate {
  return {
    apiVersion: 'workflow.gm-hz.dev/v1',
    kind: 'WorkflowTemplate',
    metadata: { id: 'approval-flow', name: 'Approval flow' },
    spec: {
      requires: [
        { kind: 'capability', uses: 'gateway.approval.request' },
        { kind: 'approval-action', uses: 'publish' },
      ],
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
          uses: 'human.approval@1',
          with: { action: 'publish', reason: 'Publish this artifact?' },
          inputs: { artifact: { literal: 'report' } },
        },
        {
          id: 'end',
          uses: 'core.end@1',
          with: {},
          inputs: { approved: { output: { nodeId: 'approval', path: ['approved'] } } },
        },
      ],
      edges: [
        { id: 'start-approval', source: 'start', target: 'approval' },
        { id: 'approval-end-yes', source: 'approval', target: 'end', sourcePort: 'approved' },
        { id: 'approval-end-no', source: 'approval', target: 'end', sourcePort: 'rejected' },
      ],
      outputs: { approved: { output: { nodeId: 'end', path: ['approved'] } } },
    },
  }
}

function foreachWorkflowTemplate(): WorkflowTemplate {
  return {
    apiVersion: 'workflow.gm-hz.dev/v1',
    kind: 'WorkflowTemplate',
    metadata: { id: 'foreach-flow', name: 'For each flow' },
    spec: {
      requires: [
        { kind: 'capability', uses: 'gateway.workflow.call' },
        { kind: 'workflow', uses: 'item-worker@1' },
      ],
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
          inputs: { items: { input: { path: ['items'] } }, shared: { literal: { topic: 'test' } } },
        },
        { id: 'end', uses: 'core.end@1', with: {}, inputs: { results: { output: { nodeId: 'map', path: ['results'] } } } },
      ],
      edges: [
        { id: 'start-map', source: 'start', target: 'map' },
        { id: 'map-end', source: 'map', target: 'end' },
      ],
      outputs: { results: { output: { nodeId: 'end', path: ['results'] } } },
    },
  }
}

function subworkflowParentTemplate(): WorkflowTemplate {
  return {
    apiVersion: 'workflow.gm-hz.dev/v1',
    kind: 'WorkflowTemplate',
    metadata: { id: 'subworkflow-parent', name: 'Subworkflow parent' },
    spec: {
      requires: [
        { kind: 'capability', uses: 'gateway.workflow.call' },
        { kind: 'workflow', uses: 'child@1' },
      ],
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['value'],
        properties: { value: { type: 'string' } },
      },
      nodes: [
        { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
        { id: 'child', uses: 'workflow.call@1', with: { templateId: 'child', revision: 1 }, inputs: {} },
        { id: 'end', uses: 'core.end@1', with: {}, inputs: { value: { output: { nodeId: 'child', path: ['outputs', 'value'] } } } },
      ],
      edges: [
        { id: 'start-child', source: 'start', target: 'child' },
        { id: 'child-end', source: 'child', target: 'end' },
      ],
      outputs: { value: { output: { nodeId: 'end', path: ['value'] } } },
    },
  }
}

describe('workflow run store and recovery', () => {
  it('serializes concurrent progress so every Journal event matches its atomic Checkpoint', async () => {
    const nodes = registry()
    nodes.register({
      type: 'test.concurrent-progress', version: 1, title: 'Concurrent progress', description: 'Exercises overlapping progress writes',
      configSchema: { type: 'object', additionalProperties: false }, inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
      outputPorts: ['success'], capabilities: [], effects: 'deterministic', retry: 'safe', implementationDigest: 'test-concurrent-progress-v1',
      async execute(context) {
        await Promise.all([
          context.checkpointProgress({ value: 'A' }),
          context.checkpointProgress({ value: 'B' }),
        ])
        return { outputs: {} }
      },
    })
    const template: WorkflowTemplate = {
      apiVersion: 'workflow.gm-hz.dev/v1', kind: 'WorkflowTemplate', metadata: { id: 'concurrent-progress', name: 'Concurrent progress' },
      spec: {
        inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'object', additionalProperties: false },
        nodes: [
          { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
          { id: 'progress', uses: 'test.concurrent-progress@1', with: {}, inputs: {} },
          { id: 'end', uses: 'core.end@1', with: {}, inputs: {} },
        ],
        edges: [{ id: 'start-progress', source: 'start', target: 'progress' }, { id: 'progress-end', source: 'progress', target: 'end' }],
        outputs: {},
      },
    }
    const store = new DelayedCapturingStore()
    const run = await new DagWorkflowEngine(nodes, {}, { runStore: store }).start({ execution: testExecution, template, inputs: {} })

    await expect(run.result).resolves.toMatchObject({ status: 'completed' })
    const progressCommits = store.commits.flatMap(({ checkpoint, events }) => events
      .filter((event): event is WorkflowEvent & { readonly type: 'node.progress' } => event.type === 'node.progress')
      .map(event => ({ journal: event.progress, checkpoint: checkpoint.nodeProgress[event.nodeId] })))
    expect(progressCommits).toEqual([
      { journal: { value: 'A' }, checkpoint: { value: 'A' } },
      { journal: { value: 'B' }, checkpoint: { value: 'B' } },
    ])
  })

  it('recovers a queued run when the process dies between run creation and its first Journal commit', async () => {
    const store = new OneShotFailingStore(events => events.some(event => event.type === 'run.accepted'))
    const firstEngine = new DagWorkflowEngine(registry(), { tools: tools() }, { runStore: store })
    await expect(firstEngine.queue({
      runId: 'queue-create-gap', execution: testExecution,
      template: toolWorkflowTemplate(), inputs: { message: 'recover-initial' },
    })).rejects.toThrow('simulated process crash')
    expect((await store.loadRun('queue-create-gap'))?.checkpoint).toMatchObject({ seq: 0, ready: ['start'], nodeStates: { start: 'ready' } })

    const resumed = await new DagWorkflowEngine(registry(), { tools: tools() }, { runStore: store })
      .resume({ runId: 'queue-create-gap', execution: testExecution })
    await expect(resumed.result).resolves.toMatchObject({ status: 'completed', outputs: { answer: 'recover-initial' } })
    expect((await store.readEvents('queue-create-gap')).slice(0, 5).map(event => event.type))
      .toEqual(['run.accepted', 'run.queued', 'node.ready', 'run.started', 'checkpoint.committed'])
  })

  it('rejects an oversized atomic checkpoint and Journal commit before storage', () => {
    const checkpoint: WorkflowRunCheckpoint = {
      version: 1, runId: 'oversized', semanticHash: 'hash', seq: 1, status: 'running',
      nodeStates: {}, edgeStates: {}, nodeOutputs: {}, nodeProgress: {}, ready: [], nodeRuns: 0,
      nodeAttempts: {}, depth: 0, subworkflowDepthLimit: 8, updatedAt: 1,
    }
    const event = {
      schemaVersion: 1, eventId: 'oversized:1', runId: 'oversized', seq: 1, type: 'run.started', occurredAt: 1,
      workflow: { id: 'oversized', semanticHash: 'hash', engineVersion: '1.0.0', nodeDefinitionSetHash: 'nodes' },
      correlation: { traceId: 'trace', spanId: 'span' }, origin: { type: 'sdk' },
      payload: { padding: 'x'.repeat(MAX_WORKFLOW_COMMIT_BYTES) },
    } as unknown as WorkflowEvent
    expect(() => validateRunStoreCommit('oversized', 0, checkpoint, [event])).toThrow(/commit is .*limit/)
  })

  it('journals contiguous events and a terminal checkpoint', async () => {
    const store = new InMemoryWorkflowRunStore()
    const engine = new DagWorkflowEngine(registry(), { tools: tools() }, { runStore: store, now: () => 100 })
    const run = await engine.start({ execution: testExecution, template: toolWorkflowTemplate(), inputs: { message: 'persisted' } })
    const result = await run.result
    const record = await store.loadRun(run.id)

    expect(result.status).toBe('completed')
    expect(record?.checkpoint).toMatchObject({ status: 'completed', resultOutputs: { answer: 'persisted' } })
    expect(record?.checkpoint.seq).toBe(record?.events.length)
    expect(record?.events.map(event => event.seq)).toEqual(record?.events.map((_, index) => index + 1))
    expect(record?.checkpoint.nodeOutputs.end).toEqual({ answer: 'persisted' })
    expect(await store.listRecoverableRuns()).toEqual([])
  })

  it('retries a safe node from its last running checkpoint', async () => {
    const store = new OneShotFailingStore(events => events.some(event => event.type === 'node.completed' && event.nodeId === 'start'))
    let toolCalls = 0
    const firstEngine = new DagWorkflowEngine(registry(), { tools: tools(() => { toolCalls++ }) }, { runStore: store })
    const first = await firstEngine.start({ execution: testExecution, template: toolWorkflowTemplate(), inputs: { message: 'resume-safe' } })
    const interrupted = await first.result

    expect(interrupted).toMatchObject({ status: 'failed', error: 'simulated process crash before checkpoint commit' })
    expect((await store.loadRun(first.id))?.checkpoint.nodeStates.start).toBe('running')
    expect(toolCalls).toBe(0)

    const resumed = await new DagWorkflowEngine(registry(), { tools: tools(() => { toolCalls++ }) }, { runStore: store }).resume({ execution: testExecution, runId: first.id })
    const result = await resumed.result

    expect(result.status).toBe('completed')
    expect(toolCalls).toBe(1)
    expect((await store.loadRun(first.id))?.events).toContainEqual(expect.objectContaining({ type: 'run.resumed' }))
  })

  it('pauses an unknown side-effect node until an operator explicitly retries it', async () => {
    const store = new OneShotFailingStore(events => events.some(event => event.type === 'node.completed' && event.nodeId === 'call'))
    let sideEffects = 0
    const invocationIds: string[] = []
    const recordCall = (request: WorkflowToolRequest) => { sideEffects++; invocationIds.push(request.invocationId) }
    const firstEngine = new DagWorkflowEngine(registry(), { tools: tools(recordCall) }, { runStore: store })
    const first = await firstEngine.start({ execution: testExecution, template: toolWorkflowTemplate(), inputs: { message: 'side-effect' } })
    expect((await first.result).status).toBe('failed')
    expect(sideEffects).toBe(1)
    expect((await store.loadRun(first.id))?.checkpoint.nodeStates.call).toBe('running')

    const recoveryEngine = new DagWorkflowEngine(registry(), { tools: tools(recordCall) }, { runStore: store })
    const paused = await (await recoveryEngine.resume({ execution: testExecution, runId: first.id })).result
    expect(paused).toMatchObject({ status: 'paused', needsAttention: ['call'] })
    expect(sideEffects).toBe(1)
    expect((await store.loadRun(first.id))?.checkpoint.nodeStates.call).toBe('needs_attention')

    const retried = await (await recoveryEngine.resume({ execution: testExecution,
      runId: first.id,
      unknownNodeResolutions: { call: 'retry' },
    })).result
    expect(retried.status).toBe('completed')
    expect(sideEffects).toBe(2)
    expect(invocationIds).toEqual([`${first.id}:call`, `${first.id}:call`])
  })

  it('detaches an executor without durably cancelling the recoverable run', async () => {
    const nodes = registry()
    let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    let executions = 0
    nodes.register({
      type: 'test.interruptible', version: 1, title: 'Interruptible', description: 'Executor interruption fixture',
      configSchema: { type: 'object', additionalProperties: false }, inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
      outputPorts: ['success'], capabilities: [], effects: 'deterministic', retry: 'safe', implementationDigest: 'test-interruptible-v1',
      async execute(context) {
        executions++
        if (executions > 1) return { outputs: { recovered: true } }
        started()
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true })
        })
        return { outputs: {} }
      },
    })
    const template: WorkflowTemplate = {
      apiVersion: 'workflow.gm-hz.dev/v1', kind: 'WorkflowTemplate', metadata: { id: 'interruptible', name: 'Interruptible' },
      spec: {
        inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
        nodes: [
          { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
          { id: 'work', uses: 'test.interruptible@1', with: {}, inputs: {} },
          { id: 'end', uses: 'core.end@1', with: {}, inputs: {} },
        ],
        edges: [{ id: 'a', source: 'start', target: 'work' }, { id: 'b', source: 'work', target: 'end' }], outputs: {},
      },
    }
    const store = new InMemoryWorkflowRunStore()
    const engine = new DagWorkflowEngine(nodes, {}, { runStore: store })
    const run = await engine.start({ execution: testExecution, template, inputs: {} })
    await entered
    await run.dispose('worker lease lost')

    const interrupted = await store.loadRun(run.id)
    expect(interrupted?.checkpoint).toMatchObject({ status: 'running', nodeStates: { work: 'running' } })
    expect(interrupted?.events.some(event => event.type === 'run.cancelled')).toBe(false)

    const resumed = await new DagWorkflowEngine(nodes, {}, { runStore: store }).resume({ execution: testExecution, runId: run.id })
    expect(await resumed.result).toMatchObject({ status: 'completed' })
    expect(executions).toBe(2)
  })

  it('bounds detach and maxDuration even when Host code ignores AbortSignal', async () => {
    const nodes = registry()
    nodes.register({
      type: 'test.noncooperative', version: 1, title: 'Noncooperative', description: 'Ignores cancellation',
      configSchema: { type: 'object', additionalProperties: false }, inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
      outputPorts: ['success'], capabilities: [], effects: 'deterministic', retry: 'safe', implementationDigest: 'test-noncooperative-v1',
      async execute() { return new Promise(() => {}) },
    })
    const template: WorkflowTemplate = {
      apiVersion: 'workflow.gm-hz.dev/v1', kind: 'WorkflowTemplate', metadata: { id: 'noncooperative', name: 'Noncooperative' },
      spec: {
        inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, policies: { maxDurationMs: 30 },
        nodes: [
          { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
          { id: 'work', uses: 'test.noncooperative@1', with: {}, inputs: {} },
          { id: 'end', uses: 'core.end@1', with: {}, inputs: {} },
        ],
        edges: [{ id: 'a', source: 'start', target: 'work' }, { id: 'b', source: 'work', target: 'end' }], outputs: {},
      },
    }
    const store = new InMemoryWorkflowRunStore()
    const deadlineRun = await new DagWorkflowEngine(nodes, {}, { runStore: store }).start({ execution: testExecution, template, inputs: {} })
    await expect(Promise.race([
      deadlineRun.result,
      new Promise((_, reject) => setTimeout(() => reject(new Error('deadline hung')), 250)),
    ])).resolves.toMatchObject({ status: 'failed', error: 'workflow duration exceeded' })

    const detachedTemplate = { ...template, metadata: { id: 'noncooperative-detach', name: 'Noncooperative detach' }, spec: { ...template.spec, policies: { maxDurationMs: 5_000 } } }
    const detached = await new DagWorkflowEngine(nodes, {}, { runStore: store }).start({ execution: testExecution, template: detachedTemplate, inputs: {} })
    await vi.waitFor(async () => expect((await store.loadRun(detached.id))?.checkpoint.nodeStates.work).toBe('running'))
    await expect(Promise.race([
      detached.dispose('runner stopped'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('detach hung')), 250)),
    ])).resolves.toBeUndefined()
    expect((await store.loadRun(detached.id))?.checkpoint.status).toBe('running')
    expect((await store.loadRun(detached.id))?.events.some(event => event.type === 'run.cancelled')).toBe(false)
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
    const first = await firstEngine.start({ execution: testExecution, template, inputs: { message: 'expired' } })
    expect((await first.result).status).toBe('failed')

    now = 100
    const result = await (await new DagWorkflowEngine(
      registry(),
      { tools: tools(() => { toolCalls++ }) },
      { runStore: store, now: () => now },
    ).resume({ execution: testExecution, runId: first.id })).result

    expect(result).toMatchObject({ status: 'failed', error: 'workflow duration exceeded' })
    expect(toolCalls).toBe(0)
    expect((await store.loadRun(first.id))?.checkpoint.status).toBe('failed')
  })

  it('commits a waiting checkpoint before calling the approval gateway', async () => {
    const store = new InMemoryWorkflowRunStore()
    let durableStatusAtRequest: string | undefined
    let waitingEventWasDurable = false
    const engine = new DagWorkflowEngine(registry(), {
      approvals: {
        async request(request) {
          const record = await store.loadRun(request.runId)
          durableStatusAtRequest = record?.checkpoint.nodeStates[request.nodeId]
          waitingEventWasDurable = record?.events.some(event => event.type === 'node.waiting' && event.nodeId === request.nodeId) ?? false
          return 'allowed-once'
        },
      },
    }, { runStore: store })

    const result = await (await engine.start({ execution: testExecution, template: approvalWorkflowTemplate(), inputs: {} })).result

    expect(result).toMatchObject({ status: 'completed', outputs: { approved: true } })
    expect(durableStatusAtRequest).toBe('waiting')
    expect(waitingEventWasDurable).toBe(true)
  })

  it('reuses a deterministic nested invocation instead of replaying its effects', async () => {
    const store = new InMemoryWorkflowRunStore()
    let toolCalls = 0
    const engine = new DagWorkflowEngine(registry(), { tools: tools(() => { toolCalls++ }) }, { runStore: store })
    const request = {
      execution: testExecution,
      invocationId: 'parent:node:item:0',
      depth: 1,
      subworkflowDepthLimit: 8,
      template: toolWorkflowTemplate(),
      inputs: { message: 'nested' },
    } as const

    const first = await (await engine.invoke(request)).result
    const second = await (await engine.invoke(request)).result

    expect(first).toMatchObject({ status: 'completed', outputs: { answer: 'nested' } })
    expect(second).toMatchObject({ status: 'completed', runId: first.runId, outputs: { answer: 'nested' } })
    expect(toolCalls).toBe(1)
    await expect(engine.invoke({ ...request, inputs: { message: 'different' } })).rejects.toThrowError(/different immutable inputs/)
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
      async execute(request: import('../../src/core/index.js').WorkflowSubworkflowRequest) {
        const existing = completed.get(request.invocationId)
        if (existing !== undefined) return existing
        childEffects++
        const result = { runId: `child-${childEffects}`, outputs: { value: request.inputs.item! } }
        completed.set(request.invocationId, result)
        return result
      },
    }
    const firstEngine = new DagWorkflowEngine(registry(), { subworkflows }, { runStore: store })
    const first = await firstEngine.start({ execution: testExecution, template: foreachWorkflowTemplate(), inputs: { items: ['a', 'b'] } })

    expect(await first.result).toMatchObject({ status: 'failed', error: 'simulated process crash before checkpoint commit' })
    expect((await store.loadRun(first.id))?.checkpoint.nodeStates.map).toBe('running')
    expect((await store.loadRun(first.id))?.checkpoint.nodeProgress.map).toMatchObject({
      kind: 'foreach',
      items: [{ index: 0, status: 'running' }, { index: 1, status: 'pending' }],
    })

    const result = await (await new DagWorkflowEngine(registry(), { subworkflows }, { runStore: store }).resume({ execution: testExecution, runId: first.id })).result

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
    const run = await engine.start({ execution: testExecution, template: subworkflowParentTemplate(), inputs: {} })
    const paused = await run.result

    expect(paused).toMatchObject({ status: 'paused', needsAttention: ['child'] })
    expect((await store.loadRun(run.id))?.checkpoint.nodeStates.child).toBe('needs_attention')

    childResolved = true
    const result = await (await engine.resume({ execution: testExecution, runId: run.id, unknownNodeResolutions: { child: 'retry' } })).result
    expect(result).toMatchObject({ status: 'completed', outputs: { value: 'resolved' } })
  })

  it('persists a terminal failure when the assembled Workflow result exceeds its limit', async () => {
    const value = 'x'.repeat(35)
    const template: WorkflowTemplate = {
      apiVersion: 'workflow.gm-hz.dev/v1', kind: 'WorkflowTemplate',
      metadata: { id: 'terminal-size', name: 'Terminal size' },
      spec: {
        inputSchema: { type: 'object', additionalProperties: false },
        outputSchema: {
          type: 'object', additionalProperties: false, required: ['a', 'b'],
          properties: { a: { type: 'string' }, b: { type: 'string' } },
        },
        nodes: [
          { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
          { id: 'end-a', uses: 'core.end@1', with: {}, inputs: { a: { literal: value } } },
          { id: 'end-b', uses: 'core.end@1', with: {}, inputs: { b: { literal: value } } },
        ],
        edges: [
          { id: 'start-a', source: 'start', target: 'end-a' },
          { id: 'start-b', source: 'start', target: 'end-b' },
        ],
        outputs: {
          a: { output: { nodeId: 'end-a', path: ['a'] } },
          b: { output: { nodeId: 'end-b', path: ['b'] } },
        },
        policies: { maxOutputBytes: 60 },
      },
    }
    const store = new InMemoryWorkflowRunStore()
    const run = await new DagWorkflowEngine(registry(), {}, { runStore: store }).start({ execution: testExecution, template, inputs: {} })

    await expect(run.result).resolves.toMatchObject({ status: 'failed', error: expect.stringContaining('workflow result is') })
    expect((await store.loadRun(run.id))?.checkpoint).toMatchObject({ status: 'failed', error: expect.stringContaining('workflow result is') })
    expect((await store.loadRun(run.id))?.events).toContainEqual(expect.objectContaining({ type: 'run.failed' }))
  })

  it('keeps durable cancellation available after deployment ceilings are tightened', async () => {
    const store = new InMemoryWorkflowRunStore()
    const template = toolWorkflowTemplate()
    const queued = await new DagWorkflowEngine(registry(), { tools: tools() }, { runStore: store }).queue({
      execution: testExecution,
      template,
      inputs: { message: 'cancel me' },
    })
    const strict = new DagWorkflowEngine(registry(), { tools: tools() }, {
      runStore: store,
      deploymentLimits: { maxDurationMs: 1_000 },
    })

    const cancelled = await strict.cancel({ runId: queued.id, execution: testExecution, reason: 'policy changed' })

    await expect(cancelled.result).resolves.toMatchObject({ status: 'cancelled', error: 'policy changed' })
    expect((await store.loadRun(queued.id))?.checkpoint.status).toBe('cancelled')
    await expect(strict.cancel({ runId: queued.id, execution: testExecution, reason: 'x'.repeat(4_097) }))
      .rejects.toMatchObject({ code: 'CANCEL_REASON_INVALID' })
  })
})
