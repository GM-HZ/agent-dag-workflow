import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { InMemoryWorkflowBindingRepository, InMemoryWorkflowDeliveryStore, InMemoryWorkflowIngressStore, InMemoryWorkflowRunCoordinator, WorkflowBindingCatalog, WorkflowResultDeliveryService, WorkflowRunWorker, WorkflowTriggerDefinitionRegistry, WorkflowTriggerIngress, workflowDeliveryInvocationId, workflowIngressDedupeKey, type WorkflowTriggerBinding } from '../../src/triggers/core/index.js'
import { createCronTrigger } from '../../src/triggers/cron/index.js'
import { WebhookTriggerAdapter } from '../../src/triggers/webhook/index.js'
import { DingTalkTriggerAdapter, DingTalkWorkflowChannel, DingTalkWorkflowRouter } from '../../src/triggers/dingtalk/index.js'
import { InMemoryWorkflowRunStore, registerCoreNodes, WorkflowNodeRegistry, type WorkflowTemplate } from '../../src/core/index.js'
import { InMemoryWorkflowCatalogRepository, WorkflowTemplateCatalog } from '../../src/catalog/index.js'
import { WorkflowRuntime } from '../../src/runtime/index.js'

const binding: WorkflowTriggerBinding = {
  apiVersion: 'workflow.gm-hz.dev/v1alpha1', kind: 'WorkflowBinding', metadata: { id: 'hook', revision: 1 },
  spec: {
    workflow: { id: 'target', revision: 3 }, trigger: { uses: 'webhook@1', with: {} },
    inputMapping: { message: { payload: { path: ['text'] } } }, authorityRef: 'service:hook',
  },
}

describe('workflow binding catalog', () => {
  const target = {
    async getPublished(id: string, revision?: number) {
      if (id !== 'target' || revision !== 3) throw new Error('not found')
      return { template: { spec: { inputSchema: {
        type: 'object', additionalProperties: false, required: ['message', 'count'],
        properties: { message: { type: 'string' }, count: { type: 'integer' } },
      } } } }
    },
  }
  function catalog() {
    const triggers = new WorkflowTriggerDefinitionRegistry()
    triggers.register({ uses: 'webhook@1', configSchema: {
      type: 'object', additionalProperties: false, required: ['credentialRef'],
      properties: { credentialRef: { type: 'string' } },
    } })
    return new WorkflowBindingCatalog(new InMemoryWorkflowBindingRepository(), target, triggers, { now: () => 123 })
  }
  const candidate = {
    apiVersion: 'workflow.gm-hz.dev/v1alpha1' as const,
    kind: 'WorkflowBinding' as const,
    metadata: { id: 'hook' },
    spec: {
      workflow: { id: 'target', revision: 3 }, trigger: { uses: 'webhook@1', with: { credentialRef: 'secret:webhook' } },
      inputMapping: { message: { payload: { path: ['text'] } }, count: { literal: 2 } }, authorityRef: 'service:hook',
    },
  }

  it('publishes immutable revisions only after target, trigger config, and input mapping validation', async () => {
    const bindings = catalog()
    const first = await bindings.publish(candidate, 0)
    const second = await bindings.publish({ ...candidate, spec: { ...candidate.spec, authorityRef: 'service:hook-v2' } }, 1)
    expect(first.metadata).toEqual({ id: 'hook', revision: 1 })
    expect(second).toMatchObject({ metadata: { revision: 2 }, spec: { authorityRef: 'service:hook-v2' } })
    expect(await bindings.get('hook', 1)).toEqual(first)
    expect(() => { (first.metadata as { revision: number }).revision = 999 }).toThrow(TypeError)
    expect((await bindings.get('hook', 1)).metadata.revision).toBe(1)
    await expect(bindings.publish(candidate, 0)).rejects.toMatchObject({ code: 'BINDING_REVISION_CONFLICT' })
  })

  it('fails closed for unknown triggers, missing required mappings, invalid literals, and missing targets', async () => {
    const bindings = catalog()
    await expect(bindings.publish({ ...candidate, spec: { ...candidate.spec, trigger: { uses: 'custom@1', with: {} } } }, 0))
      .rejects.toMatchObject({ code: 'BINDING_TRIGGER_UNKNOWN' })
    await expect(bindings.publish({ ...candidate, spec: { ...candidate.spec, inputMapping: { message: candidate.spec.inputMapping.message } } }, 0))
      .rejects.toMatchObject({ code: 'BINDING_INVALID', diagnostics: expect.arrayContaining([expect.stringContaining('count')]) })
    await expect(bindings.publish({ ...candidate, spec: { ...candidate.spec, inputMapping: { ...candidate.spec.inputMapping, count: { literal: 'two' } } } }, 0))
      .rejects.toMatchObject({ code: 'BINDING_INVALID' })
    await expect(bindings.publish({ ...candidate, spec: { ...candidate.spec, workflow: { id: 'missing', revision: 1 } } }, 0))
      .rejects.toMatchObject({ code: 'BINDING_TARGET_NOT_FOUND' })
    await expect(bindings.publish(null as never, 0)).rejects.toMatchObject({ code: 'BINDING_INVALID' })
  })
})

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
    expect(duplicate).toMatchObject({ status: 'deduplicated', duplicateCount: 1, duplicateTriggerIds: ['trigger-2'] })
    expect(await store.get('trigger-1')).toMatchObject({ status: 'launched', duplicateCount: 1, lastDuplicateAt: 100 })
    expect(launch).toHaveBeenCalledTimes(1)
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({
      authorityRef: 'service:hook', idempotencyKey: workflowIngressDedupeKey(binding, envelope), inputs: { message: 'hello' },
    }))
  })

  it('rejects a missing input mapping before launch and records a stable reason code', async () => {
    const launch = vi.fn()
    const store = new InMemoryWorkflowIngressStore()
    const ingress = new WorkflowTriggerIngress({ launch } as unknown as import('../../src/runtime/index.js').WorkflowRuntimeApi, store, async () => binding)
    const record = await ingress.ingest(binding, {
      schemaVersion: 1, triggerId: 'bad-mapping', source: 'webhook', sourceEventId: 'missing-text', receivedAt: 100, payload: {},
    })
    expect(record).toMatchObject({ status: 'rejected', reasonCode: 'INGRESS_TRIGGER_INPUT_MAPPING_PATH_IS_MISSING_TEXT' })
    expect(launch).not.toHaveBeenCalled()
    expect(await store.get('bad-mapping')).toEqual(record)
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

    const skipped = createCronTrigger({ expression: '0 9 * * 1', timezone: 'Asia/Shanghai', misfirePolicy: 'skip', now: () => now })
    expect(skipped.dueBetween(new Date('2026-08-31T00:59:00.000Z'), new Date('2026-08-31T01:05:00.000Z'))).toEqual([])
    const recovered = createCronTrigger({ expression: '0 9 * * 1', timezone: 'Asia/Shanghai', misfirePolicy: 'fire-once', now: () => now })
    expect(recovered.dueBetween(new Date('2026-08-24T00:59:00.000Z'), new Date('2026-08-31T01:05:00.000Z')))
      .toEqual([expect.objectContaining({ occurredAt: Date.parse('2026-08-31T01:00:00.000Z'), receivedAt: now })])
    expect(() => recovered.dueBetween(new Date('2026-08-31T01:05:00.000Z'), new Date('2026-08-31T01:04:59.000Z')))
      .toThrow(/window is invalid/)
  })

  it('deduplicates terminal delivery and preserves unknown attempts for retry', async () => {
    const deliver = vi.fn()
      .mockRejectedValueOnce(new Error('connection lost after send'))
      .mockResolvedValue(undefined)
    const service = new WorkflowResultDeliveryService({ deliver }, new InMemoryWorkflowDeliveryStore(), () => 100)
    const request = { runId: 'run-1', deliveryRef: 'reply-1', phase: 'terminal' as const, payload: { ok: true } }
    await expect(service.deliver(request)).rejects.toThrow('connection lost')
    const delivered = await service.deliver(request)
    expect(delivered).toMatchObject({ status: 'delivered', attempts: 2, invocationId: workflowDeliveryInvocationId(request) })
    await service.deliver(request)
    expect(deliver).toHaveBeenCalledTimes(2)
    expect(deliver.mock.calls[0]?.[0]).toMatchObject({ invocationId: workflowDeliveryInvocationId(request) })
  })

  it('coalesces concurrent delivery attempts onto one stable external invocation', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const deliver = vi.fn(async () => gate)
    const deliveryStore = new InMemoryWorkflowDeliveryStore()
    const service = new WorkflowResultDeliveryService({ deliver }, deliveryStore, () => 200)
    const request = { runId: 'run-concurrent', deliveryRef: 'reply-1', phase: 'terminal' as const, payload: { ok: true } }
    const first = service.deliver(request)
    const second = service.deliver(request)
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
    expect(await deliveryStore.listAttention()).toEqual([expect.objectContaining({ status: 'pending', attempts: 1 })])
    release()
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'delivered', attempts: 1 }),
      expect.objectContaining({ status: 'delivered', attempts: 1 }),
    ])
  })

  it('never rebinds one delivery invocation id to a different payload', async () => {
    const service = new WorkflowResultDeliveryService({ async deliver() {} }, new InMemoryWorkflowDeliveryStore(), () => 200)
    await service.deliver({ runId: 'run-bound', deliveryRef: 'reply', phase: 'terminal', payload: { ok: true } })
    await expect(service.deliver({ runId: 'run-bound', deliveryRef: 'reply', phase: 'terminal', payload: { ok: false } }))
      .rejects.toThrow('already bound to another immutable request')
  })

  it('leaves an ingress pending when launch-link persistence fails and recovers it', async () => {
    const base = new InMemoryWorkflowIngressStore()
    let fail = true
    const store: import('../../src/triggers/core/index.js').WorkflowIngressStore = {
      acceptOrGet: record => base.acceptOrGet(record),
      get: id => base.get(id),
      listPending: () => base.listPending(),
      list: query => base.list(query),
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

  it('leaves an ingress pending when the durable runtime or queue is unavailable', async () => {
    const store = new InMemoryWorkflowIngressStore()
    const launch = vi.fn()
      .mockRejectedValueOnce(new Error('queue unavailable'))
      .mockResolvedValue({ runId: 'recovered-run', result: Promise.resolve({ status: 'completed' }), live: async function* () {}, async cancel() {} })
    const ingress = new WorkflowTriggerIngress({ launch } as unknown as import('../../src/runtime/index.js').WorkflowRuntimeApi, store, async () => binding)
    const envelope = { schemaVersion: 1 as const, triggerId: 'queue-gap', source: 'webhook', sourceEventId: 'queue-event', receivedAt: 100, payload: { text: 'hello' } }
    await expect(ingress.ingest(binding, envelope)).rejects.toThrow('queue unavailable')
    expect(await store.get('queue-gap')).toMatchObject({ status: 'received' })
    await expect(ingress.recoverPending()).resolves.toEqual([expect.objectContaining({ status: 'launched', runId: 'recovered-run' })])
    expect(launch).toHaveBeenCalledTimes(2)
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

  it('routes signed DingTalk commands, audits duplicates, and deduplicates accepted/terminal replies', async () => {
    const now = 1_800_000_000_000
    const timestamp = String(now)
    const sign = createHmac('sha256', 'ding-secret').update(`${timestamp}\nding-secret`).digest('base64')
    const body = {
      senderStaffId: 'user-1', conversationId: 'group-1', msgId: 'ding-event-1',
      text: { content: '/weekly-ai 2026-08-01 2026-08-07' },
    }
    const adapter = new DingTalkTriggerAdapter({
      appSecret: 'ding-secret', now: () => now,
      resolveAuthority: (sender, conversation) => sender === 'user-1' && conversation === 'group-1' ? 'principal:ding-user-1' : undefined,
    })
    const dingBinding: WorkflowTriggerBinding = {
      apiVersion: 'workflow.gm-hz.dev/v1alpha1', kind: 'WorkflowBinding', metadata: { id: 'weekly-ding', revision: 1 },
      spec: {
        workflow: { id: 'weekly-ai', revision: 3 }, trigger: { uses: 'dingtalk@1', with: {} },
        inputMapping: {
          from: { metadata: { path: ['route', 'arguments', 0] } },
          to: { metadata: { path: ['route', 'arguments', 1] } },
        }, authorityRef: 'service:weekly-ai', deliveryRef: 'ding:group-1:ding-event-1',
      },
    }
    const launch = vi.fn(async () => ({ runId: 'run-ding', result: Promise.resolve({ status: 'completed' }), live: async function* () {}, async cancel() {} }))
    const ingressStore = new InMemoryWorkflowIngressStore()
    const ingress = new WorkflowTriggerIngress({ launch } as unknown as import('../../src/runtime/index.js').WorkflowRuntimeApi, ingressStore, async () => dingBinding)
    const externalDeliver = vi.fn(async () => {})
    const delivery = new WorkflowResultDeliveryService({ deliver: externalDeliver }, new InMemoryWorkflowDeliveryStore(), () => now)
    const channel = new DingTalkWorkflowChannel(
      adapter,
      new DingTalkWorkflowRouter([{ binding: { id: 'weekly-ding', revision: 1 }, command: '/weekly-ai' }]),
      ingress,
      async () => dingBinding,
      delivery,
    )

    expect(await channel.receive({ timestamp, sign, body })).toMatchObject({ status: 'launched', runId: 'run-ding' })
    expect(await channel.receive({ timestamp, sign, body })).toMatchObject({ status: 'deduplicated', runId: 'run-ding', duplicateCount: 1 })
    expect(launch).toHaveBeenCalledTimes(1)
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({
      executionMode: 'background', authorityRef: 'service:weekly-ai', inputs: { from: '2026-08-01', to: '2026-08-07' },
    }))
    expect(externalDeliver).toHaveBeenCalledTimes(1)

    const completed = { status: 'completed' as const, runId: 'run-ding', outputs: { items: [] }, nodeStates: {}, edgeStates: {}, events: [] }
    await channel.deliverTerminal(dingBinding, completed)
    await channel.deliverTerminal(dingBinding, completed)
    expect(externalDeliver).toHaveBeenCalledTimes(2)
    expect(await ingressStore.get((await ingressStore.list())[0]!.triggerId)).toMatchObject({ duplicateCount: 1 })

    expect(() => new DingTalkTriggerAdapter({ appSecret: 'ding-secret', now: () => now, resolveAuthority: () => undefined })
      .accept({ timestamp, sign, body })).toThrow('identity is not mapped')
  })

  it('restricts DingTalk natural-language routing to an explicit binding allowlist', async () => {
    const envelope = {
      schemaVersion: 1 as const, triggerId: 'ding-natural', source: 'dingtalk', sourceEventId: 'message-2', receivedAt: 1,
      payload: { content: '帮我整理本周 AI 新闻' }, metadata: { principalRef: 'principal:user' },
    }
    const router = new DingTalkWorkflowRouter(
      [{ binding: { id: 'weekly-ding', revision: 1 } }],
      { async route() { return { id: 'weekly-ding', revision: 1, inputs: { from: 'a', to: 'b' } } } },
    )
    await expect(router.route(envelope)).resolves.toMatchObject({
      binding: { id: 'weekly-ding', revision: 1 },
      envelope: { metadata: { route: { kind: 'natural-language', inputs: { from: 'a', to: 'b' } } } },
    })
    const malicious = new DingTalkWorkflowRouter(
      [{ binding: { id: 'weekly-ding', revision: 1 } }],
      { async route() { return { id: 'admin-flow', revision: 1, inputs: {} } } },
    )
    await expect(malicious.route(envelope)).rejects.toThrow('outside the allowlist')
  })

  it('carries a DingTalk command through background Worker, approval, Journal, and terminal reply', async () => {
    const now = 1_800_000_000_000
    const nodes = new WorkflowNodeRegistry(); registerCoreNodes(nodes)
    const catalog = new WorkflowTemplateCatalog(new InMemoryWorkflowCatalogRepository(), nodes)
    const runs = new InMemoryWorkflowRunStore()
    const queue = new InMemoryWorkflowRunCoordinator()
    const approvals = vi.fn(async () => 'allowed-once' as const)
    const runtime = new WorkflowRuntime({
      nodes, catalog, runStore: runs, queue, services: { approvals: { request: approvals } },
      authorityResolver: { async resolve(ref) { return { ref } } },
    })
    const template: WorkflowTemplate = {
      apiVersion: 'workflow.gm-hz.dev/v1alpha1', kind: 'WorkflowTemplate', metadata: { id: 'approve-flow', name: 'Approve flow' },
      spec: {
        requires: [{ kind: 'capability', uses: 'gateway.approval.request' }, { kind: 'approval-action', uses: 'release' }],
        inputSchema: { type: 'object' }, outputSchema: { type: 'object', required: ['approved'], properties: { approved: { type: 'boolean' } } },
        nodes: [
          { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
          { id: 'approval', uses: 'human.approval@1', with: { action: 'release', reason: 'Release?' }, inputs: { artifact: { literal: 'v1' } } },
          { id: 'end', uses: 'core.end@1', with: {}, inputs: { approved: { output: { nodeId: 'approval', path: ['approved'] } } } },
        ],
        edges: [
          { id: 'a', source: 'start', target: 'approval' },
          { id: 'b', source: 'approval', target: 'end', sourcePort: 'approved' },
          { id: 'c', source: 'approval', target: 'end', sourcePort: 'rejected' },
        ],
        outputs: { approved: { output: { nodeId: 'end', path: ['approved'] } } },
      },
    }
    const draft = await catalog.createDraft(template); await catalog.publish(draft.id, draft.revision)
    const dingBinding: WorkflowTriggerBinding = {
      apiVersion: 'workflow.gm-hz.dev/v1alpha1', kind: 'WorkflowBinding', metadata: { id: 'approve-ding', revision: 1 },
      spec: { workflow: { id: 'approve-flow', revision: 1 }, trigger: { uses: 'dingtalk@1', with: {} }, inputMapping: {}, authorityRef: 'principal:approver', deliveryRef: 'ding:approval' },
    }
    const adapter = new DingTalkTriggerAdapter({ appSecret: 'approval-secret', now: () => now, resolveAuthority: () => 'principal:approver' })
    const ingress = new WorkflowTriggerIngress(runtime, new InMemoryWorkflowIngressStore(), async () => dingBinding)
    const deliver = vi.fn(async (_request: import('../../src/triggers/core/index.js').WorkflowDeliveryRequest & { readonly invocationId: string }) => {})
    const channel = new DingTalkWorkflowChannel(
      adapter, new DingTalkWorkflowRouter([{ binding: dingBinding.metadata, command: '/approve' }]), ingress, async () => dingBinding,
      new WorkflowResultDeliveryService({ deliver }, new InMemoryWorkflowDeliveryStore(), () => now),
    )
    const timestamp = String(now)
    const sign = createHmac('sha256', 'approval-secret').update(`${timestamp}\napproval-secret`).digest('base64')
    const accepted = await channel.receive({ timestamp, sign, body: {
      senderStaffId: 'operator', conversationId: 'release-room', msgId: 'approval-message', text: { content: '/approve' },
    } })
    const result = await new WorkflowRunWorker(runtime, queue).runOnce({ workerId: 'approval-worker', leaseMs: 1_000 })
    if (result === undefined) throw new Error('approval run was not claimed')
    await channel.deliverTerminal(dingBinding, result)
    expect(accepted).toMatchObject({ status: 'launched', runId: result.runId })
    expect(result).toMatchObject({ status: 'completed', outputs: { approved: true } })
    expect(approvals).toHaveBeenCalledTimes(1)
    expect(deliver.mock.calls.map(([request]) => request.phase)).toEqual(['accepted', 'terminal'])
    const journal = (await runtime.readEvents(result.runId, { limit: 100 })).events
    expect(journal.map(event => event.type)).toEqual(expect.arrayContaining([
      'run.accepted', 'run.queued', 'run.started', 'node.waiting', 'capability.requested', 'capability.completed', 'run.completed',
    ]))
    expect(journal.find(event => event.type === 'capability.requested')?.node).toMatchObject({ id: 'approval', invocationId: expect.any(String) })
  })
})
