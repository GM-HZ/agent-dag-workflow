import { describe, expect, it, vi } from 'vitest'
import { WorkflowTemplateCatalog } from '../../src/catalog/index.js'
import { InMemoryWorkflowCatalogRepository } from '../../src/catalog/repository.js'
import {
  InMemoryWorkflowRunStore,
  endNodeDefinition,
  startNodeDefinition,
  WorkflowNodeRegistry,
  registerCoreNodes,
  type WorkflowEvent,
  type WorkflowRunCheckpoint,
  type WorkflowTemplate,
  type WorkflowNodeDefinition,
} from '../../src/core/index.js'
import { WorkflowLiveEventBus, WorkflowRuntime, type WorkflowLiveEvent } from '../../src/runtime/index.js'
import { InMemoryWorkflowArtifactStore, type WorkflowArtifactStore } from '../../src/journal/index.js'
import { toolWorkflowTemplate } from './fixtures.js'
import { InMemoryWorkflowRunCoordinator, WorkflowRunWorker } from '../../src/triggers/core/index.js'

function setup() {
  const nodes = new WorkflowNodeRegistry()
  registerCoreNodes(nodes)
  const catalog = new WorkflowTemplateCatalog(new InMemoryWorkflowCatalogRepository(), nodes)
  const runs = new InMemoryWorkflowRunStore()
  const execute = vi.fn(async (request: import('../../src/core/index.js').WorkflowToolRequest) => ({ echo: request.inputs.message ?? null }))
  const runtime = new WorkflowRuntime({
    nodes, catalog, runStore: runs, services: { tools: { execute } },
    authorityResolver: { async resolve(ref) { return { ref } } },
  })
  return { runtime, catalog, runs, execute }
}

describe('host-neutral WorkflowRuntime', () => {
  it('bounds ephemeral live-event buffering and keeps the newest deltas', async () => {
    const bus = new WorkflowLiveEventBus(2)
    const stream = bus.subscribe('run-live')[Symbol.asyncIterator]()
    const event = (liveSeq: number): WorkflowLiveEvent => ({
      schemaVersion: 1,
      runId: 'run-live',
      nodeId: 'agent',
      invocationId: 'run-live:agent:1',
      liveSeq,
      type: 'node.message.delta',
      data: { text: String(liveSeq) },
    })
    bus.publish(event(1))
    bus.publish(event(2))
    bus.publish(event(3))
    expect((await stream.next()).value?.liveSeq).toBe(2)
    expect((await stream.next()).value?.liveSeq).toBe(3)
    bus.close('run-live')
    expect((await stream.next()).done).toBe(true)
  })

  it('projects checkpointed progress live, persists it in Journal, and closes subscriptions', async () => {
    const nodes = new WorkflowNodeRegistry()
    nodes.register(startNodeDefinition)
    nodes.register(endNodeDefinition)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const progressNode: WorkflowNodeDefinition = {
      type: 'test.progress', version: 1, title: 'Progress', description: 'Checkpoint progress',
      configSchema: { type: 'object', additionalProperties: false }, inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
      outputPorts: ['success'], capabilities: [], effects: 'deterministic', retry: 'safe', implementationDigest: 'test-progress-v1',
      async execute(context) { await gate; await context.checkpointProgress({ percent: 50 }); return { outputs: { done: true } } },
    }
    nodes.register(progressNode)
    const template: WorkflowTemplate = {
      apiVersion: 'workflow.gm-hz.dev/v1', kind: 'WorkflowTemplate', metadata: { id: 'live-progress', name: 'Live progress' },
      spec: {
        inputSchema: { type: 'object' }, outputSchema: { type: 'object', required: ['done'], properties: { done: { type: 'boolean' } } },
        nodes: [
          { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
          { id: 'progress', uses: 'test.progress@1', with: {}, inputs: {} },
          { id: 'end', uses: 'core.end@1', with: {}, inputs: { done: { output: { nodeId: 'progress', path: ['done'] } } } },
        ],
        edges: [{ id: 'a', source: 'start', target: 'progress' }, { id: 'b', source: 'progress', target: 'end' }],
        outputs: { done: { output: { nodeId: 'end', path: ['done'] } } },
      },
    }
    const runs = new InMemoryWorkflowRunStore()
    const runtime = new WorkflowRuntime({ nodes, catalog: new WorkflowTemplateCatalog(new InMemoryWorkflowCatalogRepository(), nodes), runStore: runs })
    const handle = await runtime.launch({ target: { type: 'inline', template }, inputs: {}, authorityRef: 'live:test', authority: {}, origin: { type: 'sdk' } })
    const stream = handle.live()[Symbol.asyncIterator]()
    release()
    const live = await stream.next()
    expect(live.value).toMatchObject({ runId: handle.runId, nodeId: 'progress', type: 'node.progress', data: { progress: { percent: 50 } } })
    expect(await handle.result).toMatchObject({ status: 'completed', outputs: { done: true } })
    expect((await stream.next()).done).toBe(true)
    const journal = (await runtime.readEvents(handle.runId, { limit: 100 })).events.find(event => event.type === 'node.progress')
    expect(journal?.seq).toBe(live.value?.liveSeq)
    expect(journal?.payload).toEqual({ progress: { percent: 50 } })

    const controller = new AbortController()
    const cancelled = new WorkflowLiveEventBus().subscribe('never', controller.signal)[Symbol.asyncIterator]()
    controller.abort()
    expect((await cancelled.next()).done).toBe(true)
  })

  it('pins implementation digests and refuses incompatible or non-replayable plans', async () => {
    const nodes = new WorkflowNodeRegistry()
    let disposeStart = nodes.register({ ...startNodeDefinition, implementationDigest: 'start-build-a' })
    let disposeEnd = nodes.register({ ...endNodeDefinition, implementationDigest: 'end-build-a' })
    const catalog = new WorkflowTemplateCatalog(new InMemoryWorkflowCatalogRepository(), nodes)
    const runs = new InMemoryWorkflowRunStore()
    const template: WorkflowTemplate = {
      apiVersion: 'workflow.gm-hz.dev/v1', kind: 'WorkflowTemplate', metadata: { id: 'digest-lock', name: 'Digest lock' },
      spec: { inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, nodes: [
        { id: 'start', uses: 'core.start@1', with: {}, inputs: {} }, { id: 'end', uses: 'core.end@1', with: {}, inputs: {} },
      ], edges: [{ id: 'edge', source: 'start', target: 'end' }], outputs: {} },
    }
    const runtime = new WorkflowRuntime({ nodes, catalog, runStore: runs })
    const source = await runtime.launch({ target: { type: 'inline', template }, inputs: {}, authorityRef: 'digest:test', authority: {}, origin: { type: 'sdk' } })
    expect((await source.result).status).toBe('completed')
    disposeStart(); disposeEnd()
    disposeStart = nodes.register({ ...startNodeDefinition, implementationDigest: 'start-build-b' })
    disposeEnd = nodes.register({ ...endNodeDefinition, implementationDigest: 'end-build-b' })
    await expect(runtime.resume({ runId: source.runId, authorityRef: 'digest:test', authority: {} })).rejects.toThrow('node definition set hash')
    disposeStart(); disposeEnd()

    const { implementationDigest: _startDigest, ...startWithoutDigest } = startNodeDefinition
    const { implementationDigest: _endDigest, ...endWithoutDigest } = endNodeDefinition
    nodes.register(startWithoutDigest)
    nodes.register(endWithoutDigest)
    const nonReplayable = await runtime.launch({ target: { type: 'inline', template: { ...template, metadata: { id: 'missing-digest', name: 'Missing digest' } } }, inputs: {}, authorityRef: 'digest:test', authority: {}, origin: { type: 'sdk' } })
    expect((await nonReplayable.result).status).toBe('completed')
    expect((await runs.loadRun(nonReplayable.runId))?.plan.replayable).toBe(false)
    await expect(runtime.replay({ runId: nonReplayable.runId, mode: 'recorded' })).rejects.toThrow('implementation digests')
  })

  it('locks published plans, emits envelope v1, pages Journal, and replays without external calls', async () => {
    const { runtime, catalog, runs, execute } = setup()
    const draft = await catalog.createDraft(toolWorkflowTemplate())
    const published = await catalog.publish(draft.id, draft.revision)
    const handle = await runtime.launch({
      target: { type: 'published', id: published.id, revision: published.revision },
      inputs: { message: 'runtime' }, authorityRef: 'user:1', origin: { type: 'sdk' },
    })
    expect(await handle.result).toMatchObject({ status: 'completed', outputs: { answer: 'runtime' } })
    const record = await runs.loadRun(handle.runId)
    expect(record?.plan).toMatchObject({
      root: { id: published.id, revision: 1, semanticHash: published.semanticHash },
      engineVersion: '1.0.0', replayable: true,
    })
    expect(record?.events.map(event => event.type)).toEqual(expect.arrayContaining([
      'run.accepted', 'run.queued', 'capability.requested', 'capability.completed', 'node.output-validated', 'node.output-committed',
    ]))
    expect(record?.events.every(event => event.schemaVersion === 1 && event.eventId === `${event.runId}:${event.seq}`)).toBe(true)
    const firstPage = await runtime.readEvents(handle.runId, { limit: 3 })
    expect(firstPage.events).toHaveLength(3)
    expect(firstPage.nextAfterSeq).toBe(3)
    expect((await runtime.readEvents(handle.runId, { afterSeq: 3 })).events[0]?.seq).toBe(4)

    const recorded = await runtime.replay({ runId: handle.runId, mode: 'recorded' })
    const recordedResult = await recorded.result
    expect(recorded.runId).not.toBe(handle.runId)
    expect(recordedResult).toMatchObject({ status: 'completed', outputs: { answer: 'runtime' } })
    expect(recordedResult.events.map(event => event.type)).toContain('capability.replayed')
    expect(execute).toHaveBeenCalledTimes(1)
    const live = await runtime.replay({ runId: handle.runId, mode: 'live', authorityRef: 'user:1' })
    expect(await live.result).toMatchObject({ status: 'completed' })
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('uses explicit effects metadata to record and replay custom external nodes', async () => {
    const nodes = new WorkflowNodeRegistry()
    registerCoreNodes(nodes)
    let effects = 0
    nodes.register({
      type: 'custom.external', version: 1, title: 'External', description: 'Custom external effect',
      configSchema: { type: 'object', additionalProperties: false }, inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
      outputPorts: ['success'], capabilities: [], effects: 'external', retry: 'never', implementationDigest: 'custom-external-v1',
      async execute() { effects++; return { outputs: { value: `effect-${effects}` } } },
    })
    const template: WorkflowTemplate = {
      apiVersion: 'workflow.gm-hz.dev/v1', kind: 'WorkflowTemplate', metadata: { id: 'custom-external', name: 'Custom external' },
      spec: {
        inputSchema: { type: 'object' }, outputSchema: { type: 'object', required: ['value'], properties: { value: { type: 'string' } } },
        nodes: [
          { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
          { id: 'external', uses: 'custom.external@1', with: {}, inputs: {} },
          { id: 'end', uses: 'core.end@1', with: {}, inputs: { value: { output: { nodeId: 'external', path: ['value'] } } } },
        ],
        edges: [{ id: 'a', source: 'start', target: 'external' }, { id: 'b', source: 'external', target: 'end' }],
        outputs: { value: { output: { nodeId: 'end', path: ['value'] } } },
      },
    }
    const runtime = new WorkflowRuntime({
      nodes,
      catalog: new WorkflowTemplateCatalog(new InMemoryWorkflowCatalogRepository(), nodes),
      runStore: new InMemoryWorkflowRunStore(),
      artifactStore: new InMemoryWorkflowArtifactStore(),
      capturePolicy: { mode: 'replayable', maxArtifactBytes: 4096 },
    })
    const source = await runtime.launch({ target: { type: 'inline', template }, inputs: {}, authorityRef: 'test:external', authority: {}, origin: { type: 'sdk' } })
    expect(await source.result).toMatchObject({ status: 'completed', outputs: { value: 'effect-1' } })
    const replay = await runtime.replay({ runId: source.runId, mode: 'recorded' })
    expect(await replay.result).toMatchObject({ status: 'completed', outputs: { value: 'effect-1' } })
    expect(effects).toBe(1)
  })

  it('deduplicates concurrent SDK launches within one runtime authority scope', async () => {
    const { runtime, catalog, runs, execute } = setup()
    const draft = await catalog.createDraft(toolWorkflowTemplate())
    await catalog.publish(draft.id, draft.revision)
    const secondRuntime = new WorkflowRuntime({
      nodes: (() => { const value = new WorkflowNodeRegistry(); registerCoreNodes(value); return value })(),
      catalog,
      runStore: runs,
      services: { tools: { execute } },
      authorityResolver: { async resolve(ref) { return { ref } } },
    })
    const request = {
      target: { type: 'published' as const, id: draft.id, revision: 1 }, inputs: { message: 'once' },
      authorityRef: 'user:1', origin: { type: 'sdk' }, idempotencyKey: 'request-1',
    }
    const [left, right, acrossRuntime] = await Promise.all([
      runtime.launch(request), runtime.launch(request), secondRuntime.launch(request),
    ])
    expect(left.runId).toBe(right.runId)
    expect(left.runId).toBe(acrossRuntime.runId)
    await Promise.all([left.result, right.result, acrossRuntime.result])
    expect(execute).toHaveBeenCalledTimes(1)

    await expect(secondRuntime.launch({ ...request, inputs: { message: 'different' } }))
      .rejects.toThrow('different immutable launch')
  })

  it('persists a background launch without executing it in the ingress process', async () => {
    const nodes = new WorkflowNodeRegistry()
    registerCoreNodes(nodes)
    const catalog = new WorkflowTemplateCatalog(new InMemoryWorkflowCatalogRepository(), nodes)
    const runs = new InMemoryWorkflowRunStore()
    const queue = new InMemoryWorkflowRunCoordinator()
    const execute = vi.fn(async (request: import('../../src/core/index.js').WorkflowToolRequest) => ({ echo: request.inputs.message ?? null }))
    const runtime = new WorkflowRuntime({
      nodes, catalog, runStore: runs, queue, services: { tools: { execute } },
      authorityResolver: { async resolve(ref) { return { ref } } },
    })
    const draft = await catalog.createDraft(toolWorkflowTemplate())
    await catalog.publish(draft.id, draft.revision)
    const handle = await runtime.launch({
      target: { type: 'published', id: draft.id, revision: 1 }, inputs: { message: 'background' },
      authorityRef: 'worker:user', origin: { type: 'trigger', source: 'test' },
      idempotencyKey: 'event-1', executionMode: 'background',
    })
    expect(execute).not.toHaveBeenCalled()
    expect((await runtime.getRun(handle.runId))?.status).toBe('running')
    expect((await runtime.readEvents(handle.runId, { limit: 100 })).events.map(event => event.type))
      .toEqual(['run.accepted', 'run.queued', 'node.ready', 'checkpoint.committed'])

    const workerResult = await new WorkflowRunWorker(runtime, queue).runOnce({ workerId: 'worker-1', leaseMs: 1_000 })
    expect(workerResult).toMatchObject({ status: 'completed', outputs: { answer: 'background' } })
    expect(await handle.result).toMatchObject({ status: 'completed', outputs: { answer: 'background' } })
    expect(execute).toHaveBeenCalledTimes(1)
    expect((await runtime.readEvents(handle.runId, { limit: 100 })).events.map(event => event.type)).toContain('run.started')

    const duplicate = await runtime.launch({
      target: { type: 'published', id: draft.id, revision: 1 }, inputs: { message: 'background' },
      authorityRef: 'worker:user', origin: { type: 'trigger', source: 'retry' },
      idempotencyKey: 'event-1', executionMode: 'background',
    })
    expect(duplicate.runId).toBe(handle.runId)
    expect(await queue.claim({ workerId: 'worker-2', leaseMs: 1_000 })).toBeUndefined()
  })

  it('durably cancels an active run obtained through an idempotent persisted handle', async () => {
    const nodes = new WorkflowNodeRegistry()
    registerCoreNodes(nodes)
    const catalog = new WorkflowTemplateCatalog(new InMemoryWorkflowCatalogRepository(), nodes)
    const runs = new InMemoryWorkflowRunStore()
    const queue = new InMemoryWorkflowRunCoordinator()
    const execute = vi.fn(async () => ({ echo: 'must-not-run' }))
    const runtime = new WorkflowRuntime({
      nodes, catalog, runStore: runs, queue, services: { tools: { execute } },
      authorityResolver: { async resolve(ref) { return { ref } } },
    })
    const draft = await catalog.createDraft(toolWorkflowTemplate())
    await catalog.publish(draft.id, draft.revision)
    const request = {
      target: { type: 'published' as const, id: draft.id, revision: 1 }, inputs: { message: 'cancel' },
      authorityRef: 'worker:cancel', origin: { type: 'trigger', source: 'cancel-test' },
      idempotencyKey: 'cancel-event', executionMode: 'background' as const,
    }
    const accepted = await runtime.launch(request)
    const recovered = await runtime.launch(request)

    await recovered.cancel('operator cancelled')

    expect(await runtime.getRun(accepted.runId)).toMatchObject({ status: 'cancelled', error: 'operator cancelled' })
    await expect(recovered.result).resolves.toMatchObject({ status: 'cancelled', error: 'operator cancelled' })
    await expect(accepted.result).resolves.toMatchObject({ status: 'cancelled', error: 'operator cancelled' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('durably cancels an active noncooperative Host node without waiting for it', async () => {
    const nodes = new WorkflowNodeRegistry(); registerCoreNodes(nodes)
    nodes.register({
      type: 'test.never', version: 1, title: 'Never', description: 'Never settles',
      configSchema: { type: 'object', additionalProperties: false }, inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
      outputPorts: ['success'], capabilities: [], effects: 'external', retry: 'never', implementationDigest: 'test-never-v1',
      async execute() { return new Promise(() => {}) },
    })
    const template: WorkflowTemplate = {
      apiVersion: 'workflow.gm-hz.dev/v1', kind: 'WorkflowTemplate', metadata: { id: 'runtime-never', name: 'Runtime never' },
      spec: {
        inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
        nodes: [
          { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
          { id: 'work', uses: 'test.never@1', with: {}, inputs: {} },
          { id: 'end', uses: 'core.end@1', with: {}, inputs: {} },
        ], edges: [{ id: 'a', source: 'start', target: 'work' }, { id: 'b', source: 'work', target: 'end' }], outputs: {},
      },
    }
    const runs = new InMemoryWorkflowRunStore()
    const runtime = new WorkflowRuntime({ nodes, catalog: new WorkflowTemplateCatalog(new InMemoryWorkflowCatalogRepository(), nodes), runStore: runs })
    const handle = await runtime.launch({ target: { type: 'inline', template }, inputs: {}, authorityRef: 'test:cancel', authority: {}, origin: { type: 'sdk' } })
    await vi.waitFor(async () => expect((await runs.loadRun(handle.runId))?.checkpoint.nodeStates.work).toBe('running'))
    await expect(Promise.race([
      handle.cancel('operator cancelled'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('cancel hung')), 250)),
    ])).resolves.toBeUndefined()
    await expect(handle.result).resolves.toMatchObject({ status: 'cancelled', error: 'operator cancelled' })
    expect((await runs.loadRun(handle.runId))?.checkpoint.status).toBe('cancelled')
  })

  it('recreates the locked subworkflow gateway when resuming a crashed parent', async () => {
    class OneShotFailingStore extends InMemoryWorkflowRunStore {
      armed = true
      override async commit(runId: string, expectedSeq: number, checkpoint: WorkflowRunCheckpoint, events: readonly WorkflowEvent[]): Promise<void> {
        if (this.armed && events.some(event => event.type === 'node.output-committed' && event.node?.id === 'child')) {
          this.armed = false
          throw new Error('simulated parent crash before child output commit')
        }
        await super.commit(runId, expectedSeq, checkpoint, events)
      }
    }
    const child: WorkflowTemplate = {
      apiVersion: 'workflow.gm-hz.dev/v1', kind: 'WorkflowTemplate', metadata: { id: 'runtime-child', name: 'Runtime child' },
      spec: {
        inputSchema: { type: 'object', additionalProperties: false },
        outputSchema: { type: 'object', additionalProperties: false, required: ['value'], properties: { value: { type: 'string' } } },
        nodes: [
          { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
          { id: 'end', uses: 'core.end@1', with: {}, inputs: { value: { literal: 'restored' } } },
        ],
        edges: [{ id: 'start-end', source: 'start', target: 'end' }],
        outputs: { value: { output: { nodeId: 'end', path: ['value'] } } },
      },
    }
    const parent: WorkflowTemplate = {
      apiVersion: 'workflow.gm-hz.dev/v1', kind: 'WorkflowTemplate', metadata: { id: 'runtime-parent', name: 'Runtime parent' },
      spec: {
        requires: [{ kind: 'capability', uses: 'gateway.workflow.call' }, { kind: 'workflow', uses: 'runtime-child@1' }],
        inputSchema: { type: 'object', additionalProperties: false },
        outputSchema: { type: 'object', additionalProperties: false, required: ['value'], properties: { value: { type: 'string' } } },
        nodes: [
          { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
          { id: 'child', uses: 'workflow.call@1', with: { templateId: 'runtime-child', revision: 1 }, inputs: {} },
          { id: 'end', uses: 'core.end@1', with: {}, inputs: { value: { output: { nodeId: 'child', path: ['outputs', 'value'] } } } },
        ],
        edges: [{ id: 'start-child', source: 'start', target: 'child' }, { id: 'child-end', source: 'child', target: 'end' }],
        outputs: { value: { output: { nodeId: 'end', path: ['value'] } } },
      },
    }
    const nodes = new WorkflowNodeRegistry()
    registerCoreNodes(nodes)
    const catalog = new WorkflowTemplateCatalog(new InMemoryWorkflowCatalogRepository(), nodes)
    for (const template of [child, parent]) {
      const draft = await catalog.createDraft(template)
      await catalog.publish(draft.id, draft.revision)
    }
    const runtime = new WorkflowRuntime({ nodes, catalog, runStore: new OneShotFailingStore() })
    const first = await runtime.launch({
      target: { type: 'published', id: 'runtime-parent', revision: 1 }, inputs: {}, authorityRef: 'test:resume', authority: {}, origin: { type: 'sdk' },
    })
    expect(await first.result).toMatchObject({ status: 'failed', error: 'simulated parent crash before child output commit' })
    const resumed = await runtime.resume({ runId: first.runId, authorityRef: 'test:resume', authority: {} })
    const resumedResult = await resumed.result
    if (resumedResult.status !== 'completed') throw new Error(resumedResult.error)
    expect(resumedResult).toMatchObject({ status: 'completed', outputs: { value: 'restored' } })
  })

  it('captures content-addressed input and output artifacts without embedding values in events', async () => {
    const nodes = new WorkflowNodeRegistry()
    registerCoreNodes(nodes)
    const catalog = new WorkflowTemplateCatalog(new InMemoryWorkflowCatalogRepository(), nodes)
    const runs = new InMemoryWorkflowRunStore()
    const artifacts = new InMemoryWorkflowArtifactStore()
    const runtime = new WorkflowRuntime({
      nodes,
      catalog,
      runStore: runs,
      artifactStore: artifacts,
      capturePolicy: { mode: 'replayable', maxArtifactBytes: 4096 },
      services: { tools: { async execute(request) { return { echo: request.inputs.message ?? null } } } },
    })
    const handle = await runtime.launch({
      target: { type: 'inline', template: toolWorkflowTemplate() },
      inputs: { message: 'captured' },
      authorityRef: 'test:artifact',
      authority: {},
      origin: { type: 'sdk' },
    })
    expect((await handle.result).status).toBe('completed')
    const record = (await runs.loadRun(handle.runId))!
    const captured = record.events.filter(event => event.payload.artifact !== undefined)
    expect(captured.length).toBeGreaterThan(1)
    for (const event of captured) {
      expect(event.payload).not.toHaveProperty('value')
      const ref = event.payload.artifact as unknown as import('../../src/journal/index.js').WorkflowArtifactRef
      expect(await artifacts.read([ref])).toHaveLength(1)
    }
  })

  it('rejects encryption and retention promises unsupported by the configured artifact store', () => {
    const nodes = new WorkflowNodeRegistry(); registerCoreNodes(nodes)
    const catalog = new WorkflowTemplateCatalog(new InMemoryWorkflowCatalogRepository(), nodes)
    const common = { nodes, catalog, runStore: new InMemoryWorkflowRunStore(), artifactStore: new InMemoryWorkflowArtifactStore() }
    expect(() => new WorkflowRuntime({ ...common, capturePolicy: { mode: 'standard', maxArtifactBytes: 1024, encryptArtifacts: true } }))
      .toThrow('encryptionAtRest capability')
    expect(() => new WorkflowRuntime({ ...common, capturePolicy: { mode: 'standard', maxArtifactBytes: 1024, retentionDays: 30 } }))
      .toThrow('retentionPolicy capability')
  })

  it('refuses recorded replay when required artifacts are missing, redacted, or inconsistent', async () => {
    const nodes = new WorkflowNodeRegistry()
    registerCoreNodes(nodes)
    const catalog = new WorkflowTemplateCatalog(new InMemoryWorkflowCatalogRepository(), nodes)
    const delegate = new InMemoryWorkflowArtifactStore()
    let failure: 'missing' | 'redacted' | 'inconsistent' | undefined
    const artifacts: WorkflowArtifactStore = {
      put: (content, options) => delegate.put(content, options),
      async read(refs) {
        if (failure === 'missing') throw new Error('artifact intentionally missing')
        const values = await delegate.read(refs)
        if (failure === 'redacted') return values.map(value => ({ ...value, redacted: true }))
        if (failure === 'inconsistent') {
          const replacement = new TextEncoder().encode('{"echo":"tampered"}')
          return values.map(value => ({ ...value, content: replacement }))
        }
        return values
      },
    }
    const runtime = new WorkflowRuntime({
      nodes,
      catalog,
      runStore: new InMemoryWorkflowRunStore(),
      artifactStore: artifacts,
      capturePolicy: { mode: 'replayable', maxArtifactBytes: 4096 },
      services: { tools: { async execute(request) { return { echo: request.inputs.message ?? null } } } },
    })
    const source = await runtime.launch({
      target: { type: 'inline', template: toolWorkflowTemplate() },
      inputs: { message: 'captured' }, authorityRef: 'test:artifact', authority: {}, origin: { type: 'sdk' },
    })
    expect((await source.result).status).toBe('completed')

    failure = 'missing'
    await expect(runtime.replay({ runId: source.runId, mode: 'recorded' })).rejects.toThrow('intentionally missing')
    failure = 'redacted'
    await expect(runtime.replay({ runId: source.runId, mode: 'recorded' })).rejects.toThrow('redacted artifact')
    failure = 'inconsistent'
    await expect(runtime.replay({ runId: source.runId, mode: 'recorded' })).rejects.toThrow('does not match committed output')
  })
})
