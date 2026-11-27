import { createHash } from 'node:crypto'
import { snapshotJsonObject, snapshotJsonValue, stableJsonStringify, type JsonObject, type JsonValue } from '../../core/index.js'

export type WorkflowDeliveryPhase = 'accepted' | 'progress' | 'terminal'

export interface WorkflowDeliveryRequest {
  readonly runId: string
  readonly deliveryRef: string
  readonly phase: WorkflowDeliveryPhase
  readonly payload: JsonObject
}

export interface WorkflowDeliveryRecord extends WorkflowDeliveryRequest {
  readonly invocationId: string
  readonly status: 'pending' | 'delivered' | 'unknown'
  readonly attempts: number
  readonly updatedAt: number
  readonly error?: string
  readonly nextAttemptAt?: number
  readonly manualRetryRequired?: boolean
}

export interface WorkflowResultDeliveryGateway {
  /** Reuse invocationId as the external idempotency key across attempts. */
  deliver(request: WorkflowDeliveryRequest & { readonly invocationId: string }): Promise<void>
}

export interface WorkflowDeliveryStore {
  get(invocationId: string): Promise<WorkflowDeliveryRecord | undefined>
  save(record: WorkflowDeliveryRecord, expectedAttempts: number): Promise<void>
  listAttention(query?: WorkflowDeliveryListQuery): Promise<readonly WorkflowDeliveryRecord[]>
}

export interface WorkflowDeliveryListQuery {
  readonly limit?: number
  readonly dueAt?: number
  readonly authorityRef?: string
}

export interface WorkflowDeliveryRetryOptions {
  readonly baseDelayMs?: number
  readonly maxDelayMs?: number
  readonly maxAutomaticAttempts?: number
}

export interface WorkflowDeliveryRetryBatch {
  readonly delivered: readonly WorkflowDeliveryRecord[]
  readonly failed: readonly { readonly invocationId: string; readonly runId: string; readonly error: string }[]
}

export class InMemoryWorkflowDeliveryStore implements WorkflowDeliveryStore {
  readonly #records = new Map<string, WorkflowDeliveryRecord>()
  constructor(private readonly runOwner?: (runId: string) => Promise<string | undefined>) {}
  async get(invocationId: string): Promise<WorkflowDeliveryRecord | undefined> { return this.#records.get(invocationId) }
  async save(record: WorkflowDeliveryRecord, expectedAttempts: number): Promise<void> {
    const current = this.#records.get(record.invocationId)
    if ((current?.attempts ?? 0) !== expectedAttempts) throw new Error(`workflow delivery attempt conflict: ${record.invocationId}`)
    this.#records.set(record.invocationId, snapshotJsonValue(record) as unknown as WorkflowDeliveryRecord)
  }
  async listAttention(query: WorkflowDeliveryListQuery = {}): Promise<readonly WorkflowDeliveryRecord[]> {
    const limit = Math.min(1000, Math.max(1, query.limit ?? 100))
    const rows = [...this.#records.values()].filter(record => needsDelivery(record, query.dueAt))
    const scoped = query.authorityRef === undefined ? rows : await Promise.all(rows.map(async row =>
      await this.runOwner?.(row.runId) === query.authorityRef ? row : undefined))
    return scoped.filter(row => row !== undefined)
      .sort((left, right) => left.updatedAt - right.updatedAt || left.invocationId.localeCompare(right.invocationId)).slice(0, limit)
  }
}

export class WorkflowResultDeliveryService {
  readonly #now: () => number
  readonly #retry: Required<WorkflowDeliveryRetryOptions>
  readonly #inflight = new Map<string, { readonly payload: string; readonly result: Promise<WorkflowDeliveryRecord> }>()
  constructor(
    private readonly gateway: WorkflowResultDeliveryGateway,
    private readonly store: WorkflowDeliveryStore,
    now: () => number = Date.now,
    retry: WorkflowDeliveryRetryOptions = {},
  ) {
    this.#now = now
    this.#retry = {
      baseDelayMs: retry.baseDelayMs ?? 5_000,
      maxDelayMs: retry.maxDelayMs ?? 15 * 60_000,
      maxAutomaticAttempts: retry.maxAutomaticAttempts ?? 8,
    }
    if (Object.values(this.#retry).some(value => !Number.isSafeInteger(value) || value < 1)
      || this.#retry.maxDelayMs < this.#retry.baseDelayMs) throw new Error('invalid workflow delivery retry policy')
  }

  async deliver(request: WorkflowDeliveryRequest): Promise<WorkflowDeliveryRecord> {
    const invocationId = workflowDeliveryInvocationId(request)
    const payload = snapshotJsonObject(request.payload)
    const payloadKey = stableJsonStringify(payload)
    const inflight = this.#inflight.get(invocationId)
    if (inflight !== undefined) {
      if (inflight.payload !== payloadKey) throw deliveryConflict(invocationId)
      return inflight.result
    }
    const immutable = { runId: request.runId, deliveryRef: request.deliveryRef, phase: request.phase, payload }
    const entry = { payload: payloadKey, result: this.#deliver(immutable, invocationId) }
    this.#inflight.set(invocationId, entry)
    try { return await entry.result } finally { if (this.#inflight.get(invocationId) === entry) this.#inflight.delete(invocationId) }
  }

  async hasRecord(request: WorkflowDeliveryRequest): Promise<boolean> {
    const invocationId = workflowDeliveryInvocationId(request)
    const current = await this.store.get(invocationId)
    if (current === undefined) return false
    assertDeliveryRequest(current, request, invocationId)
    return true
  }

  /** Explicit operator retry. Uses the persisted payload and invocation ID. */
  async retry(invocationId: string): Promise<WorkflowDeliveryRecord> {
    const record = await this.store.get(invocationId)
    if (record === undefined) throw new Error(`workflow delivery not found: ${invocationId}`)
    return this.deliver(record)
  }

  async retryAttention(query: { readonly limit?: number } = {}): Promise<readonly WorkflowDeliveryRecord[]> {
    const batch = await this.retryDue(query)
    if (batch.failed.length > 0) {
      throw new AggregateError(batch.failed.map(item => new Error(`${item.invocationId}: ${item.error}`)), 'workflow deliveries require attention')
    }
    return batch.delivered
  }

  async retryDue(query: { readonly limit?: number } = {}): Promise<WorkflowDeliveryRetryBatch> {
    const delivered: WorkflowDeliveryRecord[] = []
    const failed: WorkflowDeliveryRetryBatch['failed'][number][] = []
    const dueAt = this.#now()
    for (const record of await this.store.listAttention({ ...query, dueAt })) {
      if (!needsDelivery(record, dueAt)) continue
      try {
        const result = await this.deliver(record)
        if (result.status === 'delivered') delivered.push(result)
      }
      catch (error: unknown) { failed.push({ invocationId: record.invocationId, runId: record.runId, error: errorMessage(error) }) }
    }
    return { delivered, failed }
  }

  async #deliver(request: WorkflowDeliveryRequest, invocationId: string): Promise<WorkflowDeliveryRecord> {
    const current = await this.store.get(invocationId)
    if (current !== undefined) assertDeliveryRequest(current, request, invocationId)
    if (current?.status === 'delivered') return current
    const startedAt = this.#now()
    if (current?.status === 'pending' && (current.nextAttemptAt ?? 0) > startedAt) return current
    const attempts = current?.attempts ?? 0
    const attempt = { ...request, invocationId, attempts: attempts + 1 }
    const pending: WorkflowDeliveryRecord = {
      ...attempt, status: 'pending', updatedAt: startedAt, nextAttemptAt: startedAt + this.#retry.maxDelayMs,
      ...(attempt.attempts >= this.#retry.maxAutomaticAttempts ? { manualRetryRequired: true } : {}),
    }
    await this.store.save(pending, attempts)
    try {
      await this.gateway.deliver({ ...request, invocationId })
      const delivered = { ...attempt, status: 'delivered' as const, updatedAt: this.#now() }
      await this.store.save(delivered, pending.attempts)
      return delivered
    } catch (error: unknown) {
      const latest = await this.store.get(invocationId)
      if (latest?.status === 'delivered') return latest
      if (latest?.attempts === attempt.attempts) {
        const unknown = this.#scheduleRetry({ ...attempt, status: 'unknown', updatedAt: this.#now(), error: errorMessage(error) })
        await this.store.save(unknown, pending.attempts)
      }
      throw error
    }
  }

  #scheduleRetry(record: WorkflowDeliveryRecord): WorkflowDeliveryRecord {
    if (record.attempts >= this.#retry.maxAutomaticAttempts) return { ...record, manualRetryRequired: true }
    const delay = Math.min(this.#retry.maxDelayMs, this.#retry.baseDelayMs * 2 ** (record.attempts - 1))
    return { ...record, nextAttemptAt: record.updatedAt + delay }
  }
}

function needsDelivery(record: WorkflowDeliveryRecord, dueAt: number | undefined): boolean {
  return record.status !== 'delivered'
    && (dueAt === undefined || (record.manualRetryRequired !== true && (record.nextAttemptAt ?? 0) <= dueAt))
}

function assertDeliveryRequest(record: WorkflowDeliveryRecord, request: WorkflowDeliveryRequest, invocationId: string): void {
  if (record.runId !== request.runId || record.deliveryRef !== request.deliveryRef || record.phase !== request.phase
    || stableJsonStringify(record.payload) !== stableJsonStringify(request.payload)) throw deliveryConflict(invocationId)
}

function deliveryConflict(invocationId: string): Error {
  return new Error(`workflow delivery invocation is already bound to another immutable request: ${invocationId}`)
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }

export function workflowDeliveryInvocationId(request: Pick<WorkflowDeliveryRequest, 'runId' | 'deliveryRef' | 'phase'>): string {
  if (request.runId.length === 0 || request.runId.length > 1024
    || request.deliveryRef.length === 0 || request.deliveryRef.length > 4096
    || !(['accepted', 'progress', 'terminal'] as const).includes(request.phase)) {
    throw new Error('workflow delivery identity is invalid')
  }
  const tuple = [request.runId, request.deliveryRef, request.phase] as JsonValue
  return `delivery-${createHash('sha256').update(stableJsonStringify(tuple)).digest('hex')}`
}
