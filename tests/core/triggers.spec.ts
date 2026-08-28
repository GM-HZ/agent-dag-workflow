import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { InMemoryWorkflowDeliveryStore, InMemoryWorkflowIngressStore, InMemoryWorkflowRunCoordinator, WorkflowResultDeliveryService, WorkflowRunWorker, WorkflowTriggerIngress, type WorkflowTriggerBinding } from '../../src/triggers/core/index.js'
import { createCronTrigger } from '../../src/triggers/cron/index.js'
import { WebhookTriggerAdapter } from '../../src/triggers/webhook/index.js'

const binding: WorkflowTriggerBinding = {
  apiVersion: 'workflow.gm-hz.dev/v1alpha1', kind: 'WorkflowBinding', metadata: { id: 'hook', revision: 1 },
  spec: {
    workflow: { id: 'target', revision: 3 }, trigger: { uses: 'webhook@1', with: {} },
    inputMapping: { message: { payload: { path: ['text'] } } }, authorityRef: 'service:hook',
  },
}

describe('trigger ingress', () => {
  it('derives server-side dedupe keys and never trusts payload authority', async () => {
    const launch = vi.fn(async () => ({ runId: 'run-1', result: Promise.resolve({ status: 'completed' }), live: async function* () {}, async cancel() {} }))
    const runtime = { launch } as unknown as import('../../src/runtime/index.js').WorkflowRuntimeApi
    const store = new InMemoryWorkflowIngressStore()
    const ingress = new WorkflowTriggerIngress(runtime, store, async () => binding)
    const envelope = {
      schemaVersion: 1 as const, triggerId: 'trigger-1', source: 'webhook', sourceEventId: 'event-1', receivedAt: 100,
      payload: { text: 'hello', authorityRef: 'attacker' },
    }
    const first = await ingress.ingest(binding, envelope)
    const duplicate = await ingress.ingest(binding, { ...envelope, triggerId: 'trigger-2' })
    expect(first).toMatchObject({ status: 'launched', runId: 'run-1' })
    expect(duplicate.runId).toBe('run-1')
    expect(launch).toHaveBeenCalledTimes(1)
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({
      authorityRef: 'service:hook', idempotencyKey: 'hook@1\0webhook\0event-1', inputs: { message: 'hello' },
    }))
  })

  it('validates HMAC webhooks and timezone cron schedules', () => {
    const now = 1_800_000_000_000
    const body = new TextEncoder().encode('{"text":"hello"}')
    const timestamp = String(now)
    const signature = createHmac('sha256', 'secret').update(timestamp).update('.').update(body).digest('hex')
    const adapter = new WebhookTriggerAdapter({ secret: 'secret', now: () => now })
    expect(adapter.accept({ body, headers: {
      'x-workflow-timestamp': timestamp, 'x-workflow-event-id': 'event-1', 'x-workflow-signature': signature,
    } })).toMatchObject({ source: 'webhook', sourceEventId: 'event-1', payload: { text: 'hello' } })
    expect(() => adapter.accept({ body, headers: {
      'x-workflow-timestamp': timestamp, 'x-workflow-event-id': 'event-1', 'x-workflow-signature': '00',
    } })).toThrow(/signature/)

    const cron = createCronTrigger({ expression: '0 9 * * 1', timezone: 'Asia/Shanghai' })
    expect(cron.matches(new Date('2026-08-31T01:00:00.000Z'))).toBe(true)
    expect(cron.matches(new Date('2026-08-31T02:00:00.000Z'))).toBe(false)
    expect(cron.envelope(new Date('2026-08-31T01:00:00.000Z')).source).toBe('cron')
  })

  it('deduplicates terminal delivery and preserves unknown attempts for retry', async () => {
    const deliver = vi.fn()
      .mockRejectedValueOnce(new Error('connection lost after send'))
      .mockResolvedValue(undefined)
    const service = new WorkflowResultDeliveryService({ deliver }, new InMemoryWorkflowDeliveryStore(), () => 100)
    const request = { runId: 'run-1', deliveryRef: 'reply-1', phase: 'terminal' as const, payload: { ok: true } }
    await expect(service.deliver(request)).rejects.toThrow('connection lost')
    const delivered = await service.deliver(request)
    expect(delivered).toMatchObject({ status: 'delivered', attempts: 2, invocationId: 'run-1:reply-1:terminal' })
    await service.deliver(request)
    expect(deliver).toHaveBeenCalledTimes(2)
    expect(deliver.mock.calls[0]?.[0]).toMatchObject({ invocationId: 'run-1:reply-1:terminal' })
  })

  it('leaves an ingress pending when launch-link persistence fails and recovers it', async () => {
    const base = new InMemoryWorkflowIngressStore()
    let fail = true
    const store: import('../../src/triggers/core/index.js').WorkflowIngressStore = {
      acceptOrGet: record => base.acceptOrGet(record),
      get: id => base.get(id),
      listPending: () => base.listPending(),
      markRejected: (id, reason) => base.markRejected(id, reason),
      async markLaunched(id, runId) { if (fail) { fail = false; throw new Error('simulated link crash') }; await base.markLaunched(id, runId) },
    }
    const launch = vi.fn(async (_request: import('../../src/runtime/index.js').WorkflowLaunchRequest) => ({ runId: 'stable-run', result: Promise.resolve({ status: 'completed' }), live: async function* () {}, async cancel() {} }))
    const ingress = new WorkflowTriggerIngress({ launch } as unknown as import('../../src/runtime/index.js').WorkflowRuntimeApi, store, async () => binding)
    const envelope = { schemaVersion: 1 as const, triggerId: 'gap-1', source: 'webhook', sourceEventId: 'gap-event', receivedAt: 100, payload: { text: 'hello' } }
    await expect(ingress.ingest(binding, envelope)).rejects.toThrow('simulated link crash')
    expect(await base.get('gap-1')).toMatchObject({ status: 'received' })
    expect(await ingress.recoverPending()).toEqual([expect.objectContaining({ status: 'launched', runId: 'stable-run' })])
    expect(launch).toHaveBeenCalledTimes(2)
    expect(launch.mock.calls[0]?.[0].idempotencyKey).toBe(launch.mock.calls[1]?.[0].idempotencyKey)
  })

  it('claims one recoverable run and resumes it through the shared Runtime API', async () => {
    const coordinator = new InMemoryWorkflowRunCoordinator()
    await coordinator.enqueue('run-worker')
    const resume = vi.fn(async () => ({
      runId: 'run-worker',
      result: Promise.resolve({ status: 'completed', runId: 'run-worker', outputs: {}, nodeStates: {}, edgeStates: {}, events: [] }),
      live: async function* () {},
      async cancel() {},
    }))
    let reads = 0
    const runtime = {
      async getRun() { reads++; return { runId: 'run-worker', authorityRef: 'service:worker', status: reads === 1 ? 'running' : 'completed' } },
      resume,
    } as unknown as import('../../src/runtime/index.js').WorkflowRuntimeApi
    const result = await new WorkflowRunWorker(runtime, coordinator).runOnce({ workerId: 'worker-1', leaseMs: 1_000 })
    expect(result).toMatchObject({ status: 'completed', runId: 'run-worker' })
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-worker', authorityRef: 'service:worker' }))
    expect(await coordinator.claim({ workerId: 'worker-2', leaseMs: 1_000 })).toBeUndefined()
  })

  it('requeues a run whose worker failed before the recoverable checkpoint became terminal', async () => {
    const coordinator = new InMemoryWorkflowRunCoordinator()
    await coordinator.enqueue('run-recoverable')
    const runtime = {
      async getRun() { return { runId: 'run-recoverable', authorityRef: 'service:worker', status: 'running' } },
      async resume() {
        return {
          runId: 'run-recoverable',
          result: Promise.resolve({ status: 'failed', runId: 'run-recoverable', error: 'commit lost', nodeStates: {}, edgeStates: {}, events: [] }),
          live: async function* () {}, async cancel() {},
        }
      },
    } as unknown as import('../../src/runtime/index.js').WorkflowRuntimeApi
    expect(await new WorkflowRunWorker(runtime, coordinator).runOnce({ workerId: 'worker-1', leaseMs: 1_000 }))
      .toMatchObject({ status: 'failed', error: 'commit lost' })
    expect(await coordinator.claim({ workerId: 'worker-2', leaseMs: 1_000 }))
      .toMatchObject({ runId: 'run-recoverable', workerId: 'worker-2' })
  })
})
