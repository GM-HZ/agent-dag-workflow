import { describe, expect, it } from 'vitest'
import {
  DagWorkflowEngine,
  InMemoryWorkflowRunStore,
  registerCoreNodes,
  WorkflowNodeRegistry,
  type WorkflowEvent,
  type WorkflowRunCheckpoint,
  type WorkflowToolRequest,
} from '../../src/core/index.js'
import { toolWorkflowTemplate } from '../core/fixtures.js'

const execution = { authorityRef: 'verify:failpoint', authority: { test: true }, origin: { type: 'sdk', source: 'verification' } } as const

class CommitFailpointStore extends InMemoryWorkflowRunStore {
  readonly batches: string[][] = []
  #failed = false

  constructor(private readonly failAt?: number) { super() }

  override async commit(
    runId: string,
    expectedSeq: number,
    checkpoint: WorkflowRunCheckpoint,
    events: readonly WorkflowEvent[],
  ): Promise<void> {
    this.batches.push(events.map(event => event.type))
    if (!this.#failed && this.failAt === this.batches.length) {
      this.#failed = true
      throw new Error(`verification failpoint before commit ${this.failAt}`)
    }
    await super.commit(runId, expectedSeq, checkpoint, events)
  }
}

describe('atomic commit failpoint matrix', () => {
  it('recovers from a process failure before every commit boundary', async () => {
    const baselineStore = new CommitFailpointStore()
    const baselineCalls = { value: 0 }
    const baseline = await new DagWorkflowEngine(registry(), { tools: tools(baselineCalls) }, { runStore: baselineStore }).start({
      runId: 'failpoint-baseline', execution, template: toolWorkflowTemplate(), inputs: { message: 'baseline' },
    })
    await expect(baseline.result).resolves.toMatchObject({ status: 'completed', outputs: { answer: 'baseline' } })
    expect(baselineCalls.value).toBe(1)
    const baselineBatches = baselineStore.batches.map(batch => [...batch])
    expect(baselineBatches.length).toBeGreaterThan(4)

    for (let failAt = 1; failAt <= baselineBatches.length; failAt++) {
      const store = new CommitFailpointStore(failAt)
      const calls = { value: 0 }
      const runId = `failpoint-${failAt}`
      const engine = new DagWorkflowEngine(registry(), { tools: tools(calls) }, { runStore: store })
      const interrupted = await engine.start({
        runId, execution, template: toolWorkflowTemplate(), inputs: { message: `case-${failAt}` },
      })
      await expect(interrupted.result, context(failAt, baselineBatches[failAt - 1]!))
        .resolves.toMatchObject({ status: 'failed', error: `verification failpoint before commit ${failAt}` })

      const crashed = await store.loadRun(runId)
      expect(crashed, context(failAt, 'missing run')).toBeDefined()
      expect(crashed!.checkpoint.seq, context(failAt, crashed!.checkpoint)).toBe(crashed!.events.length)
      expect(crashed!.events.map(event => event.seq)).toEqual(crashed!.events.map((_, index) => index + 1))
      expect(crashed!.events.map(event => event.type), context(failAt, crashed!.events))
        .toEqual(baselineBatches.slice(0, failAt - 1).flat())

      const recovery = new DagWorkflowEngine(registry(), { tools: tools(calls) }, { runStore: store })
      let result = await (await recovery.resume({ runId, execution })).result
      const unknownBeforeRecovery = crashed!.checkpoint.nodeStates.call === 'running'
        || crashed!.checkpoint.nodeStates.call === 'waiting'
      expect(result.status === 'paused', context(failAt, result)).toBe(unknownBeforeRecovery)
      if (result.status === 'paused') {
        const resolutions = Object.fromEntries((result.needsAttention ?? []).map(nodeId => [nodeId, 'retry' as const]))
        result = await (await recovery.resume({ runId, execution, unknownNodeResolutions: resolutions })).result
      }

      expect(result, context(failAt, result)).toMatchObject({
        status: 'completed', outputs: { answer: `case-${failAt}` },
      })
      const completionWasLost = baselineBatches[failAt - 1]!.includes('capability.completed')
      expect(calls.value, context(failAt, baselineBatches[failAt - 1])).toBe(completionWasLost ? 2 : 1)
      const recovered = await store.loadRun(runId)
      expect(recovered?.checkpoint.status).toBe('completed')
      expect(recovered?.checkpoint.seq).toBe(recovered?.events.length)
    }
  }, 60_000)
})

function registry(): WorkflowNodeRegistry {
  const result = new WorkflowNodeRegistry()
  registerCoreNodes(result)
  return result
}

function tools(calls: { value: number }) {
  return {
    async execute(request: WorkflowToolRequest) {
      calls.value++
      return { echo: request.inputs.message ?? null }
    },
  }
}

function context(failAt: number, detail: unknown): string {
  return `commit failpoint ${failAt} failed\n${JSON.stringify(detail, null, 2)}`
}
