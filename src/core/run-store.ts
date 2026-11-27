import { snapshotJsonObject, snapshotJsonValue, stableJsonStringify } from './json.js'
import type {
  PersistedWorkflowRunStatus,
  WorkflowRunCheckpoint,
  WorkflowRunHistoryItem,
  WorkflowRunHistoryPage,
  WorkflowRunHistoryQuery,
  WorkflowRunRecord,
  WorkflowRunStore,
  WorkflowEvent,
  WorkflowEventType,
  WorkflowRunEventWindow,
} from './types.js'

export type WorkflowRunStoreErrorCode = 'RUN_ALREADY_EXISTS' | 'RUN_NOT_FOUND' | 'RUN_SEQUENCE_CONFLICT' | 'RUN_COMMIT_INVALID'
export const MAX_WORKFLOW_COMMIT_BYTES = 16 * 1024 * 1024

export const WORKFLOW_JOURNAL_FAILURE_TYPES = [
  'node.failed', 'node.retry-scheduled', 'node.needs-attention', 'capability.failed', 'run.failed', 'run.paused',
] as const satisfies readonly WorkflowEventType[]
const failureTypes = new Set<WorkflowEventType>(WORKFLOW_JOURNAL_FAILURE_TYPES)

export function matchesWorkflowEventWindow(event: WorkflowEvent, window: WorkflowRunEventWindow): boolean {
  return event.seq > window.afterSeq && (window.throughSeq === undefined || event.seq <= window.throughSeq)
    && (window.beforeSeq === undefined || event.seq < window.beforeSeq)
    && (window.nodeId === undefined || (event.node?.id ?? ('nodeId' in event ? event.nodeId : undefined)) === window.nodeId)
    && (window.failuresOnly !== true || failureTypes.has(event.type))
}

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

  async queryEvents(runId: string, query: WorkflowRunEventWindow): Promise<readonly WorkflowEvent[]> {
    const events = this.records.get(runId)?.events ?? []
    const selected: WorkflowEvent[] = []
    for (let index = query.descending ? events.length - 1 : 0;
      index >= 0 && index < events.length && selected.length < query.limit; index += query.descending ? -1 : 1) {
      const event = events[index]!
      if (matchesWorkflowEventWindow(event, query)) selected.push(event)
    }
    return selected
  }

  async listRuns(query: WorkflowRunHistoryQuery = {}): Promise<WorkflowRunHistoryPage> {
    const limit = validateRunHistoryQuery(query)
    const after = query.after
    const search = normalizeRunHistoryText(query.query)
    const records = [...this.records.values()]
      .filter(record => (query.authorityRef === undefined || record.execution.authorityRef === query.authorityRef)
        && (query.templateId === undefined || record.template.metadata.id === query.templateId)
        && (query.status === undefined || record.checkpoint.status === query.status)
        && (query.revision === undefined || record.plan.root.revision === query.revision)
        && (query.origin === undefined || record.execution.origin.type === query.origin || record.execution.origin.source === query.origin)
        && (query.from === undefined || record.checkpoint.updatedAt >= query.from)
        && (query.through === undefined || record.checkpoint.updatedAt <= query.through)
        && (search.length === 0 || [record.runId, record.template.metadata.id, record.template.metadata.name].some(value => normalizeRunHistoryText(value).includes(search)))
        && (after === undefined || record.checkpoint.updatedAt < after.updatedAt
          || (record.checkpoint.updatedAt === after.updatedAt && compareRunId(record.runId, after.runId) < 0)))
      .sort((left, right) => right.checkpoint.updatedAt - left.checkpoint.updatedAt || compareRunId(right.runId, left.runId))
      .slice(0, limit + 1)
    return runHistoryPage(records.map(runHistoryItem), limit)
  }

  async listRecoverableRuns(): Promise<readonly WorkflowRunRecord[]> {
    return [...this.records.values()]
      .filter(record => record.checkpoint.status === 'running' || record.checkpoint.status === 'paused')
      .sort((left, right) => left.createdAt - right.createdAt)
  }
}

export function isPersistedWorkflowRunStatus(value: unknown): value is PersistedWorkflowRunStatus {
  return value === 'running' || value === 'completed' || value === 'failed' || value === 'cancelled' || value === 'paused'
}

export function validateRunHistoryQuery(query: WorkflowRunHistoryQuery): number {
  const limit = query.limit ?? 25
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('workflow run history limit must be between 1 and 100')
  if (query.status !== undefined && !isPersistedWorkflowRunStatus(query.status)) throw new Error('workflow run history status is invalid')
  if (normalizeRunHistoryText(query.query).length > 256) throw new Error('workflow run history query must be at most 256 characters')
  if (query.revision !== undefined && (!Number.isSafeInteger(query.revision) || query.revision < 1)) throw new Error('workflow run history revision must be a positive safe integer')
  for (const time of [query.from, query.through]) {
    if (time !== undefined && (!Number.isSafeInteger(time) || time < 0)) throw new Error('workflow run history time must be a non-negative safe integer')
  }
  if (query.from !== undefined && query.through !== undefined && query.from > query.through) throw new Error('workflow run history time range is inverted')
  const after = query.after
  if (after !== undefined && (!Number.isSafeInteger(after.updatedAt) || typeof after.runId !== 'string')) {
    throw new Error('workflow run history cursor requires an integer updatedAt and a string runId')
  }
  return limit
}

// Match SQLite's built-in lower() for stable user-visible search across stores.
export function normalizeRunHistoryText(value: string | undefined): string {
  return (value ?? '').trim().replace(/[A-Z]/g, character => character.toLowerCase())
}

export function runHistoryPage(items: readonly WorkflowRunHistoryItem[], limit: number): WorkflowRunHistoryPage {
  if (items.length <= limit) return { items }
  const page = items.slice(0, limit)
  const last = page[page.length - 1]!
  return { items: page, nextAfter: { updatedAt: last.updatedAt, runId: last.runId } }
}

function runHistoryItem(record: WorkflowRunRecord): WorkflowRunHistoryItem {
  const { revision } = record.plan.root
  const { type, source, sourceRef } = record.execution.origin
  return {
    runId: record.runId,
    templateId: record.template.metadata.id,
    templateName: record.template.metadata.name,
    ...(revision === undefined ? {} : { revision }),
    authorityRef: record.execution.authorityRef,
    origin: { type, ...(source === undefined ? {} : { source }), ...(sourceRef === undefined ? {} : { sourceRef }) },
    status: record.checkpoint.status,
    createdAt: record.createdAt,
    updatedAt: record.checkpoint.updatedAt,
    checkpointSeq: record.checkpoint.seq,
    needsAttention: Object.values(record.checkpoint.nodeStates).includes('needs_attention'),
  }
}

function compareRunId(left: string, right: string): number {
  // Compare the same UTF-8 byte order as SQLite's BINARY collation.
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
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
  const bytes = Buffer.byteLength(stableJsonStringify({ checkpoint, events } as unknown as import('./types.js').JsonValue), 'utf8')
  if (bytes > MAX_WORKFLOW_COMMIT_BYTES) {
    throw new WorkflowRunStoreError('RUN_COMMIT_INVALID', `workflow run commit is ${bytes} bytes, limit is ${MAX_WORKFLOW_COMMIT_BYTES}`)
  }
}

function snapshotRecord(record: WorkflowRunRecord): WorkflowRunRecord {
  return snapshotJsonValue(record) as unknown as WorkflowRunRecord
}

export function snapshotRunCheckpoint(checkpoint: WorkflowRunCheckpoint): WorkflowRunCheckpoint {
  return snapshotJsonObject(checkpoint as unknown as Record<string, import('./types.js').JsonValue>) as unknown as WorkflowRunCheckpoint
}
