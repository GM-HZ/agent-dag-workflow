import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import {
  WorkflowRunStoreError,
  parseWorkflowTemplate,
  snapshotJsonValue,
  stableJsonStringify,
  validateRunStoreCommit,
  type JsonValue,
  type WorkflowEvent,
  type WorkflowRunCheckpoint,
  type WorkflowRunRecord,
  type WorkflowRunStore,
} from '../../core/index.js'
import { openWorkflowDatabase, transaction, type SqliteWorkflowOptions } from './database.js'

export type SqliteWorkflowRunStoreOptions = SqliteWorkflowOptions

export class SqliteWorkflowRunStore implements WorkflowRunStore {
  private readonly db: DatabaseSync

  constructor(options: SqliteWorkflowRunStoreOptions) {
    this.db = openWorkflowDatabase(options)
  }

  close(): void {
    this.db.close()
  }

  createRun(record: WorkflowRunRecord): void {
    if (record.checkpoint.seq !== 0 || record.events.length !== 0 || record.checkpoint.runId !== record.runId) {
      throw new WorkflowRunStoreError('RUN_COMMIT_INVALID', 'new workflow run must start at checkpoint seq 0 with no events')
    }
    transaction(this.db, () => {
      if (this.exists(record.runId)) throw new WorkflowRunStoreError('RUN_ALREADY_EXISTS', `workflow run already exists: ${record.runId}`)
      this.db.prepare(`INSERT INTO workflow_runs
        (run_id, template_json, semantic_hash, inputs_json, execution_json, created_at, checkpoint_json, checkpoint_seq, status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`)
        .run(
          record.runId,
          encode(record.template as unknown as JsonValue),
          record.semanticHash,
          encode(record.inputs),
          encode(record.execution as unknown as JsonValue),
          record.createdAt,
          encode(record.checkpoint as unknown as JsonValue),
          record.checkpoint.status,
          record.checkpoint.updatedAt,
        )
    })
  }

  commit(runId: string, expectedSeq: number, checkpoint: WorkflowRunCheckpoint, events: readonly WorkflowEvent[]): void {
    validateRunStoreCommit(runId, expectedSeq, checkpoint, events)
    transaction(this.db, () => {
      const current = this.db.prepare('SELECT checkpoint_seq FROM workflow_runs WHERE run_id = ?').get(runId)
      if (current === undefined) throw new WorkflowRunStoreError('RUN_NOT_FOUND', `workflow run not found: ${runId}`)
      const actual = integerColumn(current, 'checkpoint_seq')
      if (actual !== expectedSeq) throw new WorkflowRunStoreError('RUN_SEQUENCE_CONFLICT', `workflow run ${runId} expected seq ${expectedSeq}, actual ${actual}`)
      const insert = this.db.prepare('INSERT INTO workflow_run_events (run_id, seq, event_json) VALUES (?, ?, ?)')
      for (const event of events) insert.run(runId, event.seq, encode(event as unknown as JsonValue))
      const result = this.db.prepare(`UPDATE workflow_runs SET checkpoint_json = ?, checkpoint_seq = ?, status = ?, updated_at = ?
        WHERE run_id = ? AND checkpoint_seq = ?`)
        .run(encode(checkpoint as unknown as JsonValue), checkpoint.seq, checkpoint.status, checkpoint.updatedAt, runId, expectedSeq)
      if (result.changes !== 1) throw new WorkflowRunStoreError('RUN_SEQUENCE_CONFLICT', `workflow run ${runId} changed during commit`)
    })
  }

  loadRun(runId: string): WorkflowRunRecord | undefined {
    const row = this.db.prepare(`SELECT run_id, template_json, semantic_hash, inputs_json, execution_json, created_at, checkpoint_json
      FROM workflow_runs WHERE run_id = ?`).get(runId)
    if (row === undefined) return undefined
    const record = rowRecord(row)
    const events = this.db.prepare('SELECT event_json FROM workflow_run_events WHERE run_id = ? ORDER BY seq').all(runId)
      .map(value => decode(stringColumn(rowRecord(value), 'event_json')) as unknown as WorkflowEvent)
    const result: WorkflowRunRecord = {
      runId: stringColumn(record, 'run_id'),
      template: parseWorkflowTemplate(stringColumn(record, 'template_json')),
      semanticHash: stringColumn(record, 'semantic_hash'),
      inputs: decode(stringColumn(record, 'inputs_json')) as import('../../core/index.js').JsonObject,
      execution: decode(stringColumn(record, 'execution_json')) as unknown as WorkflowRunRecord['execution'],
      createdAt: integerColumn(record, 'created_at'),
      checkpoint: decode(stringColumn(record, 'checkpoint_json')) as unknown as WorkflowRunCheckpoint,
      events,
    }
    return snapshotJsonValue(result) as unknown as WorkflowRunRecord
  }

  listRecoverableRuns(): readonly WorkflowRunRecord[] {
    return this.db.prepare(`SELECT run_id FROM workflow_runs WHERE status IN ('running', 'paused') ORDER BY created_at, run_id`).all()
      .map(row => this.loadRun(stringColumn(rowRecord(row), 'run_id'))!)
  }

  private exists(runId: string): boolean {
    return this.db.prepare('SELECT 1 AS value FROM workflow_runs WHERE run_id = ?').get(runId) !== undefined
  }
}

function encode(value: JsonValue): string {
  return stableJsonStringify(value)
}

function decode(value: string): JsonValue {
  return snapshotJsonValue(JSON.parse(value))
}

function rowRecord(value: unknown): Record<string, SQLOutputValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('SQLite returned an invalid row')
  return value as Record<string, SQLOutputValue>
}

function stringColumn(row: Record<string, SQLOutputValue>, name: string): string {
  const value = row[name]
  if (typeof value !== 'string') throw new Error(`SQLite column ${name} is not text`)
  return value
}

function nullableStringColumn(row: Record<string, SQLOutputValue>, name: string): string | undefined {
  const value = row[name]
  if (value === null) return undefined
  if (typeof value !== 'string') throw new Error(`SQLite column ${name} is not nullable text`)
  return value
}

function integerColumn(value: unknown, name: string): number {
  const field = rowRecord(value)[name]
  if (typeof field !== 'number' || !Number.isSafeInteger(field)) throw new Error(`SQLite column ${name} is not a safe integer`)
  return field
}
