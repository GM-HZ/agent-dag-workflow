import {
  compileWorkflow,
  materializeWorkflowTemplate,
  stableJsonStringify,
  type JsonValue,
  type WorkflowDiagnostic,
  type WorkflowNodeRegistry,
  type WorkflowTemplate,
} from '../core/index.js'
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
    const diagnostics = [...compileWorkflow(template, this.nodes).diagnostics]
    if (!diagnostics.some(item => item.code === 'TEMPLATE_NOT_LOSSLESS_JSON')) {
      diagnostics.push(...this.validatePublishedDependencies(template))
    }
    return diagnostics
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

  private validatePublishedDependencies(root: WorkflowTemplate): WorkflowDiagnostic[] {
    const diagnostics: WorkflowDiagnostic[] = []
    const latest = this.repository.readPublished(root.metadata.id)
    const rootKey = dependencyKey(root.metadata.id, (latest?.revision ?? 0) + 1)
    const visit = (template: WorkflowTemplate, depth: number, inheritedLimit: number, stack: ReadonlySet<string>): void => {
      const localLimit = Math.min(inheritedLimit, template.spec.policies?.subworkflowMaxDepth ?? 8)
      for (const dependency of dependenciesOf(template)) {
        const nextDepth = depth + 1
        if (nextDepth > localLimit) {
          diagnostics.push(dependencyDiagnostic(
            'SUBWORKFLOW_DEPTH_EXCEEDED',
            `dependency ${dependency.id}@${dependency.revision} reaches depth ${nextDepth}, limit is ${localLimit}`,
            dependency.nodeId,
          ))
          continue
        }
        const key = dependencyKey(dependency.id, dependency.revision)
        if (stack.has(key)) {
          diagnostics.push(dependencyDiagnostic('SUBWORKFLOW_DEPENDENCY_CYCLE', `published dependency cycle reaches ${key}`, dependency.nodeId))
          continue
        }
        const published = this.repository.readPublished(dependency.id, dependency.revision)
        if (published === undefined) {
          diagnostics.push(dependencyDiagnostic('SUBWORKFLOW_REVISION_NOT_FOUND', `published workflow revision not found: ${key}`, dependency.nodeId))
          continue
        }
        visit(published.template, nextDepth, localLimit, new Set([...stack, key]))
      }
    }
    visit(root, 0, root.spec.policies?.subworkflowMaxDepth ?? 8, new Set([rootKey]))
    return diagnostics
  }
}

function dependenciesOf(template: WorkflowTemplate): { readonly nodeId: string; readonly id: string; readonly revision: number }[] {
  const result: { readonly nodeId: string; readonly id: string; readonly revision: number }[] = []
  for (const node of template.spec.nodes) {
    if (node.uses !== 'core.subworkflow@1' && node.uses !== 'core.foreach@1') continue
    const id = node.with.templateId
    const revision = node.with.revision
    if (typeof id === 'string' && typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 1) {
      result.push({ nodeId: node.id, id, revision })
    }
  }
  return result
}

function dependencyKey(id: string, revision: number): string {
  return `${id}@${revision}`
}

function dependencyDiagnostic(code: string, message: string, nodeId: string): WorkflowDiagnostic {
  return { code, severity: 'error', message, nodeId }
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
