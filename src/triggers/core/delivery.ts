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
}

export interface WorkflowResultDeliveryGateway {
  deliver(request: WorkflowDeliveryRequest & { readonly invocationId: string }): Promise<void>
}

export interface WorkflowDeliveryStore {
  get(invocationId: string): Promise<WorkflowDeliveryRecord | undefined>
  save(record: WorkflowDeliveryRecord, expectedAttempts: number): Promise<void>
  listAttention(query?: { readonly limit?: number }): Promise<readonly WorkflowDeliveryRecord[]>
}

export class InMemoryWorkflowDeliveryStore implements WorkflowDeliveryStore {
  readonly #records = new Map<string, WorkflowDeliveryRecord>()
  async get(invocationId: string): Promise<WorkflowDeliveryRecord | undefined> { return this.#records.get(invocationId) }
  async save(record: WorkflowDeliveryRecord, expectedAttempts: number): Promise<void> {
    const current = this.#records.get(record.invocationId)
    if ((current?.attempts ?? 0) !== expectedAttempts) throw new Error(`workflow delivery attempt conflict: ${record.invocationId}`)
    this.#records.set(record.invocationId, snapshotJsonValue(record) as unknown as WorkflowDeliveryRecord)
  }
  async listAttention(query: { readonly limit?: number } = {}): Promise<readonly WorkflowDeliveryRecord[]> {
    const limit = Math.min(1000, Math.max(1, query.limit ?? 100))
    return [...this.#records.values()].filter(record => record.status !== 'delivered')
      .sort((left, right) => left.updatedAt - right.updatedAt || left.invocationId.localeCompare(right.invocationId)).slice(0, limit)
  }
}

export class WorkflowResultDeliveryService {
  readonly #now: () => number
  readonly #inflight = new Map<string, Promise<WorkflowDeliveryRecord>>()
  constructor(
    private readonly gateway: WorkflowResultDeliveryGateway,
    private readonly store: WorkflowDeliveryStore,
    now: () => number = Date.now,
  ) { this.#now = now }

  async deliver(request: WorkflowDeliveryRequest): Promise<WorkflowDeliveryRecord> {
    const invocationId = workflowDeliveryInvocationId(request)
    const inflight = this.#inflight.get(invocationId)
    if (inflight !== undefined) return inflight
    const delivery = this.#deliver(request, invocationId)
    this.#inflight.set(invocationId, delivery)
    try { return await delivery } finally { if (this.#inflight.get(invocationId) === delivery) this.#inflight.delete(invocationId) }
  }

  async retryAttention(query: { readonly limit?: number } = {}): Promise<readonly WorkflowDeliveryRecord[]> {
    const results: WorkflowDeliveryRecord[] = []
    for (const record of await this.store.listAttention(query)) {
      results.push(await this.deliver({ runId: record.runId, deliveryRef: record.deliveryRef, phase: record.phase, payload: record.payload }))
    }
    return results
  }

  async #deliver(request: WorkflowDeliveryRequest, invocationId: string): Promise<WorkflowDeliveryRecord> {
    const current = await this.store.get(invocationId)
    if (current !== undefined && (current.runId !== request.runId || current.deliveryRef !== request.deliveryRef
      || current.phase !== request.phase || stableJsonStringify(current.payload) !== stableJsonStringify(request.payload))) {
      throw new Error(`workflow delivery invocation is already bound to another immutable request: ${invocationId}`)
    }
    if (current?.status === 'delivered') return current
    const attempts = current?.attempts ?? 0
    const pending: WorkflowDeliveryRecord = snapshotJsonValue({
      ...request,
      payload: snapshotJsonObject(request.payload),
      invocationId,
      status: 'pending',
      attempts: attempts + 1,
      updatedAt: this.#now(),
    }) as unknown as WorkflowDeliveryRecord
    await this.store.save(pending, attempts)
    try {
      await this.gateway.deliver({ ...request, invocationId })
      const delivered = { ...pending, status: 'delivered' as const, updatedAt: this.#now() }
      await this.store.save(delivered, pending.attempts)
      return delivered
    } catch (error: unknown) {
      const unknown = {
        ...pending,
        status: 'unknown' as const,
        updatedAt: this.#now(),
        error: error instanceof Error ? error.message : String(error),
      }
      await this.store.save(unknown, pending.attempts)
      throw error
    }
  }
}

export function workflowDeliveryInvocationId(request: Pick<WorkflowDeliveryRequest, 'runId' | 'deliveryRef' | 'phase'>): string {
  if (request.runId.length === 0 || request.runId.length > 1024
    || request.deliveryRef.length === 0 || request.deliveryRef.length > 4096
    || !(['accepted', 'progress', 'terminal'] as const).includes(request.phase)) {
    throw new Error('workflow delivery identity is invalid')
  }
  const tuple = [request.runId, request.deliveryRef, request.phase] as JsonValue
  return `delivery-${createHash('sha256').update(stableJsonStringify(tuple)).digest('hex')}`
}
