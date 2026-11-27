import { randomUUID } from 'node:crypto'
import { snapshotJsonValue, type JsonValue } from '../../core/index.js'
import type { WorkflowRunSummary } from '../../runtime/index.js'
import type { WorkflowBindingCatalog, WorkflowIngressRecord, WorkflowTriggerBinding, WorkflowTriggerEnvelope, WorkflowTriggerIngress } from '../core/index.js'
import { CRON_MINUTE_MS, cronMinute, createCronTrigger, readCronBindingOptions } from './trigger.js'

export interface WorkflowCronDecision {
  readonly scheduledAt: number
  readonly status: 'launched' | 'rejected' | 'skipped-overlap' | 'skipped-misfire'
  readonly manual: boolean
  readonly triggerId?: string
  readonly runId?: string
  readonly reasonCode?: string
}

export interface WorkflowCronState {
  readonly bindingId: string
  readonly bindingRevision: number
  readonly generation: number
  readonly checkedThrough: number
  readonly lastTickAt?: number
  readonly activeRunIds: readonly string[]
  readonly last?: WorkflowCronDecision
  readonly lastRunId?: string
  readonly pending?: { readonly envelope: WorkflowTriggerEnvelope; readonly manual: boolean; readonly bindingRevision: number }
}

export interface WorkflowCronStore {
  get(bindingId: string): Promise<WorkflowCronState | undefined>
  save(state: WorkflowCronState, expectedGeneration: number): Promise<void>
}

export interface WorkflowCronSnapshot {
  readonly binding: WorkflowTriggerBinding
  readonly state?: WorkflowCronState
  readonly nextRunAt?: number
  readonly lastRun?: Pick<WorkflowRunSummary, 'runId' | 'status' | 'updatedAt' | 'error'>
}

export interface WorkflowCronTickBatch {
  readonly schedules: readonly WorkflowCronSnapshot[]
  readonly failed: readonly { readonly bindingId: string; readonly error: string }[]
  readonly decisions: readonly { readonly bindingId: string; readonly decision: WorkflowCronDecision }[]
}

export class WorkflowCronStateConflict extends Error {
  constructor(readonly bindingId: string) { super(`workflow schedule state changed: ${bindingId}`); this.name = 'WorkflowCronStateConflict' }
}

export class InMemoryWorkflowCronStore implements WorkflowCronStore {
  readonly #states = new Map<string, WorkflowCronState>()

  async get(bindingId: string): Promise<WorkflowCronState | undefined> { return this.#states.get(bindingId) }

  async save(state: WorkflowCronState, expectedGeneration: number): Promise<void> {
    if (state.generation !== expectedGeneration + 1 || (this.#states.get(state.bindingId)?.generation ?? 0) !== expectedGeneration) {
      throw new WorkflowCronStateConflict(state.bindingId)
    }
    this.#states.set(state.bindingId, snapshotJsonValue(state as unknown as JsonValue) as unknown as WorkflowCronState)
  }
}

/** One persisted scheduler for local hosts. Its caller owns the clock and invokes each tick. */
export class WorkflowCronScheduler {
  readonly #inflight = new Map<string, Promise<WorkflowCronSnapshot>>()

  constructor(
    private readonly bindings: Pick<WorkflowBindingCatalog, 'get' | 'list'>,
    private readonly ingress: Pick<WorkflowTriggerIngress, 'ingest' | 'recoverOccurrence'>,
    private readonly runtime: { getRun(id: string): Promise<WorkflowCronSnapshot['lastRun']> },
    private readonly store: WorkflowCronStore,
    private readonly now: () => number = Date.now,
  ) {}

  async inspect(bindingId: string, time = this.now()): Promise<WorkflowCronSnapshot> {
    const binding = await this.bindings.get(bindingId)
    return this.#snapshot(binding, await this.store.get(bindingId), time)
  }

  async tick(bindingId: string, time = this.now()): Promise<WorkflowCronSnapshot> {
    return this.#serialize(bindingId, () => this.#dispatch(bindingId, time, false))
  }

  async runNow(bindingId: string, time = this.now()): Promise<WorkflowCronSnapshot> {
    return this.#serialize(bindingId, () => this.#dispatch(bindingId, time, true))
  }

  async tickAll(time = this.now()): Promise<WorkflowCronTickBatch> {
    const schedules: WorkflowCronSnapshot[] = []
    const failed: WorkflowCronTickBatch['failed'][number][] = []
    const decisions: WorkflowCronTickBatch['decisions'][number][] = []
    let afterId: string | undefined
    const limit = 100
    for (;;) {
      const page = await this.bindings.list({ latestOnly: true, limit, ...(afterId === undefined ? {} : { afterId }) })
      for (const binding of page) {
        if (binding.spec.trigger.uses !== 'cron@1') continue
        const bindingId = binding.metadata.id
        try {
          const prior = (await this.store.get(bindingId))?.last
          const schedule = await this.tick(bindingId, time)
          schedules.push(schedule)
          const current = schedule.state?.last
          if (current !== undefined && (prior?.scheduledAt !== current.scheduledAt || prior.status !== current.status
            || prior.manual !== current.manual || prior.triggerId !== current.triggerId)) decisions.push({ bindingId, decision: current })
        }
        catch (error: unknown) { failed.push({ bindingId, error: error instanceof Error ? error.message : String(error) }) }
      }
      if (page.length < limit) return { schedules, failed, decisions }
      const nextId = page.at(-1)!.metadata.id
      if (afterId !== undefined && nextId <= afterId) throw new Error('workflow bindings repository did not advance the schedule cursor')
      afterId = nextId
    }
  }

  #serialize(bindingId: string, action: () => Promise<WorkflowCronSnapshot>): Promise<WorkflowCronSnapshot> {
    const previous = this.#inflight.get(bindingId)
    const task = previous === undefined ? action() : previous.then(action, action)
    this.#inflight.set(bindingId, task)
    return task.finally(() => { if (this.#inflight.get(bindingId) === task) this.#inflight.delete(bindingId) })
  }

  async #dispatch(bindingId: string, time: number, manual: boolean): Promise<WorkflowCronSnapshot> {
    const minute = cronMinute(time)
    const binding = await this.bindings.get(bindingId)
    const config = bindingOptions(binding)
    let state = await this.store.get(bindingId) ?? {
      bindingId, bindingRevision: binding.metadata.revision, generation: 0,
      checkedThrough: minute - CRON_MINUTE_MS, activeRunIds: [],
    }
    if (state.pending !== undefined) {
      state = await this.#finishPending(state)
      if (manual) return this.#snapshot(binding, state, time)
    }
    const lastTickAt = manual ? state.lastTickAt : Math.max(time, state.lastTickAt ?? time)
    const tick = lastTickAt === undefined ? {} : { lastTickAt }
    if (binding.spec.enabled === false) {
      if (manual) throw new Error(`workflow schedule is disabled: ${bindingId}`)
      // Time while intentionally disabled is never eligible for catch-up.
      if (state.checkedThrough < minute || state.bindingRevision !== binding.metadata.revision || state.lastTickAt !== lastTickAt) {
        state = await this.#save(state, { ...state, ...tick, checkedThrough: Math.max(state.checkedThrough, minute), bindingRevision: binding.metadata.revision })
      }
      return this.#snapshot(binding, state, time)
    }

    // A newly selected binding revision starts now instead of running its new
    // parameters against clock ticks recorded for a previous revision.
    const sameRevision = state.bindingRevision === binding.metadata.revision
    const checkedThrough = sameRevision ? state.checkedThrough : Math.max(state.checkedThrough, minute - CRON_MINUTE_MS)
    if (!manual && checkedThrough >= minute) {
      if (!sameRevision || state.lastTickAt !== lastTickAt) {
        state = await this.#save(state, { ...state, ...tick, checkedThrough, bindingRevision: binding.metadata.revision })
      }
      return this.#snapshot(binding, state, time)
    }
    const cron = createCronTrigger({ ...config, now: () => time })
    const current = new Date(minute)
    const latest = manual || cron.matches(current) ? current : cron.latestRunAt(current, new Date(checkedThrough))
    const active = await Promise.all(state.activeRunIds.map(runId => this.runtime.getRun(runId)))
    const activeRunIds = active.filter(run => run?.status === 'running' || run?.status === 'paused').map(run => run!.runId)
    const next = { ...state, ...tick, bindingRevision: binding.metadata.revision, activeRunIds, checkedThrough: manual ? checkedThrough : minute }
    if (latest === undefined) return this.#snapshot(binding, await this.#save(state, next), time)

    const scheduledAt = latest.getTime()
    const skippingMisfire = !manual && scheduledAt !== minute && config.misfirePolicy !== 'fire-once'
    const skippingOverlap = config.overlapPolicy !== 'allow' && activeRunIds.length > 0
    if (skippingMisfire || skippingOverlap) {
      next.last = { scheduledAt, manual, status: skippingMisfire ? 'skipped-misfire' : 'skipped-overlap' }
      return this.#snapshot(binding, await this.#save(state, next), time)
    }

    const scheduled = cron.envelope(latest)
    const envelope = manual ? { ...scheduled, sourceEventId: `cron:manual:${randomUUID()}` } : scheduled
    const pending = { envelope, manual, bindingRevision: binding.metadata.revision }
    state = await this.#save(state, { ...next, pending })
    return this.#snapshot(binding, await this.#finishPending(state), time)
  }

  async #finishPending(state: WorkflowCronState): Promise<WorkflowCronState> {
    const { pending, ...cleared } = state
    if (pending === undefined) return state
    const binding = await this.bindings.get(state.bindingId, pending.bindingRevision)
    const record = await this.ingress.ingest(binding, pending.envelope)
    const occurrence = record.status === 'deduplicated' ? await this.ingress.recoverOccurrence(record.triggerId) : record
    const last = asDecision(occurrence, pending)
    const runId = last.runId
    return this.#save(state, {
      ...cleared, last,
      ...(runId === undefined ? {} : { lastRunId: runId, activeRunIds: [...new Set([...cleared.activeRunIds, runId])] }),
    })
  }

  async #save(current: WorkflowCronState, next: WorkflowCronState): Promise<WorkflowCronState> {
    const state = { ...next, generation: current.generation + 1 }
    await this.store.save(state, current.generation)
    return state
  }

  async #snapshot(binding: WorkflowTriggerBinding, state: WorkflowCronState | undefined, time: number): Promise<WorkflowCronSnapshot> {
    return describeWorkflowCronSchedule(binding, state, id => this.runtime.getRun(id), time)
  }
}

export async function describeWorkflowCronSchedule(
  binding: WorkflowTriggerBinding, state: WorkflowCronState | undefined,
  getRun: (id: string) => Promise<WorkflowCronSnapshot['lastRun']>, time = Date.now(),
): Promise<WorkflowCronSnapshot> {
  const config = bindingOptions(binding)
  const comparisonTime = Math.max(cronMinute(time), state?.checkedThrough ?? time)
  const nextRunAt = binding.spec.enabled === false ? undefined : createCronTrigger(config).nextRunAt(new Date(comparisonTime))?.getTime()
  const run = state?.lastRunId === undefined ? undefined : await getRun(state.lastRunId)
  return {
    binding,
    ...(state === undefined ? {} : { state }),
    ...(nextRunAt === undefined ? {} : { nextRunAt }),
    ...(run === undefined ? {} : { lastRun: { runId: run.runId, status: run.status, updatedAt: run.updatedAt,
      ...(run.error === undefined ? {} : { error: run.error }) } }),
  }
}

function bindingOptions(binding: WorkflowTriggerBinding) {
  if (binding.spec.trigger.uses !== 'cron@1') throw new Error(`workflow binding is not a cron schedule: ${binding.metadata.id}`)
  return readCronBindingOptions(binding.spec.trigger.with)
}

function asDecision(record: WorkflowIngressRecord, pending: NonNullable<WorkflowCronState['pending']>): WorkflowCronDecision {
  if (record.status !== 'launched' && record.status !== 'rejected') throw new Error(`workflow cron occurrence is unresolved: ${record.triggerId}`)
  return {
    scheduledAt: pending.envelope.occurredAt!, manual: pending.manual, status: record.status, triggerId: record.triggerId,
    ...(record.runId === undefined ? {} : { runId: record.runId }),
    ...(record.reasonCode === undefined ? {} : { reasonCode: record.reasonCode }),
  }
}
