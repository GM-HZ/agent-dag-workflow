import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import { snapshotJsonValue, stableJsonStringify } from '../../core/index.js'
import type { WorkflowIngressRecord, WorkflowIngressStore } from '../../triggers/core/index.js'
import { openWorkflowDatabase, transaction, type SqliteWorkflowOptions } from './database.js'

export type SqliteWorkflowIngressStoreOptions = SqliteWorkflowOptions

export class SqliteWorkflowIngressStore implements WorkflowIngressStore {
  readonly #db: DatabaseSync
  constructor(options: SqliteWorkflowIngressStoreOptions) { this.#db = openWorkflowDatabase(options) }
  close(): void { this.#db.close() }

  async acceptOrGet(record: WorkflowIngressRecord): Promise<{ readonly record: WorkflowIngressRecord; readonly accepted: boolean }> {
    return transaction(this.#db, () => {
      const prior = this.#db.prepare('SELECT record_json FROM workflow_ingress WHERE dedupe_key = ?').get(record.dedupeKey)
      if (prior !== undefined) {
        const current = decode(text(prior, 'record_json'))
        const duplicate = snapshotJsonValue({
          ...current,
          duplicateCount: (current.duplicateCount ?? 0) + 1,
          lastDuplicateAt: record.receivedAt,
          duplicateTriggerIds: [...(current.duplicateTriggerIds ?? []), record.triggerId].slice(-32),
        }) as unknown as WorkflowIngressRecord
        this.#db.prepare('UPDATE workflow_ingress SET record_json = ?, updated_at = ? WHERE dedupe_key = ?')
          .run(encode(duplicate), record.receivedAt, record.dedupeKey)
        return { record: duplicate, accepted: false }
      }
      this.#db.prepare(`INSERT INTO workflow_ingress (trigger_id, dedupe_key, status, record_json, updated_at)
        VALUES (?, ?, 'received', ?, ?)`)
        .run(record.triggerId, record.dedupeKey, encode(record), record.receivedAt)
      return { record: decode(encode(record)), accepted: true }
    })
  }

  async markLaunched(triggerId: string, runId: string): Promise<void> { this.#transition(triggerId, { status: 'launched', runId }) }
  async markRejected(triggerId: string, reasonCode: string): Promise<void> { this.#transition(triggerId, { status: 'rejected', reasonCode }) }
  async get(triggerId: string): Promise<WorkflowIngressRecord | undefined> {
    const row = this.#db.prepare('SELECT record_json FROM workflow_ingress WHERE trigger_id = ?').get(triggerId)
    return row === undefined ? undefined : decode(text(row, 'record_json'))
  }
  async listPending(): Promise<readonly WorkflowIngressRecord[]> {
    return this.#db.prepare(`SELECT record_json FROM workflow_ingress WHERE status = 'received' ORDER BY updated_at, trigger_id`).all()
      .map(row => decode(text(row, 'record_json')))
  }
  async list(query: { readonly limit?: number } = {}): Promise<readonly WorkflowIngressRecord[]> {
    const limit = Math.min(1000, Math.max(1, query.limit ?? 100))
    return this.#db.prepare('SELECT record_json FROM workflow_ingress ORDER BY updated_at DESC, trigger_id LIMIT ?').all(limit)
      .map(row => decode(text(row, 'record_json')))
  }

  #transition(triggerId: string, change: { readonly status: 'launched'; readonly runId: string } | { readonly status: 'rejected'; readonly reasonCode: string }): void {
    transaction(this.#db, () => {
      const row = this.#db.prepare('SELECT status, record_json FROM workflow_ingress WHERE trigger_id = ?').get(triggerId)
      if (row === undefined) throw new Error(`workflow ingress record not found: ${triggerId}`)
      const status = text(row, 'status')
      if (status === change.status) return
      if (status !== 'received') throw new Error(`workflow ingress ${triggerId} cannot transition from ${status}`)
      const next = snapshotJsonValue({ ...decode(text(row, 'record_json')), ...change }) as unknown as WorkflowIngressRecord
      const result = this.#db.prepare(`UPDATE workflow_ingress SET status = ?, record_json = ?, updated_at = ? WHERE trigger_id = ? AND status = 'received'`)
        .run(change.status, encode(next), Date.now(), triggerId)
      if (result.changes !== 1) throw new Error(`workflow ingress transition raced: ${triggerId}`)
    })
  }
}

function encode(record: WorkflowIngressRecord): string { return stableJsonStringify(record as unknown as import('../../core/index.js').JsonValue) }
function decode(value: string): WorkflowIngressRecord { return snapshotJsonValue(JSON.parse(value)) as unknown as WorkflowIngressRecord }
function text(row: unknown, name: string): string {
  const value = (row as Record<string, SQLOutputValue>)[name]
  if (typeof value !== 'string') throw new Error(`workflow ingress column ${name} is invalid`)
  return value
}
