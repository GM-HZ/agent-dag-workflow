import {
  compileWorkflow,
  materializeWorkflowTemplate,
  stableJsonStringify,
  type JsonValue,
  type WorkflowDiagnostic,
  type WorkflowNodeRegistry,
  type WorkflowTemplate,
} from '@gm-hz/dsh-workflow-core'
import type { WorkflowCatalogRepository } from './repository.js'
import {
  WorkflowCatalogError,
  type PublishedWorkflowRevision,
  type WorkflowCatalogSummary,
  type WorkflowDraft,
  type WorkflowTemplateDiff,
} from './types.js'

export interface WorkflowTemplateCatalogOptions {
  readonly now?: () => number
}

export class WorkflowTemplateCatalog {
  private readonly now: () => number

  constructor(
    private readonly repository: WorkflowCatalogRepository,
    private readonly nodes: WorkflowNodeRegistry,
    options: WorkflowTemplateCatalogOptions = {},
  ) {
    this.now = options.now ?? Date.now
  }

  createDraft(template: WorkflowTemplate): WorkflowDraft {
    const materialized = materializeWorkflowTemplate(template)
    assertDraftEnvelope(materialized.template)
    return this.repository.createDraft(materialized, this.now())
  }

  readDraft(id: string): WorkflowDraft {
    return this.repository.readDraft(id) ?? notFound(id)
  }

  updateDraft(id: string, expectedRevision: number, template: WorkflowTemplate): WorkflowDraft {
    const materialized = materializeWorkflowTemplate(template)
    assertDraftEnvelope(materialized.template)
    if (materialized.template.metadata.id !== id) {
      throw new WorkflowCatalogError('CATALOG_ID_MISMATCH', `template id ${materialized.template.metadata.id} does not match catalog id ${id}`)
    }
    return this.repository.updateDraft(id, expectedRevision, materialized, this.now())
  }

  validate(template: WorkflowTemplate): readonly WorkflowDiagnostic[] {
    return compileWorkflow(template, this.nodes).diagnostics
  }

  diff(id: string, candidate: WorkflowTemplate): WorkflowTemplateDiff {
    return diffWorkflowTemplates(this.readDraft(id).template, candidate)
  }

  publish(id: string, expectedDraftRevision: number): PublishedWorkflowRevision {
    const draft = this.readDraft(id)
    if (draft.revision !== expectedDraftRevision) {
      throw new WorkflowCatalogError('CATALOG_REVISION_CONFLICT', `workflow ${id} expected draft revision ${expectedDraftRevision}, actual ${draft.revision}`)
    }
    const diagnostics = this.validate(draft.template)
    if (diagnostics.some(diagnostic => diagnostic.severity === 'error')) {
      throw new WorkflowCatalogError('CATALOG_PUBLISH_INVALID', `workflow ${id} cannot be published`, diagnostics)
    }
    return this.repository.publishDraft(id, expectedDraftRevision, this.now())
  }

  getPublished(id: string, revision?: number): PublishedWorkflowRevision {
    return this.repository.readPublished(id, revision) ?? notFound(`${id}@${revision ?? 'latest'}`)
  }

  list(): readonly WorkflowCatalogSummary[] {
    return this.repository.list()
  }
}

export function diffWorkflowTemplates(base: WorkflowTemplate, candidate: WorkflowTemplate): WorkflowTemplateDiff {
  const left = materializeWorkflowTemplate(base)
  const right = materializeWorkflowTemplate(candidate)
  const nodeDiff = diffById(left.template.spec.nodes, right.template.spec.nodes)
  const edgeDiff = diffById(left.template.spec.edges, right.template.spec.edges)
  return Object.freeze({
    contentChanged: left.contentHash !== right.contentHash,
    semanticChanged: left.semanticHash !== right.semanticHash,
    layoutChanged: stableJsonStringify((left.template.layout ?? {}) as JsonValue) !== stableJsonStringify((right.template.layout ?? {}) as JsonValue),
    nodes: nodeDiff,
    edges: edgeDiff,
  })
}

function diffById<T extends { readonly id: string }>(left: readonly T[], right: readonly T[]): WorkflowTemplateDiff['nodes'] {
  const before = new Map(left.map(item => [item.id, item]))
  const after = new Map(right.map(item => [item.id, item]))
  const added = [...after.keys()].filter(id => !before.has(id)).sort()
  const removed = [...before.keys()].filter(id => !after.has(id)).sort()
  const changed = [...before.keys()].filter(id => {
    const candidate = after.get(id)
    return candidate !== undefined
      && stableJsonStringify(before.get(id) as unknown as JsonValue) !== stableJsonStringify(candidate as unknown as JsonValue)
  }).sort()
  return Object.freeze({ added, removed, changed })
}

function assertDraftEnvelope(template: WorkflowTemplate): void {
  if (template.apiVersion !== 'dsh.workflow/v1alpha1' || template.kind !== 'WorkflowTemplate'
    || typeof template.metadata?.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(template.metadata.id)
    || typeof template.metadata.name !== 'string' || template.metadata.name.length === 0) {
    throw new WorkflowCatalogError('CATALOG_INVALID_ENVELOPE', 'draft requires v1alpha1 envelope and valid metadata id/name')
  }
}

function notFound(id: string): never {
  throw new WorkflowCatalogError('CATALOG_NOT_FOUND', `workflow not found: ${id}`)
}
