import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkflowTemplateCatalog } from '../../src/catalog/index.js'
import { registerCoreNodes, WorkflowNodeRegistry, type JsonObject } from '../../src/core/index.js'
import { WorkflowRuntime } from '../../src/runtime/index.js'
import {
  SQLITE_SCHEMA_VERSION, SqliteWorkflowBindingRepository, SqliteWorkflowCatalogRepository, SqliteWorkflowCronStore,
  SqliteWorkflowDeliveryStore, SqliteWorkflowIngressStore, SqliteWorkflowRunCoordinator, SqliteWorkflowRunStore,
} from '../../src/storage/sqlite/index.js'
import {
  WorkflowBindingCatalog, WorkflowResultDeliveryService, WorkflowRunWorker, WorkflowTriggerDefinitionRegistry,
  WorkflowTriggerIngress, workflowDeliveryInvocationId, type WorkflowDeliveryRequest, type WorkflowTriggerBindingCandidate,
} from '../../src/triggers/core/index.js'
import { createCronTrigger, CRON_TRIGGER_DEFINITION, WorkflowCronScheduler, type WorkflowCronStore } from '../../src/triggers/cron/index.js'
import { toolWorkflowTemplate } from './fixtures.js'

const roots: string[] = []
const at = (value: string) => Date.parse(`2026-09-01T${value}:00Z`)
const candidate: WorkflowTriggerBindingCandidate = {
  apiVersion: 'workflow.gm-hz.dev/v1', kind: 'WorkflowBinding', metadata: { id: 'orders' },
  spec: {
    workflow: { id: 'tool-flow', revision: 1 }, trigger: { uses: 'cron@1', with: {
      expression: '*/5 9 * * *', timezone: 'UTC', misfirePolicy: 'fire-once',
    } },
    inputMapping: { message: { literal: 'personal orders' } }, authorityRef: 'service:orders',
  },
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }) })

function tempDatabase(): string {
  const path = mkdtempSync(join(tmpdir(), 'agent-dag-schedule-'))
  roots.push(path)
  return join(path, 'workflow.sqlite')
}

async function localHost(path: string, hooks: { readonly available?: () => boolean; readonly tool?: (inputs: JsonObject) => Promise<JsonObject> } = {}) {
  const nodes = new WorkflowNodeRegistry()
  registerCoreNodes(nodes)
  const repository = new SqliteWorkflowCatalogRepository({ path })
  const catalog = new WorkflowTemplateCatalog(repository, nodes)
  const runs = new SqliteWorkflowRunStore({ path })
  const coordinator = new SqliteWorkflowRunCoordinator({ path })
  const schedules = new SqliteWorkflowCronStore({ path })
  const ingressStore = new SqliteWorkflowIngressStore({ path })
  const bindingsRepository = new SqliteWorkflowBindingRepository({ path })
  const triggers = new WorkflowTriggerDefinitionRegistry()
  triggers.register(CRON_TRIGGER_DEFINITION)
  const bindings = new WorkflowBindingCatalog(bindingsRepository, catalog, triggers)
  const runtime = new WorkflowRuntime({ nodes, catalog, runStore: runs, queue: coordinator,
    services: { tools: { execute: async request => hooks.tool?.(request.inputs) ?? { echo: request.inputs.message ?? '' } } },
    authorityResolver: { async resolve(ref) { return hooks.available?.() === false ? undefined : { ref } } },
  })
  const ingress = new WorkflowTriggerIngress(runtime, ingressStore, (id, revision) => bindings.get(id, revision))
  const scheduler = (store: WorkflowCronStore = schedules) => new WorkflowCronScheduler(bindings, ingress, runtime, store)
  if (await repository.readPublished('tool-flow', 1) === undefined) {
    const draft = await catalog.createDraft(toolWorkflowTemplate())
    await catalog.publish(draft.id, draft.revision)
  }
  return { bindings, ingressStore, runtime, schedules, coordinator, scheduler,
    close() { repository.close(); runs.close(); coordinator.close(); schedules.close(); ingressStore.close(); bindingsRepository.close() },
  }
}

describe('local cron scheduler', () => {
  it('validates clock ranges, steps and timezone while retaining explicit calendar semantics', () => {
    expect(() => createCronTrigger({ expression: '60 9 * * *', timezone: 'UTC' })).toThrow(/minute field is out of range/)
    expect(() => createCronTrigger({ expression: '0 24 * * *', timezone: 'UTC' })).toThrow(/hour field is out of range/)
    expect(() => createCronTrigger({ expression: '*/0 9 * * *', timezone: 'UTC' })).toThrow(/invalid cron minute step/)
    expect(() => createCronTrigger({ expression: '0 9 30 2 *', timezone: 'UTC' })).toThrow(/cannot match/)
    expect(() => createCronTrigger({ expression: '0 9 * * *', timezone: 'Unknown/Zone' })).toThrow()
    const everyFive = createCronTrigger({ expression: '*/5 9 * * *', timezone: 'UTC' })
    expect(everyFive.nextRunAt(new Date(at('09:00')))?.getTime()).toBe(at('09:05'))
    const tuesday = new Date('2026-09-01T09:00:00Z')
    const options = { expression: '0 9 1 * 1', timezone: 'UTC' }
    expect(createCronTrigger(options).matches(tuesday)).toBe(false)
    expect(createCronTrigger({ ...options, dayMatch: 'cron' }).matches(tuesday)).toBe(true)
    const fallBack = createCronTrigger({ expression: '30 1 * * *', timezone: 'America/New_York' })
    const first = fallBack.nextRunAt(new Date('2026-11-01T04:00:00Z'))!
    const second = fallBack.nextRunAt(first)!
    expect([first.toISOString(), second.toISOString()]).toEqual(['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z'])
    expect(fallBack.envelope(first).sourceEventId).not.toBe(fallBack.envelope(second).sourceEventId)
  })

  it('migrates a v11 database without changing existing workflow rows', async () => {
    const path = tempDatabase()
    const initial = await localHost(path)
    await initial.bindings.publish(candidate, 0)
    initial.close()
    // v11 has the same tables and rows, minus the additive schedule table.
    const previous = new DatabaseSync(path)
    previous.exec('DROP TABLE workflow_cron_schedules; PRAGMA user_version = 11;')
    const before = previous.prepare('SELECT * FROM workflow_bindings').all()
    previous.close()

    const migrated = new SqliteWorkflowCronStore({ path })
    expect(await migrated.get('orders')).toBeUndefined()
    migrated.close()
    const reopened = new DatabaseSync(path)
    try {
      expect(reopened.prepare('PRAGMA user_version').get()?.user_version).toBe(SQLITE_SCHEMA_VERSION)
      expect(reopened.prepare('SELECT * FROM workflow_bindings').all()).toEqual(before)
      expect(reopened.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok')
    } finally { reopened.close() }
  })

  it('finds a rare local date across UTC midnight and skips a missing DST hour', () => {
    const leap = createCronTrigger({ expression: '5 0 29 2 *', timezone: 'Pacific/Kiritimati' })
    const start = new Date('2026-11-26T10:00:00Z')
    const next = leap.nextRunAt(start)
    expect(next?.toISOString()).toBe('2028-02-28T10:05:00.000Z')
    expect(leap.latestRunAt(new Date('2028-03-31T00:00:00Z'), start)).toEqual(next)
    const spring = createCronTrigger({ expression: '30 2 * * *', timezone: 'America/New_York' })
    expect(spring.nextRunAt(new Date('2026-03-08T00:00:00Z'))?.toISOString()).toBe('2026-03-09T06:30:00.000Z')
  })

  it('persists the cursor across restart, skips overlap, and catches up only once', async () => {
    const path = tempDatabase()
    const initial = await localHost(path)
    let firstRunId: string
    try {
      await expect(initial.bindings.publish({ ...candidate, spec: { ...candidate.spec, trigger: {
        uses: 'cron@1', with: { expression: '71 9 * * *', timezone: 'UTC' },
      } } }, 0)).rejects.toMatchObject({ code: 'BINDING_INVALID', diagnostics: [expect.stringContaining('out of range')] })
      await initial.bindings.publish(candidate, 0)
      const first = await initial.scheduler().tick('orders', at('09:00'))
      expect(first.nextRunAt).toBe(at('09:05'))
      expect(first.state?.last).toMatchObject({ status: 'launched', scheduledAt: at('09:00') })
      firstRunId = first.state!.lastRunId!
    } finally { initial.close() }

    const restarted = await localHost(path)
    try {
      const scheduler = restarted.scheduler()
      expect((await scheduler.tick('orders', at('09:00'))).state?.lastRunId).toBe(firstRunId)
      expect((await scheduler.tick('orders', at('09:05'))).state?.last).toMatchObject({ status: 'skipped-overlap' })
      expect((await restarted.ingressStore.list()).length).toBe(1)
      const worker = new WorkflowRunWorker(restarted.runtime, restarted.coordinator)
      await expect(worker.runOnce({ workerId: 'first', leaseMs: 1_000 })).resolves.toMatchObject({ runId: firstRunId, status: 'completed' })
      const caughtUp = await scheduler.tick('orders', at('09:12'))
      expect(caughtUp.lastRun?.runId).not.toBe(firstRunId)
      expect(caughtUp.state?.last).toMatchObject({ status: 'launched', scheduledAt: at('09:10') })
      expect(caughtUp.state?.checkedThrough).toBe(at('09:12'))
      expect((await scheduler.runNow('orders', at('09:12'))).state?.last).toMatchObject({ status: 'skipped-overlap', manual: true })

      await restarted.bindings.publish({ ...candidate, spec: { ...candidate.spec, enabled: false } }, 1)
      const stopped = await scheduler.tickAll(at('09:15'))
      expect(stopped.failed).toEqual([])
      expect(stopped.schedules.map(schedule => schedule.binding.metadata.revision)).toEqual([2])
      expect(stopped.schedules[0]?.nextRunAt).toBeUndefined()
      await expect(scheduler.runNow('orders', at('09:16'))).rejects.toThrow('disabled')
      expect((await restarted.ingressStore.list()).length).toBe(2)
    } finally { restarted.close() }
  })

  it('recovers a stored scheduling intent after a launch acknowledgement write fault', async () => {
    const path = tempDatabase()
    const initial = await localHost(path)
    let runId: string
    try {
      await initial.bindings.publish(candidate, 0)
      const fault: WorkflowCronStore = {
        get: id => initial.schedules.get(id),
        async save(state, generation) {
          if (state.last?.status === 'launched') throw new Error('simulated scheduler acknowledgement loss')
          await initial.schedules.save(state, generation)
        },
      }
      await expect(initial.scheduler(fault).tick('orders', at('09:00'))).rejects.toThrow('acknowledgement loss')
      const stored = await initial.schedules.get('orders')
      expect(stored?.pending?.envelope.occurredAt).toBe(at('09:00'))
      runId = (await initial.ingressStore.get(stored!.pending!.envelope.triggerId))!.runId!
    } finally { initial.close() }

    const restarted = await localHost(path)
    try {
      const recovered = await restarted.scheduler().tick('orders', at('09:00'))
      expect(recovered.state?.pending).toBeUndefined()
      expect(recovered.state?.last).toMatchObject({ runId, scheduledAt: at('09:00'), status: 'launched' })
      expect(await restarted.ingressStore.list()).toHaveLength(1)
      const worker = new WorkflowRunWorker(restarted.runtime, restarted.coordinator)
      await expect(worker.runOnce({ workerId: 'first', leaseMs: 1_000 })).resolves.toMatchObject({ runId, status: 'completed' })
      await expect(worker.runOnce({ workerId: 'second', leaseMs: 1_000 })).resolves.toBeUndefined()
    } finally { restarted.close() }
  })
})

describe('durable terminal delivery recovery', () => {
  it('retains queue custody if the first delivery write fails, then sends without re-execution after restart', async () => {
    const path = tempDatabase()
    let hasAuthority = true
    const tool = vi.fn(async (input: JsonObject) => ({ echo: input.message ?? '' }))
    const gateway = { deliver: vi.fn(async () => {}) }
    const initial = await localHost(path, { available: () => hasAuthority, tool })
    const deliveryRef = 'fixture:personal-notification'
    let runId: string
    try {
      await initial.bindings.publish({ ...candidate, spec: { ...candidate.spec, deliveryRef } }, 0)
      runId = (await initial.scheduler().tick('orders', at('09:00'))).state!.lastRunId!
      const failedStore = { async get() { return undefined }, async listAttention() { return [] }, async save() { throw new Error('simulated first delivery write outage') } }
      const delivery = new WorkflowResultDeliveryService(gateway, failedStore)
      const worker = new WorkflowRunWorker(initial.runtime, initial.coordinator, delivery)
      await expect(worker.runOnce({ workerId: 'before-outage', leaseMs: 1_000 })).rejects.toThrow('first delivery write outage')
      expect((await initial.runtime.getRun(runId))?.status).toBe('completed')
      expect(tool).toHaveBeenCalledTimes(1)
      expect(gateway.deliver).not.toHaveBeenCalled()
    } finally { initial.close() }

    hasAuthority = false
    const restarted = await localHost(path, { available: () => hasAuthority, tool })
    const deliveryStore = new SqliteWorkflowDeliveryStore({ path })
    try {
      const delivery = new WorkflowResultDeliveryService(gateway, deliveryStore)
      const worker = new WorkflowRunWorker(restarted.runtime, restarted.coordinator, delivery)
      await expect(worker.runOnce({ workerId: 'after-restart', leaseMs: 1_000 })).resolves.toMatchObject({ runId, status: 'completed' })
      await expect(worker.runOnce({ workerId: 'empty', leaseMs: 1_000 })).resolves.toBeUndefined()
      expect(tool).toHaveBeenCalledTimes(1)
      expect(gateway.deliver).toHaveBeenCalledTimes(1)
      const invocationId = workflowDeliveryInvocationId({ runId, deliveryRef, phase: 'terminal' })
      expect(await deliveryStore.get(invocationId)).toMatchObject({ status: 'delivered', attempts: 1 })
    } finally { restarted.close(); deliveryStore.close() }
  })

  it('isolates failures, persists retry deadlines, and allows explicit retry with the same invocation ID', async () => {
    const path = tempDatabase()
    let time = 100
    let fail = new Set(['oldest', 'later'])
    const gateway = { deliver: vi.fn(async (request: WorkflowDeliveryRequest) => {
      if (fail.has(request.runId)) throw new Error(`simulated delivery failure: ${request.runId}`)
    }) }
    const policy = { baseDelayMs: 50, maxDelayMs: 100, maxAutomaticAttempts: 2 }
    const request = (runId: string) => ({ runId, deliveryRef: 'fixture:notifications', phase: 'terminal' as const, payload: { result: runId } })
    const initial = new SqliteWorkflowDeliveryStore({ path })
    try {
      const service = new WorkflowResultDeliveryService(gateway, initial, () => time, policy)
      await expect(service.deliver(request('oldest'))).rejects.toThrow('oldest')
      time += 1
      await expect(service.deliver(request('later'))).rejects.toThrow('later')
    } finally { initial.close() }

    const reopened = new SqliteWorkflowDeliveryStore({ path })
    try {
      const service = new WorkflowResultDeliveryService(gateway, reopened, () => time, policy)
      expect(await service.retryDue()).toEqual({ delivered: [], failed: [] })
      time = 151; fail = new Set(['oldest'])
      const second = await service.retryDue()
      expect(second.delivered.map(record => record.runId)).toEqual(['later'])
      expect(second.failed.map(record => record.runId)).toEqual(['oldest'])
      const invocationId = workflowDeliveryInvocationId(request('oldest'))
      expect(await reopened.get(invocationId)).toMatchObject({ status: 'unknown', attempts: 2, manualRetryRequired: true })
      time = 1000
      expect(await service.retryDue()).toEqual({ delivered: [], failed: [] })
      fail.clear()
      expect(await service.retry(invocationId)).toMatchObject({ invocationId, status: 'delivered', attempts: 3 })
    } finally { reopened.close() }
  })
})
