import type { DatabaseSync } from 'node:sqlite'
import { snapshotJsonValue, stableJsonStringify, type JsonValue } from '../../core/index.js'
import { WorkflowCronStateConflict, type WorkflowCronState, type WorkflowCronStore } from '../../triggers/cron/index.js'
import { openWorkflowDatabase, type SqliteWorkflowOptions } from './database.js'

export type SqliteWorkflowCronStoreOptions = SqliteWorkflowOptions

export class SqliteWorkflowCronStore implements WorkflowCronStore {
  readonly #db: DatabaseSync

  constructor(options: SqliteWorkflowCronStoreOptions) { this.#db = openWorkflowDatabase(options) }
  close(): void { this.#db.close() }

  async get(bindingId: string): Promise<WorkflowCronState | undefined> {
    const row = this.#db.prepare('SELECT state_json FROM workflow_cron_schedules WHERE binding_id = ?').get(bindingId)
    if (row === undefined) return undefined
    if (typeof row.state_json !== 'string') throw new Error('workflow cron schedule state is invalid')
    return snapshotJsonValue(JSON.parse(row.state_json)) as unknown as WorkflowCronState
  }

  async save(state: WorkflowCronState, expectedGeneration: number): Promise<void> {
    if (state.generation !== expectedGeneration + 1) throw new WorkflowCronStateConflict(state.bindingId)
    const serialized = stableJsonStringify(state as unknown as JsonValue)
    const result = expectedGeneration === 0
      ? this.#db.prepare(`INSERT INTO workflow_cron_schedules (binding_id, generation, state_json) VALUES (?, ?, ?)
          ON CONFLICT(binding_id) DO NOTHING`).run(state.bindingId, state.generation, serialized)
      : this.#db.prepare(`UPDATE workflow_cron_schedules SET generation = ?, state_json = ?
          WHERE binding_id = ? AND generation = ?`).run(state.generation, serialized, state.bindingId, expectedGeneration)
    if (result.changes !== 1) throw new WorkflowCronStateConflict(state.bindingId)
  }
}
