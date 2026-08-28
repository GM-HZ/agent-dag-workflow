import type { MaterializedWorkflowTemplate } from '../core/index.js'
import { WorkflowCatalogError, type PublishedWorkflowRevision, type WorkflowCatalogSummary, type WorkflowDraft } from './types.js'

export interface WorkflowCatalogRepository {
  createDraft(materialized: MaterializedWorkflowTemplate, now: number): Promise<WorkflowDraft>
  readDraft(id: string): Promise<WorkflowDraft | undefined>
  updateDraft(id: string, expectedRevision: number, materialized: MaterializedWorkflowTemplate, now: number): Promise<WorkflowDraft>
  publishDraft(id: string, expectedDraftRevision: number, now: number): Promise<PublishedWorkflowRevision>
  readPublished(id: string, revision?: number): Promise<PublishedWorkflowRevision | undefined>
  list(): Promise<readonly WorkflowCatalogSummary[]>
}

export class InMemoryWorkflowCatalogRepository implements WorkflowCatalogRepository {
  private readonly drafts = new Map<string, WorkflowDraft>()
  private readonly published = new Map<string, PublishedWorkflowRevision[]>()

  async createDraft(materialized: MaterializedWorkflowTemplate, now: number): Promise<WorkflowDraft> {
    const id = materialized.template.metadata.id
    if (this.drafts.has(id)) throw new WorkflowCatalogError('CATALOG_ALREADY_EXISTS', `workflow draft already exists: ${id}`)
    const draft = freezeDraft({
      id,
      revision: 1,
      template: materialized.template,
      contentHash: materialized.contentHash,
      semanticHash: materialized.semanticHash,
      createdAt: now,
      updatedAt: now,
    })
    this.drafts.set(id, draft)
    return draft
  }

  async readDraft(id: string): Promise<WorkflowDraft | undefined> {
    return this.drafts.get(id)
  }

  async updateDraft(id: string, expectedRevision: number, materialized: MaterializedWorkflowTemplate, now: number): Promise<WorkflowDraft> {
    const current = this.requireDraft(id)
    if (current.revision !== expectedRevision) throw revisionConflict(id, expectedRevision, current.revision)
    const next = freezeDraft({
      ...current,
      revision: current.revision + 1,
      template: materialized.template,
      contentHash: materialized.contentHash,
      semanticHash: materialized.semanticHash,
      updatedAt: now,
    })
    this.drafts.set(id, next)
    return next
  }

  async publishDraft(id: string, expectedDraftRevision: number, now: number): Promise<PublishedWorkflowRevision> {
    const draft = this.requireDraft(id)
    if (draft.revision !== expectedDraftRevision) throw revisionConflict(id, expectedDraftRevision, draft.revision)
    const revisions = this.published.get(id) ?? []
    const published = Object.freeze({
      id,
      revision: revisions.length + 1,
      sourceDraftRevision: draft.revision,
      template: draft.template,
      contentHash: draft.contentHash,
      semanticHash: draft.semanticHash,
      publishedAt: now,
    })
    revisions.push(published)
    this.published.set(id, revisions)
    return published
  }

  async readPublished(id: string, revision?: number): Promise<PublishedWorkflowRevision | undefined> {
    const revisions = this.published.get(id)
    if (revision === undefined) return revisions?.at(-1)
    if (!Number.isSafeInteger(revision) || revision < 1) return undefined
    return revisions?.[revision - 1]
  }

  async list(): Promise<readonly WorkflowCatalogSummary[]> {
    return [...this.drafts.values()]
      .map(draft => {
        const latest = this.published.get(draft.id)?.at(-1)
        return Object.freeze({
          id: draft.id,
          name: draft.template.metadata.name,
          draftRevision: draft.revision,
          ...(latest === undefined ? {} : { publishedRevision: latest.revision }),
          updatedAt: draft.updatedAt,
        })
      })
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  private requireDraft(id: string): WorkflowDraft {
    const draft = this.drafts.get(id)
    if (draft === undefined) throw new WorkflowCatalogError('CATALOG_NOT_FOUND', `workflow draft not found: ${id}`)
    return draft
  }
}

function freezeDraft(draft: WorkflowDraft): WorkflowDraft {
  return Object.freeze(draft)
}

function revisionConflict(id: string, expected: number, actual: number): WorkflowCatalogError {
  return new WorkflowCatalogError('CATALOG_REVISION_CONFLICT', `workflow ${id} expected draft revision ${expected}, actual ${actual}`)
}
