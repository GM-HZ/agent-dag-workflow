import { snapshotJsonObject, snapshotJsonValue, type JsonObject } from '../../core/index.js'

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
}

export class InMemoryWorkflowDeliveryStore implements WorkflowDeliveryStore {
  readonly #records = new Map<string, WorkflowDeliveryRecord>()
  async get(invocationId: string): Promise<WorkflowDeliveryRecord | undefined> { return this.#records.get(invocationId) }
  async save(record: WorkflowDeliveryRecord, expectedAttempts: number): Promise<void> {
    const current = this.#records.get(record.invocationId)
    if ((current?.attempts ?? 0) !== expectedAttempts) throw new Error(`workflow delivery attempt conflict: ${record.invocationId}`)
    this.#records.set(record.invocationId, snapshotJsonValue(record) as unknown as WorkflowDeliveryRecord)
  }
}

export class WorkflowResultDeliveryService {
  readonly #now: () => number
  constructor(
    private readonly gateway: WorkflowResultDeliveryGateway,
    private readonly store: WorkflowDeliveryStore,
    now: () => number = Date.now,
  ) { this.#now = now }

  async deliver(request: WorkflowDeliveryRequest): Promise<WorkflowDeliveryRecord> {
    const invocationId = `${request.runId}:${request.deliveryRef}:${request.phase}`
    const current = await this.store.get(invocationId)
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
