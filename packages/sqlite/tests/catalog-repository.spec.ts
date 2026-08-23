import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { registerCoreNodes, WorkflowNodeRegistry, type WorkflowTemplate } from '@gm-hz/dsh-workflow-core'
import { WorkflowTemplateCatalog } from '@gm-hz/dsh-workflow-catalog'
import { WorkflowNodeRegistryService } from '@gm-hz/dsh-workflow-dsh'
import { afterEach, describe, expect, it } from 'vitest'
import { SqliteWorkflowCatalogRepository, SqliteWorkflowTemplatesProvider } from '../src/index.js'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function dbPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-workflow-sqlite-'))
  temporaryRoots.push(root)
  return join(root, 'workflows.db')
}

function template(name = 'SQLite workflow'): WorkflowTemplate {
  return {
    apiVersion: 'dsh.workflow/v1alpha1',
    kind: 'WorkflowTemplate',
    metadata: { id: 'sqlite-test', name },
    spec: {
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object', additionalProperties: false },
      nodes: [
        { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
        { id: 'end', uses: 'core.end@1', with: {}, inputs: {} },
      ],
      edges: [{ id: 'start-end', source: 'start', target: 'end' }],
      outputs: {},
    },
  }
}

function catalog(repository: SqliteWorkflowCatalogRepository): WorkflowTemplateCatalog {
  const nodes = new WorkflowNodeRegistry()
  registerCoreNodes(nodes)
  return new WorkflowTemplateCatalog(repository, nodes, { now: () => 1234 })
}

describe('SQLite workflow catalog repository', () => {
  it('supports the complete catalog contract in memory', () => {
    const repository = new SqliteWorkflowCatalogRepository({ path: ':memory:' })
    const service = catalog(repository)
    const draft = service.createDraft(template())
    const updated = service.updateDraft(draft.id, draft.revision, template('Updated'))
    const published = service.publish(updated.id, updated.revision)

    expect(published).toMatchObject({ revision: 1, sourceDraftRevision: 2, publishedAt: 1234 })
    expect(service.getPublished('sqlite-test').template.metadata.name).toBe('Updated')
    expect(service.list()).toEqual([expect.objectContaining({ id: 'sqlite-test', draftRevision: 2, publishedRevision: 1 })])
    repository.close()
  })

  it('persists immutable drafts and published revisions across reopen', () => {
    const path = dbPath()
    const first = new SqliteWorkflowCatalogRepository({ path })
    const service = catalog(first)
    const draft = service.createDraft(template())
    service.publish(draft.id, draft.revision)
    first.close()

    const reopened = new SqliteWorkflowCatalogRepository({ path })
    expect(reopened.readDraft('sqlite-test')).toMatchObject({ revision: 1, contentHash: expect.any(String) })
    expect(reopened.readPublished('sqlite-test', 1)?.template).toEqual(template())
    reopened.close()
  })

  it('enforces CAS across independent SQLite connections', () => {
    const path = dbPath()
    const first = new SqliteWorkflowCatalogRepository({ path })
    const second = new SqliteWorkflowCatalogRepository({ path })
    const firstCatalog = catalog(first)
    const secondCatalog = catalog(second)
    const created = firstCatalog.createDraft(template())
    secondCatalog.updateDraft(created.id, created.revision, template('Other writer'))

    expect(() => firstCatalog.updateDraft(created.id, created.revision, template('Stale writer')))
      .toThrow(expect.objectContaining({ code: 'CATALOG_REVISION_CONFLICT' }))
    expect(firstCatalog.readDraft(created.id).template.metadata.name).toBe('Other writer')
    first.close()
    second.close()
  })

  it('rejects foreign, unversioned and schema-tampered databases', () => {
    const foreignPath = dbPath()
    const foreign = new DatabaseSync(foreignPath)
    foreign.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY) STRICT;')
    foreign.close()
    expect(() => new SqliteWorkflowCatalogRepository({ path: foreignPath })).toThrow(/version\/application|schema objects/)

    const tamperedPath = dbPath()
    const initialized = new SqliteWorkflowCatalogRepository({ path: tamperedPath })
    initialized.close()
    const tampered = new DatabaseSync(tamperedPath)
    tampered.exec('DROP TABLE workflow_revisions;')
    tampered.close()
    expect(() => new SqliteWorkflowCatalogRepository({ path: tamperedPath })).toThrow(/schema objects/)
  })

  it('publishes the SQLite catalog as ctx.workflowTemplates and closes on dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(WorkflowNodeRegistryService)
    const provider = await ctx.plugin(SqliteWorkflowTemplatesProvider, { path: ':memory:' })

    const draft = ctx.workflowTemplates.createDraft(template())
    expect(ctx.workflowTemplates.publish(draft.id, draft.revision).revision).toBe(1)
    await provider.dispose()
    expect(ctx.get('workflowTemplates')).toBeUndefined()
  })
})
