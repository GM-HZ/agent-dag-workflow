import { type DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import type { MaterializedWorkflowTemplate, WorkflowTemplate } from '@gm-hz/dsh-dag-workflow-core'
import { parseWorkflowTemplate, stableJsonStringify } from '@gm-hz/dsh-dag-workflow-core'
import {
  WorkflowCatalogError,
  type PublishedWorkflowRevision,
  type WorkflowCatalogRepository,
  type WorkflowCatalogSummary,
  type WorkflowDraft,
} from '@gm-hz/dsh-dag-workflow-catalog'
import { openWorkflowDatabase, transaction, type SqliteWorkflowOptions } from './database.js'

export type SqliteWorkflowCatalogOptions = SqliteWorkflowOptions

export class SqliteWorkflowCatalogRepository implements WorkflowCatalogRepository {
  private readonly db: DatabaseSync

  constructor(options: SqliteWorkflowCatalogOptions) {
    this.db = openWorkflowDatabase(options)
  }

  close(): void {
    this.db.close()
  }

  createDraft(materialized: MaterializedWorkflowTemplate, now: number): WorkflowDraft {
    return transaction(this.db, () => {
      const id = materialized.template.metadata.id
      if (this.readDraft(id) !== undefined) throw new WorkflowCatalogError('CATALOG_ALREADY_EXISTS', `workflow draft already exists: ${id}`)
      this.db.prepare(`INSERT INTO workflow_drafts
        (id, revision, template_json, content_hash, semantic_hash, created_at, updated_at)
        VALUES (?, 1, ?, ?, ?, ?, ?)`)
        .run(id, encodeTemplate(materialized.template), materialized.contentHash, materialized.semanticHash, now, now)
      return this.readDraft(id)!
    })
  }

  readDraft(id: string): WorkflowDraft | undefined {
    const row = this.db.prepare(`SELECT id, revision, template_json, content_hash, semantic_hash, created_at, updated_at
      FROM workflow_drafts WHERE id = ?`).get(id)
    return row === undefined ? undefined : decodeDraft(row)
  }

  updateDraft(id: string, expectedRevision: number, materialized: MaterializedWorkflowTemplate, now: number): WorkflowDraft {
    return transaction(this.db, () => {
      const result = this.db.prepare(`UPDATE workflow_drafts SET
        revision = revision + 1, template_json = ?, content_hash = ?, semantic_hash = ?, updated_at = ?
        WHERE id = ? AND revision = ?`)
        .run(encodeTemplate(materialized.template), materialized.contentHash, materialized.semanticHash, now, id, expectedRevision)
      if (result.changes === 0) this.throwMissingOrConflict(id, expectedRevision)
      return this.readDraft(id)!
    })
  }

  publishDraft(id: string, expectedDraftRevision: number, now: number): PublishedWorkflowRevision {
    return transaction(this.db, () => {
      const draft = this.readDraft(id)
      if (draft === undefined) throw new WorkflowCatalogError('CATALOG_NOT_FOUND', `workflow draft not found: ${id}`)
      if (draft.revision !== expectedDraftRevision) throw revisionConflict(id, expectedDraftRevision, draft.revision)
      const latest = integerColumn(this.db.prepare('SELECT COALESCE(MAX(revision), 0) AS value FROM workflow_revisions WHERE id = ?').get(id), 'value')
      const revision = latest + 1
      this.db.prepare(`INSERT INTO workflow_revisions
        (id, revision, source_draft_revision, template_json, content_hash, semantic_hash, published_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, revision, draft.revision, encodeTemplate(draft.template), draft.contentHash, draft.semanticHash, now)
      return this.readPublished(id, revision)!
    })
  }

  readPublished(id: string, revision?: number): PublishedWorkflowRevision | undefined {
    const row = revision === undefined
      ? this.db.prepare(`SELECT id, revision, source_draft_revision, template_json, content_hash, semantic_hash, published_at
          FROM workflow_revisions WHERE id = ? ORDER BY revision DESC LIMIT 1`).get(id)
      : this.db.prepare(`SELECT id, revision, source_draft_revision, template_json, content_hash, semantic_hash, published_at
          FROM workflow_revisions WHERE id = ? AND revision = ?`).get(id, revision)
    return row === undefined ? undefined : decodePublished(row)
  }

  list(): readonly WorkflowCatalogSummary[] {
    return this.db.prepare(`SELECT d.id, d.revision AS draft_revision, d.template_json, d.updated_at,
      (SELECT MAX(r.revision) FROM workflow_revisions r WHERE r.id = d.id) AS published_revision
      FROM workflow_drafts d ORDER BY d.id`).all().map(row => {
      const record = rowRecord(row)
      const template = decodeTemplate(stringColumn(record, 'template_json'))
      const published = record.published_revision
      return Object.freeze({
        id: stringColumn(record, 'id'),
        name: template.metadata.name,
        draftRevision: integerColumn(record, 'draft_revision'),
        ...(published === null ? {} : { publishedRevision: integerValue(published, 'published_revision') }),
        updatedAt: integerColumn(record, 'updated_at'),
      })
    })
  }

  private throwMissingOrConflict(id: string, expected: number): never {
    const draft = this.readDraft(id)
    if (draft === undefined) throw new WorkflowCatalogError('CATALOG_NOT_FOUND', `workflow draft not found: ${id}`)
    throw revisionConflict(id, expected, draft.revision)
  }
}

function encodeTemplate(template: WorkflowTemplate): string {
  return stableJsonStringify(template as unknown as import('@gm-hz/dsh-dag-workflow-core').JsonValue)
}

function decodeTemplate(value: string): WorkflowTemplate {
  return parseWorkflowTemplate(value)
}

function decodeDraft(value: unknown): WorkflowDraft {
  const row = rowRecord(value)
  return Object.freeze({
    id: stringColumn(row, 'id'),
    revision: integerColumn(row, 'revision'),
    template: decodeTemplate(stringColumn(row, 'template_json')),
    contentHash: stringColumn(row, 'content_hash'),
    semanticHash: stringColumn(row, 'semantic_hash'),
    createdAt: integerColumn(row, 'created_at'),
    updatedAt: integerColumn(row, 'updated_at'),
  })
}

function decodePublished(value: unknown): PublishedWorkflowRevision {
  const row = rowRecord(value)
  return Object.freeze({
    id: stringColumn(row, 'id'),
    revision: integerColumn(row, 'revision'),
    sourceDraftRevision: integerColumn(row, 'source_draft_revision'),
    template: decodeTemplate(stringColumn(row, 'template_json')),
    contentHash: stringColumn(row, 'content_hash'),
    semanticHash: stringColumn(row, 'semantic_hash'),
    publishedAt: integerColumn(row, 'published_at'),
  })
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
  return integerValue(rowRecord(value)[name], name)
}

function integerValue(value: SQLOutputValue | undefined, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`SQLite column ${name} is not a safe integer`)
  return value
}

function revisionConflict(id: string, expected: number, actual: number): WorkflowCatalogError {
  return new WorkflowCatalogError('CATALOG_REVISION_CONFLICT', `workflow ${id} expected draft revision ${expected}, actual ${actual}`)
}
