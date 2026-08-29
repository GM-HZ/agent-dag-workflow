import type { WorkflowDiagnostic, WorkflowTemplate } from '../core/index.js'

export interface WorkflowDraft {
  readonly id: string
  readonly revision: number
  readonly template: WorkflowTemplate
  readonly contentHash: string
  readonly semanticHash: string
  readonly createdAt: number
  readonly updatedAt: number
}

export interface PublishedWorkflowRevision {
  readonly id: string
  readonly revision: number
  readonly sourceDraftRevision: number
  readonly template: WorkflowTemplate
  readonly contentHash: string
  readonly semanticHash: string
  readonly publishedAt: number
}

export interface WorkflowCatalogSummary {
  readonly id: string
  readonly name: string
  readonly draftRevision: number
  readonly publishedRevision?: number
  readonly updatedAt: number
}

export interface WorkflowCatalogSearchRequest {
  readonly query?: string
  readonly limit?: number
  /** Return entries whose id sorts after this cursor. */
  readonly after?: string
}

export interface WorkflowCatalogSearchItem {
  readonly id: string
  readonly revision: number
  readonly ref: string
  readonly name: string
  readonly description?: string
  readonly semanticHash: string
  readonly publishedAt: number
}

export interface WorkflowCatalogSearchResult {
  readonly items: readonly WorkflowCatalogSearchItem[]
  readonly nextAfter?: string
}

export interface WorkflowTemplateDiff {
  readonly contentChanged: boolean
  readonly semanticChanged: boolean
  readonly layoutChanged: boolean
  readonly nodes: {
    readonly added: readonly string[]
    readonly removed: readonly string[]
    readonly changed: readonly string[]
  }
  readonly edges: {
    readonly added: readonly string[]
    readonly removed: readonly string[]
    readonly changed: readonly string[]
  }
}

export type WorkflowCatalogErrorCode =
  | 'CATALOG_ALREADY_EXISTS'
  | 'CATALOG_NOT_FOUND'
  | 'CATALOG_REVISION_CONFLICT'
  | 'CATALOG_ID_MISMATCH'
  | 'CATALOG_INVALID_ENVELOPE'
  | 'CATALOG_PUBLISH_INVALID'

export class WorkflowCatalogError extends Error {
  readonly code: WorkflowCatalogErrorCode
  readonly diagnostics?: readonly WorkflowDiagnostic[]

  constructor(code: WorkflowCatalogErrorCode, message: string, diagnostics?: readonly WorkflowDiagnostic[]) {
    super(message)
    this.name = 'WorkflowCatalogError'
    this.code = code
    if (diagnostics !== undefined) this.diagnostics = diagnostics
  }
}
