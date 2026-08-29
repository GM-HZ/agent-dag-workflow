import { snapshotJsonValue } from '../../core/index.js'
import type { WorkflowIngressRecord, WorkflowIngressStore } from './types.js'

export class InMemoryWorkflowIngressStore implements WorkflowIngressStore {
  readonly #records = new Map<string, WorkflowIngressRecord>()
  readonly #dedupe = new Map<string, string>()

  async acceptOrGet(record: WorkflowIngressRecord): Promise<{ readonly record: WorkflowIngressRecord; readonly accepted: boolean }> {
    const priorId = this.#dedupe.get(record.dedupeKey)
    if (priorId !== undefined) {
      const prior = this.#records.get(priorId)!
      const duplicate = snapshotJsonValue({
        ...prior,
        duplicateCount: (prior.duplicateCount ?? 0) + 1,
        lastDuplicateAt: record.receivedAt,
        duplicateTriggerIds: [...(prior.duplicateTriggerIds ?? []), record.triggerId].slice(-32),
      }) as unknown as WorkflowIngressRecord
      this.#records.set(priorId, duplicate)
      return { record: duplicate, accepted: false }
    }
    if (this.#records.has(record.triggerId)) throw new Error(`trigger id already exists with another dedupe key: ${record.triggerId}`)
    const snapshot = snapshotJsonValue(record) as unknown as WorkflowIngressRecord
    this.#records.set(record.triggerId, snapshot)
    this.#dedupe.set(record.dedupeKey, record.triggerId)
    return { record: snapshot, accepted: true }
  }

  async markLaunched(triggerId: string, runId: string): Promise<void> { this.#transition(triggerId, { status: 'launched', runId }) }
  async markRejected(triggerId: string, reasonCode: string): Promise<void> { this.#transition(triggerId, { status: 'rejected', reasonCode }) }
  async get(triggerId: string): Promise<WorkflowIngressRecord | undefined> { return this.#records.get(triggerId) }
  async listPending(): Promise<readonly WorkflowIngressRecord[]> { return [...this.#records.values()].filter(item => item.status === 'received') }
  async list(query: { readonly limit?: number } = {}): Promise<readonly WorkflowIngressRecord[]> {
    const limit = Math.min(1000, Math.max(1, query.limit ?? 100))
    return [...this.#records.values()].sort((left, right) => right.receivedAt - left.receivedAt || left.triggerId.localeCompare(right.triggerId)).slice(0, limit)
  }

  #transition(triggerId: string, change: { readonly status: 'launched'; readonly runId: string } | { readonly status: 'rejected'; readonly reasonCode: string }): void {
    const current = this.#records.get(triggerId)
    if (current === undefined) throw new Error(`workflow ingress record not found: ${triggerId}`)
    if (current.status === change.status) return
    if (current.status !== 'received') throw new Error(`workflow ingress ${triggerId} cannot transition from ${current.status} to ${change.status}`)
    this.#records.set(triggerId, snapshotJsonValue({ ...current, ...change }) as unknown as WorkflowIngressRecord)
  }
}
