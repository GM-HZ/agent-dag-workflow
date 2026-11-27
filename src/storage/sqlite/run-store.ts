import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import {
  WorkflowRunStoreError,
  parseWorkflowTemplate,
  snapshotJsonValue,
  stableJsonStringify,
  validateRunStoreCommit,
  type JsonValue,
  type JsonObject,
  type WorkflowEvent,
  type WorkflowRunCheckpoint,
  type WorkflowRunHistoryItem,
  type WorkflowRunHistoryPage,
  type WorkflowRunHistoryQuery,
  type WorkflowRunRecord,
  type WorkflowRunMetadata,
  type WorkflowRunStore,
  type WorkflowRunEventWindow,
} from '../../core/index.js'
import { isPersistedWorkflowRunStatus, normalizeRunHistoryText, runHistoryPage, validateRunHistoryQuery } from '../../core/run-store.js'
import { JOURNAL_FAILURE_EVENT, JOURNAL_NODE_ID, openWorkflowDatabase, transaction, type SqliteWorkflowOptions } from './database.js'

export type SqliteWorkflowRunStoreOptions = SqliteWorkflowOptions
export interface WorkflowRunPruneRequest {
  readonly terminalBefore: number
  readonly limit?: number
  readonly authorityRef?: string
  readonly runIds?: readonly string[]
}
export interface WorkflowRunPruneResult { readonly runIds: readonly string[] }

export class SqliteWorkflowRunStore implements WorkflowRunStore {
  private readonly db: DatabaseSync

  constructor(options: SqliteWorkflowRunStoreOptions) {
    this.db = openWorkflowDatabase(options)
  }

  close(): void {
    this.db.close()
  }

  async createRun(record: WorkflowRunRecord): Promise<void> {
    if (record.checkpoint.seq !== 0 || record.events.length !== 0 || record.checkpoint.runId !== record.runId) {
      throw new WorkflowRunStoreError('RUN_COMMIT_INVALID', 'new workflow run must start at checkpoint seq 0 with no events')
    }
    transaction(this.db, () => {
      if (this.exists(record.runId)) throw new WorkflowRunStoreError('RUN_ALREADY_EXISTS', `workflow run already exists: ${record.runId}`)
      this.db.prepare(`INSERT INTO workflow_runs
        (run_id, template_json, semantic_hash, plan_json, inputs_json, execution_json, launch_json, created_at, checkpoint_json, checkpoint_seq, status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`)
        .run(
          record.runId,
          encode(record.template as unknown as JsonValue),
          record.semanticHash,
          encode(record.plan as unknown as JsonValue),
          encode(record.inputs),
          encode(record.execution as unknown as JsonValue),
          encode(record.launch as unknown as JsonValue),
          record.createdAt,
          encode(record.checkpoint as unknown as JsonValue),
          record.checkpoint.status,
          record.checkpoint.updatedAt,
        )
    })
  }

  async commit(runId: string, expectedSeq: number, checkpoint: WorkflowRunCheckpoint, events: readonly WorkflowEvent[]): Promise<void> {
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

  async loadRun(runId: string): Promise<WorkflowRunRecord | undefined> {
    return this.#readSnapshot(runId)
  }

  async exportRun(runId: string): Promise<WorkflowRunRecord | undefined> {
    return this.#readSnapshot(runId)
  }

  #readSnapshot(runId: string): WorkflowRunRecord | undefined {
    this.db.exec('BEGIN')
    try {
      const record = this.#loadRun(runId, true)
      this.db.exec('COMMIT')
      return record
    } catch (error: unknown) {
      try { this.db.exec('ROLLBACK') } catch { /* retain the original read error */ }
      throw error
    }
  }

  async getRunInputs(runId: string): Promise<JsonObject | undefined> {
    const row = this.db.prepare('SELECT inputs_json FROM workflow_runs WHERE run_id = ?').get(runId)
    return row === undefined ? undefined : decode(stringColumn(rowRecord(row), 'inputs_json')) as JsonObject
  }

  async prune(request: WorkflowRunPruneRequest): Promise<WorkflowRunPruneResult> {
    return transaction(this.db, () => {
      const runIds = this.#pruneCandidates(request)
      const remove = this.db.prepare('DELETE FROM workflow_runs WHERE run_id = ?')
      for (const id of runIds) remove.run(id)
      return { runIds }
    })
  }

  async previewPrune(request: WorkflowRunPruneRequest): Promise<WorkflowRunPruneResult> {
    return { runIds: this.#pruneCandidates(request) }
  }

  #pruneCandidates(request: WorkflowRunPruneRequest): string[] {
    if (!Number.isSafeInteger(request.terminalBefore) || request.terminalBefore < 0) throw new Error('terminalBefore must be a non-negative safe integer')
    const limit = request.limit ?? 100
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error('prune limit must be between 1 and 10000')
    const scope = request.authorityRef ?? null
    const ids = request.runIds === undefined ? null : JSON.stringify(request.runIds)
    return this.db.prepare(`SELECT run_id FROM workflow_runs AS run
      WHERE status IN ('completed', 'failed', 'cancelled') AND updated_at < ?
        AND (? IS NULL OR json_extract(execution_json, '$.authorityRef') = ?)
        AND (? IS NULL OR run.run_id IN (SELECT value FROM json_each(?)))
        AND NOT EXISTS (SELECT 1 FROM workflow_run_queue AS queue WHERE queue.run_id = run.run_id)
        AND NOT EXISTS (SELECT 1 FROM workflow_delivery AS delivery
          WHERE delivery.status <> 'delivered' AND json_extract(delivery.record_json, '$.runId') = run.run_id)
      ORDER BY updated_at, run_id LIMIT ?`).all(request.terminalBefore, scope, scope, ids, ids, limit)
      .map(row => stringColumn(rowRecord(row), 'run_id'))
  }

  backupTo(path: string): void {
    if (typeof path !== 'string' || path.length === 0 || path === ':memory:') throw new Error('backup path must be a non-empty filesystem path')
    this.db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`)
  }

  #loadRun(runId: string, includeEvents: boolean): WorkflowRunRecord | undefined {
    const row = this.db.prepare(`SELECT run_id, template_json, semantic_hash, plan_json, inputs_json, execution_json, launch_json, created_at, checkpoint_json, checkpoint_seq
      FROM workflow_runs WHERE run_id = ?`).get(runId)
    if (row === undefined) return undefined
    const record = rowRecord(row)
    const events = includeEvents
      ? this.db.prepare('SELECT event_json FROM workflow_run_events WHERE run_id = ? AND seq <= ? ORDER BY seq').all(runId, integerColumn(record, 'checkpoint_seq'))
          .map(value => decode(stringColumn(rowRecord(value), 'event_json')) as unknown as WorkflowEvent)
      : []
    const result: WorkflowRunRecord = {
      runId: stringColumn(record, 'run_id'),
      template: parseWorkflowTemplate(stringColumn(record, 'template_json')),
      semanticHash: stringColumn(record, 'semantic_hash'),
      plan: decode(stringColumn(record, 'plan_json')) as unknown as WorkflowRunRecord['plan'],
      inputs: decode(stringColumn(record, 'inputs_json')) as import('../../core/index.js').JsonObject,
      execution: decode(stringColumn(record, 'execution_json')) as unknown as WorkflowRunRecord['execution'],
      launch: decode(stringColumn(record, 'launch_json')) as unknown as WorkflowRunRecord['launch'],
      createdAt: integerColumn(record, 'created_at'),
      checkpoint: decode(stringColumn(record, 'checkpoint_json')) as unknown as WorkflowRunCheckpoint,
      events,
    }
    return snapshotJsonValue(result) as unknown as WorkflowRunRecord
  }

  async listRecoverableRuns(): Promise<readonly WorkflowRunRecord[]> {
    const records = this.db.prepare(`SELECT run_id FROM workflow_runs WHERE status IN ('running', 'paused') ORDER BY created_at, run_id`).all()
      .map(row => this.#loadRun(stringColumn(rowRecord(row), 'run_id'), false))
    return records.filter((record): record is WorkflowRunRecord => record !== undefined)
  }

  async getCheckpoint(runId: string): Promise<WorkflowRunCheckpoint | undefined> {
    const row = this.db.prepare('SELECT checkpoint_json FROM workflow_runs WHERE run_id = ?').get(runId)
    return row === undefined
      ? undefined
      : decode(stringColumn(rowRecord(row), 'checkpoint_json')) as unknown as WorkflowRunCheckpoint
  }

  async getRunStatus(runId: string) {
    const row = this.db.prepare('SELECT status FROM workflow_runs WHERE run_id = ?').get(runId)
    if (row === undefined) return undefined
    const status = row.status
    if (!isPersistedWorkflowRunStatus(status)) throw new Error('SQLite column status is not a workflow run status')
    return status
  }

  async getRunMetadata(runId: string): Promise<WorkflowRunMetadata | undefined> {
    const row = this.db.prepare(`SELECT run_id, template_json, semantic_hash, plan_json, execution_json, launch_json, created_at
      FROM workflow_runs WHERE run_id = ?`).get(runId)
    if (row === undefined) return undefined
    const record = rowRecord(row)
    return snapshotJsonValue({
      runId: stringColumn(record, 'run_id'),
      templateId: parseWorkflowTemplate(stringColumn(record, 'template_json')).metadata.id,
      semanticHash: stringColumn(record, 'semantic_hash'),
      plan: decode(stringColumn(record, 'plan_json')),
      execution: decode(stringColumn(record, 'execution_json')),
      launch: decode(stringColumn(record, 'launch_json')),
      createdAt: integerColumn(record, 'created_at'),
    }) as unknown as WorkflowRunMetadata
  }

  async readEvents(runId: string, query: { readonly afterSeq?: number; readonly limit?: number } = {}): Promise<readonly WorkflowEvent[]> {
    const after = query.afterSeq ?? 0
    const limit = Math.min(1001, Math.max(1, query.limit ?? 100))
    return this.db.prepare('SELECT event_json FROM workflow_run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(runId, after, limit)
      .map(value => decode(stringColumn(rowRecord(value), 'event_json')) as unknown as WorkflowEvent)
  }

  async queryEvents(runId: string, query: WorkflowRunEventWindow): Promise<readonly WorkflowEvent[]> {
    const filters = ['run_id = ?', 'seq > ?']
    const values: (string | number)[] = [runId, query.afterSeq]
    if (query.throughSeq !== undefined) { filters.push('seq <= ?'); values.push(query.throughSeq) }
    if (query.beforeSeq !== undefined) { filters.push('seq < ?'); values.push(query.beforeSeq) }
    if (query.nodeId !== undefined) { filters.push(`${JOURNAL_NODE_ID} = ?`); values.push(query.nodeId) }
    if (query.failuresOnly === true) filters.push(JOURNAL_FAILURE_EVENT)
    return this.db.prepare(`SELECT event_json FROM workflow_run_events WHERE ${filters.join(' AND ')}
      ORDER BY seq ${query.descending ? 'DESC' : 'ASC'} LIMIT ?`)
      .all(...values, query.limit).map(value => decode(stringColumn(rowRecord(value), 'event_json')) as unknown as WorkflowEvent)
  }

  async listRuns(query: WorkflowRunHistoryQuery = {}): Promise<WorkflowRunHistoryPage> {
    const limit = validateRunHistoryQuery(query)
    const filters: string[] = []
    const parameters: Array<string | number> = []
    if (query.authorityRef !== undefined) {
      filters.push(`json_extract(execution_json, '$.authorityRef') = ?`)
      parameters.push(query.authorityRef)
    }
    if (query.templateId !== undefined) {
      filters.push(`json_extract(template_json, '$.metadata.id') = ?`)
      parameters.push(query.templateId)
    }
    if (query.status !== undefined) {
      filters.push('status = ?')
      parameters.push(query.status)
    }
    const search = normalizeRunHistoryText(query.query)
    if (search.length > 0) {
      filters.push(`(instr(lower(run_id), ?) > 0 OR instr(lower(json_extract(template_json, '$.metadata.id')), ?) > 0
        OR instr(lower(json_extract(template_json, '$.metadata.name')), ?) > 0)`)
      parameters.push(search, search, search)
    }
    if (query.revision !== undefined) {
      filters.push(`json_extract(plan_json, '$.root.revision') = ?`)
      parameters.push(query.revision)
    }
    if (query.origin !== undefined) {
      filters.push(`(json_extract(execution_json, '$.origin.type') = ? OR json_extract(execution_json, '$.origin.source') = ?)`)
      parameters.push(query.origin, query.origin)
    }
    if (query.from !== undefined) { filters.push('updated_at >= ?'); parameters.push(query.from) }
    if (query.through !== undefined) { filters.push('updated_at <= ?'); parameters.push(query.through) }
    if (query.after !== undefined) {
      filters.push('(updated_at, run_id) < (?, ?)')
      parameters.push(query.after.updatedAt, query.after.runId)
    }
    const where = filters.length === 0 ? '' : `WHERE ${filters.join(' AND ')}`
    const rows = this.db.prepare(`
      SELECT run_id, status, updated_at, created_at, checkpoint_seq,
        json_extract(template_json, '$.metadata.id') AS template_id,
        json_extract(template_json, '$.metadata.name') AS template_name,
        json_extract(plan_json, '$.root.revision') AS revision,
        json_extract(execution_json, '$.authorityRef') AS authority_ref,
        json_extract(execution_json, '$.origin.type') AS origin_type,
        json_extract(execution_json, '$.origin.source') AS origin_source,
        json_extract(execution_json, '$.origin.sourceRef') AS origin_source_ref,
        EXISTS (SELECT 1 FROM json_each(checkpoint_json, '$.nodeStates') WHERE value = 'needs_attention') AS needs_attention
      FROM workflow_runs ${where}
      ORDER BY updated_at DESC, run_id DESC LIMIT ?
    `).all(...parameters, limit + 1)
    return runHistoryPage(rows.map(readHistoryItem), limit)
  }

  private exists(runId: string): boolean {
    return this.db.prepare('SELECT 1 AS value FROM workflow_runs WHERE run_id = ?').get(runId) !== undefined
  }
}

function readHistoryItem(value: unknown): WorkflowRunHistoryItem {
  const row = rowRecord(value)
  const status = row.status
  if (!isPersistedWorkflowRunStatus(status)) throw new Error('SQLite column status is not a workflow run status')
  return {
    runId: stringColumn(row, 'run_id'),
    templateId: stringColumn(row, 'template_id'),
    templateName: stringColumn(row, 'template_name'),
    ...(row.revision === null ? {} : { revision: integerColumn(row, 'revision') }),
    authorityRef: stringColumn(row, 'authority_ref'),
    origin: {
      type: stringColumn(row, 'origin_type'),
      ...(row.origin_source === null ? {} : { source: stringColumn(row, 'origin_source') }),
      ...(row.origin_source_ref === null ? {} : { sourceRef: stringColumn(row, 'origin_source_ref') }),
    },
    status,
    createdAt: integerColumn(row, 'created_at'),
    updatedAt: integerColumn(row, 'updated_at'),
    checkpointSeq: integerColumn(row, 'checkpoint_seq'),
    needsAttention: integerColumn(row, 'needs_attention') === 1,
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

function integerColumn(value: unknown, name: string): number {
  const field = rowRecord(value)[name]
  if (typeof field !== 'number' || !Number.isSafeInteger(field)) throw new Error(`SQLite column ${name} is not a safe integer`)
  return field
}
