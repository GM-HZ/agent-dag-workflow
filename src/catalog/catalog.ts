import {
  compileWorkflow,
  materializeWorkflowTemplate,
  normalizeWorkflowDeploymentLimits,
  stableJsonStringify,
  WORKFLOW_TEMPLATE_API_VERSION,
  type JsonValue,
  type WorkflowDiagnostic,
  type WorkflowDeploymentLimits,
  type WorkflowNodeRegistry,
  type WorkflowTemplate,
} from '../core/index.js'
import { publishedWorkflowDependency, qualifyDependencyDiagnostic, type PublishedWorkflowDependency } from '../core/dependencies.js'
import type { WorkflowCatalogRepository } from './repository.js'
import {
  WorkflowCatalogError,
  type PublishedWorkflowRevision,
  type WorkflowCatalogSearchRequest,
  type WorkflowCatalogSearchResult,
  type WorkflowCatalogSummary,
  type WorkflowDraft,
  type WorkflowRevisionPage,
  type WorkflowTemplateDiff,
} from './types.js'

export interface WorkflowTemplateCatalogOptions {
  readonly now?: () => number
  readonly deploymentLimits?: Partial<WorkflowDeploymentLimits>
}

export class WorkflowTemplateCatalog {
  private readonly now: () => number
  private readonly deploymentLimits: WorkflowDeploymentLimits

  constructor(
    private readonly repository: WorkflowCatalogRepository,
    private readonly nodes: WorkflowNodeRegistry,
    options: WorkflowTemplateCatalogOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.deploymentLimits = normalizeWorkflowDeploymentLimits(options.deploymentLimits)
  }

  async createDraft(template: WorkflowTemplate): Promise<WorkflowDraft> {
    const materialized = materializeWorkflowTemplate(template)
    assertDraftEnvelope(materialized.template)
    return this.repository.createDraft(materialized, this.now())
  }

  async readDraft(id: string): Promise<WorkflowDraft> {
    return await this.repository.readDraft(id) ?? notFound(id)
  }

  async updateDraft(id: string, expectedRevision: number, template: WorkflowTemplate): Promise<WorkflowDraft> {
    const materialized = materializeWorkflowTemplate(template)
    assertDraftEnvelope(materialized.template)
    if (materialized.template.metadata.id !== id) {
      throw new WorkflowCatalogError('CATALOG_ID_MISMATCH', `template id ${materialized.template.metadata.id} does not match catalog id ${id}`)
    }
    return this.repository.updateDraft(id, expectedRevision, materialized, this.now())
  }

  async validate(template: WorkflowTemplate): Promise<readonly WorkflowDiagnostic[]> {
    const compilation = compileWorkflow(template, this.nodes, { deploymentLimits: this.deploymentLimits })
    if (compilation.workflow === undefined) return compilation.diagnostics
    const validated = compilation.workflow.template
    const diagnostics = [...compilation.diagnostics]
    if (!this.nodes.definitionSet(validated.spec.nodes.map(node => node.uses)).replayable) {
      diagnostics.push({
        code: 'NODE_IMPLEMENTATION_DIGEST_MISSING', severity: 'warning',
        message: 'one or more node definitions have no implementation digest; inline development runs are allowed but publishing is not',
      })
    }
    diagnostics.push(...await this.validatePublishedDependencies(validated))
    return diagnostics
  }

  async diff(id: string, candidate: WorkflowTemplate): Promise<WorkflowTemplateDiff> {
    return diffWorkflowTemplates((await this.readDraft(id)).template, candidate)
  }

  async publish(id: string, expectedDraftRevision: number): Promise<PublishedWorkflowRevision> {
    const draft = await this.readDraft(id)
    if (draft.revision !== expectedDraftRevision) {
      throw new WorkflowCatalogError('CATALOG_REVISION_CONFLICT', `workflow ${id} expected draft revision ${expectedDraftRevision}, actual ${draft.revision}`)
    }
    const diagnostics = [...await this.validate(draft.template)]
    if (!this.nodes.definitionSet(draft.template.spec.nodes.map(node => node.uses)).replayable) {
      diagnostics.push({
        code: 'NODE_IMPLEMENTATION_DIGEST_MISSING', severity: 'error',
        message: 'published workflows require an implementation digest for every node definition',
      })
    }
    if (diagnostics.some(diagnostic => diagnostic.severity === 'error')) {
      throw new WorkflowCatalogError('CATALOG_PUBLISH_INVALID', `workflow ${id} cannot be published`, diagnostics)
    }
    return this.repository.publishDraft(id, expectedDraftRevision, this.now())
  }

  async getPublished(id: string, revision?: number): Promise<PublishedWorkflowRevision> {
    return await this.repository.readPublished(id, revision) ?? notFound(`${id}@${revision ?? 'latest'}`)
  }

  async listRevisions(id: string, query: { readonly before?: number; readonly limit?: number } = {}): Promise<WorkflowRevisionPage> {
    const limit = query.limit ?? 25
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('revision history limit must be between 1 and 100')
    if (query.before !== undefined && (!Number.isSafeInteger(query.before) || query.before < 1)) throw new Error('revision cursor must be a positive safe integer')
    if (this.repository.listRevisions === undefined) throw new Error('the configured catalog does not support revision history')
    const rows = await this.repository.listRevisions(id, query.before, limit + 1)
    const items = rows.slice(0, limit)
    return { items, ...(rows.length > limit ? { nextBefore: items[items.length - 1]!.revision } : {}) }
  }

  async list(): Promise<readonly WorkflowCatalogSummary[]> {
    return this.repository.list()
  }

  async search(request: WorkflowCatalogSearchRequest = {}): Promise<WorkflowCatalogSearchResult> {
    const query = request.query?.trim().toLocaleLowerCase() ?? ''
    if (query.length > 256) throw new WorkflowCatalogError('CATALOG_INVALID_ENVELOPE', 'workflow search query must be at most 256 characters')
    const limit = Math.min(50, Math.max(1, request.limit ?? 10))
    const after = request.after ?? ''
    if (after.length > 256) throw new WorkflowCatalogError('CATALOG_INVALID_ENVELOPE', 'workflow search cursor must be at most 256 characters')
    return this.repository.searchPublished({ query, limit, after })
  }

  private async validatePublishedDependencies(root: WorkflowTemplate): Promise<WorkflowDiagnostic[]> {
    const diagnostics: WorkflowDiagnostic[] = []
    const latest = await this.repository.readPublished(root.metadata.id)
    const rootKey = dependencyKey(root.metadata.id, (latest?.revision ?? 0) + 1)
    const publishedByKey = new Map<string, Promise<PublishedWorkflowRevision | undefined>>()
    const visit = async (
      template: WorkflowTemplate, inheritedLimit: number, stack: ReadonlySet<string>, path: readonly PublishedWorkflowDependency[],
    ): Promise<void> => {
      const localLimit = Math.min(inheritedLimit, template.spec.policies?.subworkflowMaxDepth ?? 8)
      for (const node of template.spec.nodes) {
        const dependency = publishedWorkflowDependency(node)
        if (dependency === undefined) continue
        const nextPath = [...path, dependency]
        const nextDepth = nextPath.length
        if (nextDepth > localLimit) {
          diagnostics.push(dependencyDiagnostic(
            'SUBWORKFLOW_DEPTH_EXCEEDED',
            `dependency ${dependency.id}@${dependency.revision} reaches depth ${nextDepth}, limit is ${localLimit}`,
            nextPath,
          ))
          continue
        }
        const key = dependencyKey(dependency.id, dependency.revision)
        if (stack.has(key)) {
          diagnostics.push(dependencyDiagnostic('SUBWORKFLOW_DEPENDENCY_CYCLE', `published dependency cycle reaches ${key}`, nextPath))
          continue
        }
        let lookup = publishedByKey.get(key)
        if (lookup === undefined) {
          lookup = this.repository.readPublished(dependency.id, dependency.revision)
          publishedByKey.set(key, lookup)
        }
        const published = await lookup
        if (published === undefined) {
          diagnostics.push(dependencyDiagnostic('SUBWORKFLOW_REVISION_NOT_FOUND', `published workflow revision not found: ${key}`, nextPath))
          continue
        }
        await visit(published.template, localLimit, new Set([...stack, key]), nextPath)
      }
    }
    await visit(root, root.spec.policies?.subworkflowMaxDepth ?? 8, new Set([rootKey]), [])
    return diagnostics
  }
}

function dependencyKey(id: string, revision: number): string {
  return `${id}@${revision}`
}

function dependencyDiagnostic(code: string, message: string, path: readonly PublishedWorkflowDependency[]): WorkflowDiagnostic {
  return qualifyDependencyDiagnostic({ code, severity: 'error', message }, path)
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
  if (template.apiVersion !== WORKFLOW_TEMPLATE_API_VERSION || template.kind !== 'WorkflowTemplate'
    || typeof template.metadata?.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(template.metadata.id)
    || typeof template.metadata.name !== 'string' || template.metadata.name.length === 0) {
    throw new WorkflowCatalogError('CATALOG_INVALID_ENVELOPE', 'draft requires v1 envelope and valid metadata id/name')
  }
}

function notFound(id: string): never {
  throw new WorkflowCatalogError('CATALOG_NOT_FOUND', `workflow not found: ${id}`)
}
