import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import { snapshotJsonValue, stableJsonStringify } from '../../core/index.js'
import type { WorkflowDeliveryRecord, WorkflowDeliveryStore } from '../../triggers/core/index.js'
import { openWorkflowDatabase, transaction, type SqliteWorkflowOptions } from './database.js'

export type SqliteWorkflowDeliveryStoreOptions = SqliteWorkflowOptions

export class SqliteWorkflowDeliveryStore implements WorkflowDeliveryStore {
  readonly #db: DatabaseSync
  constructor(options: SqliteWorkflowDeliveryStoreOptions) { this.#db = openWorkflowDatabase(options) }
  close(): void { this.#db.close() }

  async get(invocationId: string): Promise<WorkflowDeliveryRecord | undefined> {
    const row = this.#db.prepare('SELECT record_json FROM workflow_delivery WHERE invocation_id = ?').get(invocationId)
    return row === undefined ? undefined : decode(text(row, 'record_json'))
  }

  async save(record: WorkflowDeliveryRecord, expectedAttempts: number): Promise<void> {
    transaction(this.#db, () => {
      const current = this.#db.prepare('SELECT attempts FROM workflow_delivery WHERE invocation_id = ?').get(record.invocationId)
      const attempts = current === undefined ? 0 : integer(current, 'attempts')
      if (attempts !== expectedAttempts) throw new Error(`workflow delivery attempt conflict: ${record.invocationId}`)
      if (current === undefined) {
        this.#db.prepare(`INSERT INTO workflow_delivery (invocation_id, status, attempts, record_json, updated_at)
          VALUES (?, ?, ?, ?, ?)`).run(record.invocationId, record.status, record.attempts, encode(record), record.updatedAt)
      } else {
        const result = this.#db.prepare(`UPDATE workflow_delivery SET status = ?, attempts = ?, record_json = ?, updated_at = ?
          WHERE invocation_id = ? AND attempts = ?`).run(record.status, record.attempts, encode(record), record.updatedAt, record.invocationId, expectedAttempts)
        if (result.changes !== 1) throw new Error(`workflow delivery attempt conflict: ${record.invocationId}`)
      }
    })
  }

  async listAttention(query: { readonly limit?: number } = {}): Promise<readonly WorkflowDeliveryRecord[]> {
    const limit = Math.min(1000, Math.max(1, query.limit ?? 100))
    return this.#db.prepare(`SELECT record_json FROM workflow_delivery WHERE status IN ('pending', 'unknown')
      ORDER BY updated_at, invocation_id LIMIT ?`).all(limit).map(row => decode(text(row, 'record_json')))
  }
}

function encode(record: WorkflowDeliveryRecord): string { return stableJsonStringify(record as unknown as import('../../core/index.js').JsonValue) }
function decode(value: string): WorkflowDeliveryRecord { return snapshotJsonValue(JSON.parse(value)) as unknown as WorkflowDeliveryRecord }
function text(row: unknown, name: string): string {
  const value = (row as Record<string, SQLOutputValue>)[name]
  if (typeof value !== 'string') throw new Error(`workflow delivery column ${name} is invalid`)
  return value
}
function integer(row: unknown, name: string): number {
  const value = (row as Record<string, SQLOutputValue>)[name]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`workflow delivery column ${name} is invalid`)
  return value
}
