import { endNodeDefinition, registerCoreNodes, startNodeDefinition, WorkflowNodeRegistry, type WorkflowTemplate } from '../../src/core/index.js'
import { describe, expect, it } from 'vitest'
import {
  diffWorkflowTemplates,
  InMemoryWorkflowCatalogRepository,
  WorkflowCatalogError,
  WorkflowTemplateCatalog,
} from '../../src/catalog/index.js'

function template(overrides: { name?: string; layoutX?: number; endUses?: string } = {}): WorkflowTemplate {
  return {
    apiVersion: 'workflow.gm-hz.dev/v1alpha1',
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
        uses: 'workflow.call@1',
        with: { templateId: dependency.id, revision: dependency.revision },
        inputs: {},
      }]
  return {
    apiVersion: 'workflow.gm-hz.dev/v1alpha1',
    kind: 'WorkflowTemplate',
    metadata: { id, name: id },
    spec: {
      ...(dependency === undefined ? {} : {
        requires: [
          { kind: 'capability' as const, uses: 'gateway.workflow.call' },
          { kind: 'workflow' as const, uses: `${dependency.id}@${dependency.revision}` },
        ],
      }),
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
  it('uses CAS for drafts and preserves immutable published revisions', async () => {
    const { catalog } = setup()
    const created = await catalog.createDraft(template())
    expect(created).toMatchObject({ revision: 1, createdAt: 101, updatedAt: 101 })

    const updated = await catalog.updateDraft(created.id, 1, template({ layoutX: 80 }))
    expect(updated.revision).toBe(2)
    expect(updated.semanticHash).toBe(created.semanticHash)
    expect(updated.contentHash).not.toBe(created.contentHash)
    await expect(catalog.updateDraft(created.id, 1, template())).rejects.toEqual(expect.objectContaining({ code: 'CATALOG_REVISION_CONFLICT' }))

    const first = await catalog.publish(created.id, 2)
    expect(first).toMatchObject({ revision: 1, sourceDraftRevision: 2 })
    const thirdDraft = await catalog.updateDraft(created.id, 2, template({ name: 'Renamed' }))
    const second = await catalog.publish(created.id, thirdDraft.revision)

    expect(second).toMatchObject({ revision: 2, sourceDraftRevision: 3 })
    expect(await catalog.getPublished(created.id, 1)).toBe(first)
    expect((await catalog.getPublished(created.id, 1)).template.metadata.name).toBe('Catalog test')
    expect((await catalog.getPublished(created.id)).template.metadata.name).toBe('Renamed')
    expect(await catalog.list()).toEqual([expect.objectContaining({ id: 'catalog-test', draftRevision: 3, publishedRevision: 2 })])
  })

  it('allows invalid drafts but refuses to publish them with diagnostics', async () => {
    const { catalog } = setup()
    const draft = await catalog.createDraft(template({ endUses: 'plugin.missing@1' }))

    expect(await catalog.validate(draft.template)).toContainEqual(expect.objectContaining({ code: 'UNKNOWN_NODE_TYPE', nodeId: 'end' }))
    await expect(catalog.publish(draft.id, draft.revision)).rejects.toEqual(expect.objectContaining({
      code: 'CATALOG_PUBLISH_INVALID',
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'UNKNOWN_NODE_TYPE' })]),
    }))
  })

  it('allows digest-less definitions only for inline development and blocks publication', async () => {
    const nodes = new WorkflowNodeRegistry()
    const { implementationDigest: _start, ...start } = startNodeDefinition
    const { implementationDigest: _end, ...end } = endNodeDefinition
    nodes.register(start); nodes.register(end)
    const catalog = new WorkflowTemplateCatalog(new InMemoryWorkflowCatalogRepository(), nodes)
    const draft = await catalog.createDraft(template())
    expect(await catalog.validate(draft.template)).toContainEqual(expect.objectContaining({
      code: 'NODE_IMPLEMENTATION_DIGEST_MISSING', severity: 'warning',
    }))
    await expect(catalog.publish(draft.id, draft.revision)).rejects.toEqual(expect.objectContaining({
      code: 'CATALOG_PUBLISH_INVALID',
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'NODE_IMPLEMENTATION_DIGEST_MISSING', severity: 'error' })]),
    }))
  })

  it('reports layout-only changes separately from semantic changes', () => {
    const layoutOnly = diffWorkflowTemplates(template(), template({ layoutX: 200 }))
    expect(layoutOnly).toMatchObject({ contentChanged: true, semanticChanged: false, layoutChanged: true })
    expect(layoutOnly.nodes).toEqual({ added: [], removed: [], changed: [] })

    const semantic = diffWorkflowTemplates(template(), template({ name: 'Different' }))
    expect(semantic).toMatchObject({ contentChanged: true, semanticChanged: true, layoutChanged: false })
  })

  it('rejects id drift and duplicate drafts with stable errors', async () => {
    const { catalog } = setup()
    await catalog.createDraft(template())
    await expect(catalog.createDraft(template())).rejects.toEqual(expect.objectContaining({ code: 'CATALOG_ALREADY_EXISTS' }))
    const renamedId = { ...template(), metadata: { id: 'other-id', name: 'Other' } }
    await expect(catalog.updateDraft('catalog-test', 1, renamedId)).rejects.toEqual(expect.objectContaining({ code: 'CATALOG_ID_MISMATCH' }))
    await expect(catalog.readDraft('missing')).rejects.toThrow(WorkflowCatalogError)
  })

  it('validates fixed published dependencies, cycles, and maximum depth before publish', async () => {
    const { catalog } = setup()
    const missing = await catalog.createDraft(dependencyTemplate('missing-parent', { id: 'not-published', revision: 1 }))
    expect(await catalog.validate(missing.template)).toContainEqual(expect.objectContaining({
      code: 'SUBWORKFLOW_REVISION_NOT_FOUND',
      nodeId: 'child',
    }))
    await expect(catalog.publish(missing.id, missing.revision)).rejects.toEqual(expect.objectContaining({ code: 'CATALOG_PUBLISH_INVALID' }))

    const self = await catalog.createDraft(dependencyTemplate('self-cycle', { id: 'self-cycle', revision: 1 }))
    expect(await catalog.validate(self.template)).toContainEqual(expect.objectContaining({ code: 'SUBWORKFLOW_DEPENDENCY_CYCLE' }))

    const leaf = await catalog.createDraft(dependencyTemplate('leaf'))
    await catalog.publish(leaf.id, leaf.revision)
    const middle = await catalog.createDraft(dependencyTemplate('middle', { id: 'leaf', revision: 1 }))
    await catalog.publish(middle.id, middle.revision)
    const root = await catalog.createDraft(dependencyTemplate('root', { id: 'middle', revision: 1 }, 1))

    expect(await catalog.validate(root.template)).toContainEqual(expect.objectContaining({
      code: 'SUBWORKFLOW_DEPTH_EXCEEDED',
      message: expect.stringContaining('depth 2'),
    }))
  })
})
