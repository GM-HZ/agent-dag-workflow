import { registerCoreNodes, WorkflowNodeRegistry, type WorkflowTemplate } from '@gm-hz/dsh-dag-workflow-core'
import { describe, expect, it } from 'vitest'
import {
  diffWorkflowTemplates,
  InMemoryWorkflowCatalogRepository,
  WorkflowCatalogError,
  WorkflowTemplateCatalog,
} from '../src/index.js'

function template(overrides: { name?: string; layoutX?: number; endUses?: string } = {}): WorkflowTemplate {
  return {
    apiVersion: 'dsh.workflow/v1alpha1',
    kind: 'WorkflowTemplate',
    metadata: { id: 'catalog-test', name: overrides.name ?? 'Catalog test' },
    spec: {
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object', additionalProperties: false },
      nodes: [
        { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
        { id: 'end', uses: overrides.endUses ?? 'core.end@1', with: {}, inputs: {} },
      ],
      edges: [{ id: 'start-end', source: 'start', target: 'end' }],
      outputs: {},
    },
    layout: { nodes: { start: { x: overrides.layoutX ?? 0, y: 0 } } },
  }
}

function dependencyTemplate(id: string, dependency?: { readonly id: string; readonly revision: number }, maxDepth?: number): WorkflowTemplate {
  const middle = dependency === undefined
    ? []
    : [{
        id: 'child',
        uses: 'core.subworkflow@1',
        with: { templateId: dependency.id, revision: dependency.revision },
        inputs: {},
      }]
  return {
    apiVersion: 'dsh.workflow/v1alpha1',
    kind: 'WorkflowTemplate',
    metadata: { id, name: id },
    spec: {
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object', additionalProperties: false },
      nodes: [
        { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
        ...middle,
        { id: 'end', uses: 'core.end@1', with: {}, inputs: {} },
      ],
      edges: dependency === undefined
        ? [{ id: 'start-end', source: 'start', target: 'end' }]
        : [
            { id: 'start-child', source: 'start', target: 'child' },
            { id: 'child-end', source: 'child', target: 'end' },
          ],
      outputs: {},
      ...(maxDepth === undefined ? {} : { policies: { subworkflowMaxDepth: maxDepth } }),
    },
  }
}

function setup() {
  const nodes = new WorkflowNodeRegistry()
  registerCoreNodes(nodes)
  const repository = new InMemoryWorkflowCatalogRepository()
  let now = 100
  const catalog = new WorkflowTemplateCatalog(repository, nodes, { now: () => ++now })
  return { catalog, repository }
}

describe('workflow template catalog', () => {
  it('uses CAS for drafts and preserves immutable published revisions', () => {
    const { catalog } = setup()
    const created = catalog.createDraft(template())
    expect(created).toMatchObject({ revision: 1, createdAt: 101, updatedAt: 101 })

    const updated = catalog.updateDraft(created.id, 1, template({ layoutX: 80 }))
    expect(updated.revision).toBe(2)
    expect(updated.semanticHash).toBe(created.semanticHash)
    expect(updated.contentHash).not.toBe(created.contentHash)
    expect(() => catalog.updateDraft(created.id, 1, template())).toThrow(expect.objectContaining({ code: 'CATALOG_REVISION_CONFLICT' }))

    const first = catalog.publish(created.id, 2)
    expect(first).toMatchObject({ revision: 1, sourceDraftRevision: 2 })
    const thirdDraft = catalog.updateDraft(created.id, 2, template({ name: 'Renamed' }))
    const second = catalog.publish(created.id, thirdDraft.revision)

    expect(second).toMatchObject({ revision: 2, sourceDraftRevision: 3 })
    expect(catalog.getPublished(created.id, 1)).toBe(first)
    expect(catalog.getPublished(created.id, 1).template.metadata.name).toBe('Catalog test')
    expect(catalog.getPublished(created.id).template.metadata.name).toBe('Renamed')
    expect(catalog.list()).toEqual([expect.objectContaining({ id: 'catalog-test', draftRevision: 3, publishedRevision: 2 })])
  })

  it('allows invalid drafts but refuses to publish them with diagnostics', () => {
    const { catalog } = setup()
    const draft = catalog.createDraft(template({ endUses: 'plugin.missing@1' }))

    expect(catalog.validate(draft.template)).toContainEqual(expect.objectContaining({ code: 'UNKNOWN_NODE_TYPE', nodeId: 'end' }))
    expect(() => catalog.publish(draft.id, draft.revision)).toThrow(expect.objectContaining({
      code: 'CATALOG_PUBLISH_INVALID',
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'UNKNOWN_NODE_TYPE' })]),
    }))
  })

  it('reports layout-only changes separately from semantic changes', () => {
    const layoutOnly = diffWorkflowTemplates(template(), template({ layoutX: 200 }))
    expect(layoutOnly).toMatchObject({ contentChanged: true, semanticChanged: false, layoutChanged: true })
    expect(layoutOnly.nodes).toEqual({ added: [], removed: [], changed: [] })

    const semantic = diffWorkflowTemplates(template(), template({ name: 'Different' }))
    expect(semantic).toMatchObject({ contentChanged: true, semanticChanged: true, layoutChanged: false })
  })

  it('rejects id drift and duplicate drafts with stable errors', () => {
    const { catalog } = setup()
    catalog.createDraft(template())
    expect(() => catalog.createDraft(template())).toThrow(expect.objectContaining({ code: 'CATALOG_ALREADY_EXISTS' }))
    const renamedId = { ...template(), metadata: { id: 'other-id', name: 'Other' } }
    expect(() => catalog.updateDraft('catalog-test', 1, renamedId)).toThrow(expect.objectContaining({ code: 'CATALOG_ID_MISMATCH' }))
    expect(() => catalog.readDraft('missing')).toThrow(WorkflowCatalogError)
  })

  it('validates fixed published dependencies, cycles, and maximum depth before publish', () => {
    const { catalog } = setup()
    const missing = catalog.createDraft(dependencyTemplate('missing-parent', { id: 'not-published', revision: 1 }))
    expect(catalog.validate(missing.template)).toContainEqual(expect.objectContaining({
      code: 'SUBWORKFLOW_REVISION_NOT_FOUND',
      nodeId: 'child',
    }))
    expect(() => catalog.publish(missing.id, missing.revision)).toThrow(expect.objectContaining({ code: 'CATALOG_PUBLISH_INVALID' }))

    const self = catalog.createDraft(dependencyTemplate('self-cycle', { id: 'self-cycle', revision: 1 }))
    expect(catalog.validate(self.template)).toContainEqual(expect.objectContaining({ code: 'SUBWORKFLOW_DEPENDENCY_CYCLE' }))

    const leaf = catalog.createDraft(dependencyTemplate('leaf'))
    catalog.publish(leaf.id, leaf.revision)
    const middle = catalog.createDraft(dependencyTemplate('middle', { id: 'leaf', revision: 1 }))
    catalog.publish(middle.id, middle.revision)
    const root = catalog.createDraft(dependencyTemplate('root', { id: 'middle', revision: 1 }, 1))

    expect(catalog.validate(root.template)).toContainEqual(expect.objectContaining({
      code: 'SUBWORKFLOW_DEPTH_EXCEEDED',
      message: expect.stringContaining('depth 2'),
    }))
  })
})
