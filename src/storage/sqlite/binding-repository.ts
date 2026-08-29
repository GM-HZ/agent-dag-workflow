import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import { snapshotJsonValue, stableJsonStringify } from '../../core/index.js'
import {
  WorkflowBindingError,
  type WorkflowBindingRepository,
  type WorkflowTriggerBinding,
  type WorkflowTriggerBindingCandidate,
} from '../../triggers/core/index.js'
import { openWorkflowDatabase, transaction, type SqliteWorkflowOptions } from './database.js'

export type SqliteWorkflowBindingRepositoryOptions = SqliteWorkflowOptions

export class SqliteWorkflowBindingRepository implements WorkflowBindingRepository {
  readonly #db: DatabaseSync
  constructor(options: SqliteWorkflowBindingRepositoryOptions) { this.#db = openWorkflowDatabase(options) }
  close(): void { this.#db.close() }

  async publish(candidate: WorkflowTriggerBindingCandidate, expectedRevision: number, publishedAt: number): Promise<WorkflowTriggerBinding> {
    return transaction(this.#db, () => {
      const latest = integer(this.#db.prepare('SELECT COALESCE(MAX(revision), 0) AS value FROM workflow_bindings WHERE id = ?').get(candidate.metadata.id), 'value')
      if (latest !== expectedRevision) {
        throw new WorkflowBindingError('BINDING_REVISION_CONFLICT', `workflow binding ${candidate.metadata.id} expected revision ${expectedRevision}, actual ${latest}`)
      }
      const binding = snapshotJsonValue({ ...candidate, metadata: { id: candidate.metadata.id, revision: latest + 1 } }) as unknown as WorkflowTriggerBinding
      this.#db.prepare(`INSERT INTO workflow_bindings (id, revision, binding_json, published_at) VALUES (?, ?, ?, ?)`)
        .run(binding.metadata.id, binding.metadata.revision, encode(binding), publishedAt)
      return binding
    })
  }

  async get(id: string, revision?: number): Promise<WorkflowTriggerBinding | undefined> {
    const row = revision === undefined
      ? this.#db.prepare('SELECT binding_json FROM workflow_bindings WHERE id = ? ORDER BY revision DESC LIMIT 1').get(id)
      : this.#db.prepare('SELECT binding_json FROM workflow_bindings WHERE id = ? AND revision = ?').get(id, revision)
    return row === undefined ? undefined : decode(text(row, 'binding_json'))
  }

  async list(query: { readonly limit?: number } = {}): Promise<readonly WorkflowTriggerBinding[]> {
    const limit = query.limit ?? 100
    return this.#db.prepare('SELECT binding_json FROM workflow_bindings ORDER BY id, revision DESC LIMIT ?').all(limit)
      .map(row => decode(text(row, 'binding_json')))
  }
}

function encode(binding: WorkflowTriggerBinding): string {
  return stableJsonStringify(binding as unknown as import('../../core/index.js').JsonValue)
}
function decode(value: string): WorkflowTriggerBinding {
  return snapshotJsonValue(JSON.parse(value)) as unknown as WorkflowTriggerBinding
}
function text(row: unknown, name: string): string {
  const value = (row as Record<string, SQLOutputValue>)[name]
  if (typeof value !== 'string') throw new Error(`workflow binding column ${name} is invalid`)
  return value
}
function integer(row: unknown, name: string): number {
  const value = (row as Record<string, SQLOutputValue>)[name]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`workflow binding column ${name} is invalid`)
  return value
}
