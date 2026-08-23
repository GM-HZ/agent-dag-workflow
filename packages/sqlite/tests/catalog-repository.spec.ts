import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import {
  DagWorkflowEngine,
  registerCoreNodes,
  WorkflowNodeRegistry,
  type JsonValue,
  type WorkflowEvent,
  type WorkflowRunCheckpoint,
  type WorkflowRunRecord,
  type WorkflowRunStore,
  type WorkflowTemplate,
  type WorkflowToolRequest,
} from '@gm-hz/dsh-workflow-core'
import { WorkflowTemplateCatalog } from '@gm-hz/dsh-workflow-catalog'
import { WorkflowNodeRegistryService } from '@gm-hz/dsh-workflow-dsh'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SqliteWorkflowCatalogRepository,
  SqliteWorkflowRunsProvider,
  SqliteWorkflowRunStore,
  SqliteWorkflowTemplatesProvider,
} from '../src/index.js'

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

function toolTemplate(): WorkflowTemplate {
  const base = template('SQLite run')
  return {
    ...base,
    spec: {
      ...base.spec,
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['message'], properties: { message: { type: 'string' } },
      },
      outputSchema: {
        type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string' } },
      },
      nodes: [
        { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
        { id: 'call', uses: 'dsh.tool@1', with: { name: 'echo' }, inputs: { message: { input: 'message' } } },
        { id: 'end', uses: 'core.end@1', with: {}, inputs: { answer: { output: { node: 'call', path: ['result', 'echo'] } } } },
      ],
      edges: [
        { id: 'start-call', source: 'start', target: 'call' },
        { id: 'call-end', source: 'call', target: 'end' },
      ],
      outputs: { answer: { output: { node: 'end', path: ['answer'] } } },
    },
  }
}

class OneShotFailingRunStore implements WorkflowRunStore {
  private armed = true

  constructor(
    private readonly store: SqliteWorkflowRunStore,
    private readonly shouldFail: (events: readonly WorkflowEvent[]) => boolean,
  ) {}

  createRun(record: WorkflowRunRecord): void { this.store.createRun(record) }
  commit(runId: string, expectedSeq: number, checkpoint: WorkflowRunCheckpoint, events: readonly WorkflowEvent[]): void {
    if (this.armed && this.shouldFail(events)) {
      this.armed = false
      throw new Error('simulated crash before SQLite checkpoint commit')
    }
    this.store.commit(runId, expectedSeq, checkpoint, events)
  }
  loadRun(runId: string): WorkflowRunRecord | undefined { return this.store.loadRun(runId) }
  listRecoverableRuns(): readonly WorkflowRunRecord[] { return this.store.listRecoverableRuns() }
}

function workflowRegistry(): WorkflowNodeRegistry {
  const nodes = new WorkflowNodeRegistry()
  registerCoreNodes(nodes)
  return nodes
}

function toolGateway(onCall?: () => void) {
  return {
    async execute(request: WorkflowToolRequest): Promise<JsonValue> {
      onCall?.()
      return { echo: request.input.message ?? null }
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

  it('persists terminal run events and checkpoints across process reopen', async () => {
    const path = dbPath()
    const firstStore = new SqliteWorkflowRunStore({ path })
    const engine = new DagWorkflowEngine(workflowRegistry(), { tools: toolGateway() }, { runStore: firstStore })
    const run = engine.start({ template: toolTemplate(), inputs: { message: 'sqlite-run' } })
    expect((await run.result).status).toBe('completed')
    expect(firstStore.loadRun(run.id)?.checkpoint).toMatchObject({ status: 'completed', resultOutputs: { answer: 'sqlite-run' } })
    firstStore.close()

    const reopened = new SqliteWorkflowRunStore({ path })
    const replay = await new DagWorkflowEngine(workflowRegistry(), { tools: toolGateway() }, { runStore: reopened }).resume({ runId: run.id }).result
    expect(replay).toMatchObject({ status: 'completed', outputs: { answer: 'sqlite-run' } })
    expect(reopened.loadRun(run.id)?.events.at(-1)).toMatchObject({ type: 'checkpoint.committed' })
    reopened.close()
  })

  it('persists needs_attention across reopen before an explicit side-effect retry', async () => {
    const path = dbPath()
    const underlying = new SqliteWorkflowRunStore({ path })
    const failing = new OneShotFailingRunStore(underlying, events => events.some(event => event.type === 'node.completed' && event.nodeId === 'call'))
    let calls = 0
    const first = new DagWorkflowEngine(workflowRegistry(), { tools: toolGateway(() => { calls++ }) }, { runStore: failing })
      .start({ template: toolTemplate(), inputs: { message: 'unknown' } })
    expect((await first.result).status).toBe('failed')
    expect(calls).toBe(1)
    underlying.close()

    const recoveryStore = new SqliteWorkflowRunStore({ path })
    const recovery = new DagWorkflowEngine(workflowRegistry(), { tools: toolGateway(() => { calls++ }) }, { runStore: recoveryStore })
    expect(await recovery.resume({ runId: first.id }).result).toMatchObject({ status: 'paused', needsAttention: ['call'] })
    recoveryStore.close()

    const finalStore = new SqliteWorkflowRunStore({ path })
    const finalEngine = new DagWorkflowEngine(workflowRegistry(), { tools: toolGateway(() => { calls++ }) }, { runStore: finalStore })
    const result = await finalEngine.resume({ runId: first.id, unknownNodeResolutions: { call: 'retry' } }).result
    expect(result.status).toBe('completed')
    expect(calls).toBe(2)
    finalStore.close()
  })

  it('migrates the catalog-only v1 schema to run-store v2', () => {
    const path = dbPath()
    const initialized = new SqliteWorkflowCatalogRepository({ path })
    initialized.close()
    const old = new DatabaseSync(path)
    old.exec('DROP TABLE workflow_run_events; DROP TABLE workflow_runs; PRAGMA user_version = 1;')
    old.close()

    const migrated = new SqliteWorkflowRunStore({ path })
    expect(migrated.listRecoverableRuns()).toEqual([])
    migrated.close()
  })

  it('publishes the SQLite run store as ctx.workflowRuns', async () => {
    const ctx = new Context()
    const provider = await ctx.plugin(SqliteWorkflowRunsProvider, { path: ':memory:' })
    expect(ctx.workflowRuns.listRecoverableRuns()).toEqual([])
    await provider.dispose()
    expect(ctx.get('workflowRuns')).toBeUndefined()
  })
})
