import { describe, expect, it } from 'vitest'
import {
  DagWorkflowEngine,
  InMemoryWorkflowRunStore,
  registerCoreNodes,
  WorkflowNodeRegistry,
  type WorkflowTemplate,
  type WorkflowEvent,
  type WorkflowRunCheckpoint,
} from '../../src/core/index.js'
import { toolWorkflowTemplate } from './fixtures.js'

const execution = { authorityRef: 'test:checkpoint-budget', authority: { test: true }, origin: { type: 'sdk' } } as const

describe('workflow checkpoint budget', () => {
  it('rejects a deployment budget that leaves insufficient commit headroom', () => {
    expect(() => new DagWorkflowEngine(registry(), {}, {
      deploymentLimits: { maxCheckpointBytes: 15 * 1024 * 1024 + 1 },
    })).toThrow(/maxCheckpointBytes must be at most 15728640/)
  })

  it('rejects cumulative node state before capture or durable completion', async () => {
    const nodes = registry()
    const store = new InMemoryWorkflowRunStore()
    const captures: { readonly nodeId?: string; readonly phase: string }[] = []
    const engine = new DagWorkflowEngine(nodes, {
      tools: { async execute() { return { echo: 'x'.repeat(4_000) } } },
    }, {
      runStore: store,
      deploymentLimits: { maxCheckpointBytes: 4_096 },
      capture: {
        async capture(request) {
          captures.push({ ...(request.nodeId === undefined ? {} : { nodeId: request.nodeId }), phase: request.phase })
          return { dataHash: 'captured' }
        },
      },
    })

    const run = await engine.start({ execution, template: toolWorkflowTemplate(), inputs: { message: 'large' } })
    const result = await run.result
    const record = await store.loadRun(run.id)

    expect(result).toMatchObject({ status: 'failed', error: expect.stringMatching(/workflow checkpoint is .* limit is 4096/) })
    expect(record?.checkpoint).toMatchObject({ status: 'failed', nodeStates: { call: 'failed' } })
    expect(record?.checkpoint.nodeOutputs.call).toBeUndefined()
    expect(record?.events).toContainEqual(expect.objectContaining({ type: 'capability.failed', nodeId: 'call' }))
    expect(record?.events).not.toContainEqual(expect.objectContaining({ type: 'capability.completed', nodeId: 'call' }))
    expect(captures).not.toContainEqual({ nodeId: 'call', phase: 'capability.output' })
    expect(captures).not.toContainEqual({ nodeId: 'call', phase: 'node.output' })
  })

  it('does not duplicate an oversized assembled result into the terminal checkpoint', async () => {
    const value = 'x'.repeat(1_200)
    const template: WorkflowTemplate = {
      apiVersion: 'workflow.gm-hz.dev/v1alpha1', kind: 'WorkflowTemplate',
      metadata: { id: 'checkpoint-result', name: 'Checkpoint result budget' },
      spec: {
        inputSchema: { type: 'object', additionalProperties: false },
        outputSchema: {
          type: 'object', additionalProperties: false, required: ['left', 'right'],
          properties: { left: { type: 'string' }, right: { type: 'string' } },
        },
        nodes: [
          { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
          { id: 'left', uses: 'core.end@1', with: {}, inputs: { value: { literal: value } } },
          { id: 'right', uses: 'core.end@1', with: {}, inputs: { value: { literal: value } } },
        ],
        edges: [
          { id: 'start-left', source: 'start', target: 'left' },
          { id: 'start-right', source: 'start', target: 'right' },
        ],
        outputs: {
          left: { output: { nodeId: 'left', path: ['value'] } },
          right: { output: { nodeId: 'right', path: ['value'] } },
        },
      },
    }
    const store = new InMemoryWorkflowRunStore()
    const engine = new DagWorkflowEngine(registry(), {}, {
      runStore: store, deploymentLimits: { maxCheckpointBytes: 4_096 },
    })

    const run = await engine.start({ execution, template, inputs: {} })
    const result = await run.result
    const record = await store.loadRun(run.id)

    expect(result).toMatchObject({ status: 'failed', error: expect.stringMatching(/workflow checkpoint is .* limit is 4096/) })
    expect(record?.checkpoint.status).toBe('failed')
    expect(record?.checkpoint.resultOutputs).toBeUndefined()
    expect(record?.checkpoint.nodeStates).toMatchObject({ left: 'succeeded', right: 'succeeded' })
    expect(record?.events).toContainEqual(expect.objectContaining({ type: 'run.failed' }))
    expect(record?.events).not.toContainEqual(expect.objectContaining({ type: 'run.completed' }))
  })

  it('rolls back progress that would exceed the durable checkpoint budget', async () => {
    const nodes = registry()
    nodes.register({
      type: 'test.large-progress', version: 1, title: 'Large progress', description: 'Checkpoint budget test.',
      configSchema: { type: 'object', additionalProperties: false }, inputSchema: { type: 'object' },
      outputSchema: { type: 'object', additionalProperties: false }, outputPorts: ['success'],
      capabilities: [], retry: 'safe', implementationDigest: 'test-large-progress-v1',
      async execute(context) {
        await context.checkpointProgress({ padding: 'x'.repeat(4_000) })
        return { outputs: {} }
      },
    })
    const template: WorkflowTemplate = {
      apiVersion: 'workflow.gm-hz.dev/v1alpha1', kind: 'WorkflowTemplate',
      metadata: { id: 'checkpoint-progress', name: 'Checkpoint progress budget' },
      spec: {
        inputSchema: { type: 'object', additionalProperties: false },
        outputSchema: { type: 'object', additionalProperties: false },
        nodes: [
          { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
          { id: 'progress', uses: 'test.large-progress@1', with: {}, inputs: {} },
          { id: 'end', uses: 'core.end@1', with: {}, inputs: {} },
        ],
        edges: [
          { id: 'start-progress', source: 'start', target: 'progress' },
          { id: 'progress-end', source: 'progress', target: 'end' },
        ],
        outputs: {},
      },
    }
    const store = new InMemoryWorkflowRunStore()
    const engine = new DagWorkflowEngine(nodes, {}, {
      runStore: store, deploymentLimits: { maxCheckpointBytes: 4_096 },
    })

    const run = await engine.start({ execution, template, inputs: {} })
    const result = await run.result
    const record = await store.loadRun(run.id)

    expect(result).toMatchObject({ status: 'failed', error: expect.stringMatching(/workflow checkpoint is .* limit is 4096/) })
    expect(record?.checkpoint.nodeProgress.progress).toBeUndefined()
    expect(record?.checkpoint.nodeStates.progress).toBe('failed')
    expect(record?.events).not.toContainEqual(expect.objectContaining({ type: 'node.progress', nodeId: 'progress' }))
  })

  it('uses an existing large checkpoint as the recovery floor after a limit reduction', async () => {
    const nodes = registry()
    nodes.register({
      type: 'test.large-output', version: 1, title: 'Large output', description: 'Recovery floor test.',
      configSchema: { type: 'object', additionalProperties: false }, inputSchema: { type: 'object' },
      outputSchema: {
        type: 'object', additionalProperties: false, required: ['padding'], properties: { padding: { type: 'string' } },
      },
      outputPorts: ['success'], capabilities: [], retry: 'safe', implementationDigest: 'test-large-output-v1',
      async execute() { return { outputs: { padding: 'x'.repeat(3_000) } } },
    })
    const template: WorkflowTemplate = {
      apiVersion: 'workflow.gm-hz.dev/v1alpha1', kind: 'WorkflowTemplate',
      metadata: { id: 'checkpoint-recovery-floor', name: 'Checkpoint recovery floor' },
      spec: {
        inputSchema: { type: 'object', additionalProperties: false },
        outputSchema: { type: 'object', additionalProperties: false },
        nodes: [
          { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
          { id: 'large', uses: 'test.large-output@1', with: {}, inputs: {} },
          { id: 'end', uses: 'core.end@1', with: {}, inputs: {} },
        ],
        edges: [
          { id: 'start-large', source: 'start', target: 'large' },
          { id: 'large-end', source: 'large', target: 'end' },
        ],
        outputs: {},
      },
    }
    const store = new FailOnceStore(events => events.some(event => event.type === 'node.completed' && event.nodeId === 'end'))
    const first = await new DagWorkflowEngine(nodes, {}, {
      runStore: store, deploymentLimits: { maxCheckpointBytes: 8_000 },
    }).start({ execution, template, inputs: {} })

    await expect(first.result).resolves.toMatchObject({ status: 'failed', error: 'simulated checkpoint crash' })
    expect((await store.loadRun(first.id))?.checkpoint).toMatchObject({
      status: 'running', nodeStates: { large: 'succeeded', end: 'running' },
    })

    const resumed = await new DagWorkflowEngine(nodes, {}, {
      runStore: store, deploymentLimits: { maxCheckpointBytes: 1_000 },
    }).resume({ runId: first.id, execution })
    const result = await resumed.result
    expect(result, JSON.stringify(result, null, 2)).toMatchObject({ status: 'completed', outputs: {} })
  })
})

class FailOnceStore extends InMemoryWorkflowRunStore {
  #armed = true

  constructor(private readonly shouldFail: (events: readonly WorkflowEvent[]) => boolean) { super() }

  override async commit(
    runId: string,
    expectedSeq: number,
    checkpoint: WorkflowRunCheckpoint,
    events: readonly WorkflowEvent[],
  ): Promise<void> {
    if (this.#armed && this.shouldFail(events)) {
      this.#armed = false
      throw new Error('simulated checkpoint crash')
    }
    await super.commit(runId, expectedSeq, checkpoint, events)
  }
}

function registry(): WorkflowNodeRegistry {
  const result = new WorkflowNodeRegistry()
  registerCoreNodes(result)
  return result
}
