import { snapshotJsonObject, snapshotJsonValue } from './json.js'
import type { WorkflowRunCheckpoint, WorkflowRunRecord, WorkflowRunStore } from './types.js'

export type WorkflowRunStoreErrorCode = 'RUN_ALREADY_EXISTS' | 'RUN_NOT_FOUND' | 'RUN_SEQUENCE_CONFLICT' | 'RUN_COMMIT_INVALID'

export class WorkflowRunStoreError extends Error {
  readonly code: WorkflowRunStoreErrorCode

  constructor(code: WorkflowRunStoreErrorCode, message: string) {
    super(message)
    this.name = 'WorkflowRunStoreError'
    this.code = code
  }
}

export class InMemoryWorkflowRunStore implements WorkflowRunStore {
  private readonly records = new Map<string, WorkflowRunRecord>()

  async createRun(record: WorkflowRunRecord): Promise<void> {
    if (this.records.has(record.runId)) throw new WorkflowRunStoreError('RUN_ALREADY_EXISTS', `workflow run already exists: ${record.runId}`)
    if (record.checkpoint.seq !== 0 || record.events.length !== 0 || record.checkpoint.runId !== record.runId) {
      throw new WorkflowRunStoreError('RUN_COMMIT_INVALID', 'new workflow run must start at checkpoint seq 0 with no events')
    }
    this.records.set(record.runId, snapshotRecord(record))
  }

  async commit(runId: string, expectedSeq: number, checkpoint: WorkflowRunCheckpoint, events: readonly import('./types.js').WorkflowEvent[]): Promise<void> {
    const current = this.records.get(runId)
    if (current === undefined) throw new WorkflowRunStoreError('RUN_NOT_FOUND', `workflow run not found: ${runId}`)
    if (current.checkpoint.seq !== expectedSeq) {
      throw new WorkflowRunStoreError('RUN_SEQUENCE_CONFLICT', `workflow run ${runId} expected seq ${expectedSeq}, actual ${current.checkpoint.seq}`)
    }
    validateCommit(runId, expectedSeq, checkpoint, events)
    this.records.set(runId, snapshotRecord({
      ...current,
      checkpoint,
      events: [...current.events, ...events],
    }))
  }

  async loadRun(runId: string): Promise<WorkflowRunRecord | undefined> {
    return this.records.get(runId)
  }

  async getCheckpoint(runId: string): Promise<WorkflowRunCheckpoint | undefined> {
    return this.records.get(runId)?.checkpoint
  }

  async getRunMetadata(runId: string): Promise<import('./types.js').WorkflowRunMetadata | undefined> {
    const record = this.records.get(runId)
    return record === undefined ? undefined : snapshotJsonValue({
      runId: record.runId,
      templateId: record.template.metadata.id,
      semanticHash: record.semanticHash,
      plan: record.plan,
      execution: record.execution,
      launch: record.launch,
      createdAt: record.createdAt,
    }) as unknown as import('./types.js').WorkflowRunMetadata
  }

  async readEvents(runId: string, query: { readonly afterSeq?: number; readonly limit?: number } = {}): Promise<readonly import('./types.js').WorkflowEvent[]> {
    const after = query.afterSeq ?? 0
    const limit = Math.min(1001, Math.max(1, query.limit ?? 100))
    return this.records.get(runId)?.events.filter(event => event.seq > after).slice(0, limit) ?? []
  }

  async listRecoverableRuns(): Promise<readonly WorkflowRunRecord[]> {
    return [...this.records.values()]
      .filter(record => record.checkpoint.status === 'running' || record.checkpoint.status === 'paused')
      .sort((left, right) => left.createdAt - right.createdAt)
  }
}

export function validateRunStoreCommit(
  runId: string,
  expectedSeq: number,
  checkpoint: WorkflowRunCheckpoint,
  events: readonly import('./types.js').WorkflowEvent[],
): void {
  validateCommit(runId, expectedSeq, checkpoint, events)
}

function validateCommit(
  runId: string,
  expectedSeq: number,
  checkpoint: WorkflowRunCheckpoint,
  events: readonly import('./types.js').WorkflowEvent[],
): void {
  if (events.length === 0) throw new WorkflowRunStoreError('RUN_COMMIT_INVALID', 'workflow run commit requires at least one event')
  for (const [index, event] of events.entries()) {
    const expected = expectedSeq + index + 1
    if (event.runId !== runId || event.seq !== expected) {
      throw new WorkflowRunStoreError('RUN_COMMIT_INVALID', `workflow event must be ${runId} seq ${expected}`)
    }
  }
  if (checkpoint.runId !== runId || checkpoint.seq !== expectedSeq + events.length || checkpoint.version !== 1) {
    throw new WorkflowRunStoreError('RUN_COMMIT_INVALID', 'checkpoint identity/sequence does not match committed events')
  }
}

function snapshotRecord(record: WorkflowRunRecord): WorkflowRunRecord {
  return snapshotJsonValue(record) as unknown as WorkflowRunRecord
}

export function snapshotRunCheckpoint(checkpoint: WorkflowRunCheckpoint): WorkflowRunCheckpoint {
  return snapshotJsonObject(checkpoint as unknown as Record<string, import('./types.js').JsonValue>) as unknown as WorkflowRunCheckpoint
}
