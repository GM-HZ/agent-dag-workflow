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
  type WorkflowRunMetadata,
  type WorkflowRunStore,
  type WorkflowTemplate,
  type WorkflowToolRequest,
} from '../../src/core/index.js'
import { WorkflowTemplateCatalog } from '../../src/catalog/index.js'
import {
  WorkflowNodeRegistryService,
  WorkflowScriptRuntimeRegistryService,
} from '../../src/adapters/dsh/index.js'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SqliteWorkflowCatalogRepository,
  SqliteWorkflowRunStore,
  SqliteWorkflowRunCoordinator,
} from '../../src/storage/sqlite/index.js'
import { SqliteWorkflowRunsService, SqliteWorkflowTemplatesService } from '../../src/storage/sqlite/cordis.js'

const testExecution = { authorityRef: 'test:user', authority: { id: 'test-user' }, origin: { type: 'sdk' } } as const

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function dbPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-dag-workflow-sqlite-'))
  temporaryRoots.push(root)
  return join(root, 'workflows.db')
}

function template(name = 'SQLite workflow'): WorkflowTemplate {
  return {
    apiVersion: 'workflow.gm-hz.dev/v1alpha1',
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
      requires: [
        { kind: 'capability', uses: 'gateway.tool.execute' },
        { kind: 'tool', uses: 'echo' },
      ],
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['message'], properties: { message: { type: 'string' } },
      },
      outputSchema: {
        type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string' } },
      },
      nodes: [
        { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
        { id: 'call', uses: 'tool.call@1', with: { uses: 'echo' }, inputs: { message: { input: { path: ['message'] } } } },
        { id: 'end', uses: 'core.end@1', with: {}, inputs: { answer: { output: { nodeId: 'call', path: ['result', 'echo'] } } } },
      ],
      edges: [
        { id: 'start-call', source: 'start', target: 'call' },
        { id: 'call-end', source: 'call', target: 'end' },
      ],
      outputs: { answer: { output: { nodeId: 'end', path: ['answer'] } } },
    },
  }
}

class OneShotFailingRunStore implements WorkflowRunStore {
  private armed = true

  constructor(
    private readonly store: SqliteWorkflowRunStore,
    private readonly shouldFail: (events: readonly WorkflowEvent[]) => boolean,
  ) {}

  async createRun(record: WorkflowRunRecord): Promise<void> { await this.store.createRun(record) }
  async commit(runId: string, expectedSeq: number, checkpoint: WorkflowRunCheckpoint, events: readonly WorkflowEvent[]): Promise<void> {
    if (this.armed && this.shouldFail(events)) {
      this.armed = false
      throw new Error('simulated crash before SQLite checkpoint commit')
    }
    await this.store.commit(runId, expectedSeq, checkpoint, events)
  }
  async loadRun(runId: string): Promise<WorkflowRunRecord | undefined> { return this.store.loadRun(runId) }
  async getRunMetadata(runId: string): Promise<WorkflowRunMetadata | undefined> { return this.store.getRunMetadata(runId) }
  async getCheckpoint(runId: string): Promise<WorkflowRunCheckpoint | undefined> { return this.store.getCheckpoint(runId) }
  async readEvents(runId: string, query?: { readonly afterSeq?: number; readonly limit?: number }): Promise<readonly WorkflowEvent[]> { return this.store.readEvents(runId, query) }
  async listRecoverableRuns(): Promise<readonly WorkflowRunRecord[]> { return this.store.listRecoverableRuns() }
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
      return { echo: request.inputs.message ?? null }
    },
  }
}

function catalog(repository: SqliteWorkflowCatalogRepository): WorkflowTemplateCatalog {
  const nodes = new WorkflowNodeRegistry()
  registerCoreNodes(nodes)
  return new WorkflowTemplateCatalog(repository, nodes, { now: () => 1234 })
}

describe('SQLite workflow catalog repository', () => {
  it('supports the complete catalog contract in memory', async () => {
    const repository = new SqliteWorkflowCatalogRepository({ path: ':memory:' })
    const service = catalog(repository)
    const draft = await service.createDraft(template())
    const updated = await service.updateDraft(draft.id, draft.revision, template('Updated'))
    const published = await service.publish(updated.id, updated.revision)

    expect(published).toMatchObject({ revision: 1, sourceDraftRevision: 2, publishedAt: 1234 })
    expect((await service.getPublished('sqlite-test')).template.metadata.name).toBe('Updated')
    expect(await service.list()).toEqual([expect.objectContaining({ id: 'sqlite-test', draftRevision: 2, publishedRevision: 1 })])
    repository.close()
  })

  it('persists immutable drafts and published revisions across reopen', async () => {
    const path = dbPath()
    const first = new SqliteWorkflowCatalogRepository({ path })
    const service = catalog(first)
    const draft = await service.createDraft(template())
    await service.publish(draft.id, draft.revision)
    first.close()

    const reopened = new SqliteWorkflowCatalogRepository({ path })
    expect(await reopened.readDraft('sqlite-test')).toMatchObject({ revision: 1, contentHash: expect.any(String) })
    expect((await reopened.readPublished('sqlite-test', 1))?.template).toEqual(template())
    reopened.close()
  })

  it('enforces CAS across independent SQLite connections', async () => {
    const path = dbPath()
    const first = new SqliteWorkflowCatalogRepository({ path })
    const second = new SqliteWorkflowCatalogRepository({ path })
    const firstCatalog = catalog(first)
    const secondCatalog = catalog(second)
    const created = await firstCatalog.createDraft(template())
    await secondCatalog.updateDraft(created.id, created.revision, template('Other writer'))

    await expect(firstCatalog.updateDraft(created.id, created.revision, template('Stale writer')))
      .rejects.toEqual(expect.objectContaining({ code: 'CATALOG_REVISION_CONFLICT' }))
    expect((await firstCatalog.readDraft(created.id)).template.metadata.name).toBe('Other writer')
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
    await ctx.plugin(WorkflowScriptRuntimeRegistryService)
    await ctx.plugin(WorkflowNodeRegistryService)
    const service = await ctx.plugin(SqliteWorkflowTemplatesService, { path: ':memory:' })

    const draft = await ctx.workflowTemplates.createDraft(template())
    expect((await ctx.workflowTemplates.publish(draft.id, draft.revision)).revision).toBe(1)
    await service.dispose()
    expect(ctx.get('workflowTemplates')).toBeUndefined()
  })

  it('persists terminal run events and checkpoints across process reopen', async () => {
    const path = dbPath()
    const firstStore = new SqliteWorkflowRunStore({ path })
    const engine = new DagWorkflowEngine(workflowRegistry(), { tools: toolGateway() }, { runStore: firstStore })
    const run = await engine.start({
      template: toolTemplate(), inputs: { message: 'sqlite-run' },
      execution: { ...testExecution, authorityRef: 'session:sqlite-run' },
    })
    expect((await run.result).status).toBe('completed')
    expect((await firstStore.loadRun(run.id))?.checkpoint).toMatchObject({ status: 'completed', resultOutputs: { answer: 'sqlite-run' } })
    firstStore.close()

    const reopened = new SqliteWorkflowRunStore({ path })
    expect((await reopened.loadRun(run.id))?.execution.authorityRef).toBe('session:sqlite-run')
    const replay = await (await new DagWorkflowEngine(workflowRegistry(), { tools: toolGateway() }, { runStore: reopened }).resume({
      runId: run.id, execution: { ...testExecution, authorityRef: 'session:sqlite-run' },
    })).result
    expect(replay).toMatchObject({ status: 'completed', outputs: { answer: 'sqlite-run' } })
    expect((await reopened.loadRun(run.id))?.events.at(-1)).toMatchObject({ type: 'checkpoint.committed' })
    reopened.close()
  })

  it('persists needs_attention across reopen before an explicit side-effect retry', async () => {
    const path = dbPath()
    const underlying = new SqliteWorkflowRunStore({ path })
    const failing = new OneShotFailingRunStore(underlying, events => events.some(event => event.type === 'node.completed' && event.nodeId === 'call'))
    let calls = 0
    const first = await new DagWorkflowEngine(workflowRegistry(), { tools: toolGateway(() => { calls++ }) }, { runStore: failing })
      .start({ execution: testExecution, template: toolTemplate(), inputs: { message: 'unknown' } })
    expect((await first.result).status).toBe('failed')
    expect(calls).toBe(1)
    underlying.close()

    const recoveryStore = new SqliteWorkflowRunStore({ path })
    const recovery = new DagWorkflowEngine(workflowRegistry(), { tools: toolGateway(() => { calls++ }) }, { runStore: recoveryStore })
    expect(await (await recovery.resume({ execution: testExecution, runId: first.id })).result).toMatchObject({ status: 'paused', needsAttention: ['call'] })
    recoveryStore.close()

    const finalStore = new SqliteWorkflowRunStore({ path })
    const finalEngine = new DagWorkflowEngine(workflowRegistry(), { tools: toolGateway(() => { calls++ }) }, { runStore: finalStore })
    const result = await (await finalEngine.resume({ execution: testExecution, runId: first.id, unknownNodeResolutions: { call: 'retry' } })).result
    expect(result.status).toBe('completed')
    expect(calls).toBe(2)
    finalStore.close()
  })

  it('migrates the catalog-only v1 schema to the current run-store schema', async () => {
    const path = dbPath()
    const initialized = new SqliteWorkflowCatalogRepository({ path })
    initialized.close()
    const old = new DatabaseSync(path)
    old.exec('DROP TABLE workflow_run_queue; DROP TABLE workflow_run_events; DROP TABLE workflow_runs; DROP TABLE workflow_artifacts; DROP TABLE workflow_ingress; PRAGMA user_version = 1;')
    old.close()

    const migrated = new SqliteWorkflowRunStore({ path })
    expect(await migrated.listRecoverableRuns()).toEqual([])
    migrated.close()
  })

  it('migrates v2 run rows by adding durable execution context', async () => {
    const path = dbPath()
    const initialized = new SqliteWorkflowRunStore({ path })
    initialized.close()
    const old = new DatabaseSync(path)
    old.exec('ALTER TABLE workflow_runs DROP COLUMN execution_json; ALTER TABLE workflow_runs DROP COLUMN plan_json; ALTER TABLE workflow_runs DROP COLUMN launch_json; DROP TABLE workflow_artifacts; DROP TABLE workflow_ingress; DROP TABLE workflow_run_queue; PRAGMA user_version = 2;')
    old.close()

    const migrated = new SqliteWorkflowRunStore({ path })
    expect(await migrated.listRecoverableRuns()).toEqual([])
    migrated.close()
  })

  for (const fixture of [
    { version: 3, sql: 'ALTER TABLE workflow_runs DROP COLUMN execution_json; ALTER TABLE workflow_runs DROP COLUMN plan_json; ALTER TABLE workflow_runs DROP COLUMN launch_json; DROP TABLE workflow_artifacts; DROP TABLE workflow_ingress; DROP TABLE workflow_run_queue;' },
    { version: 4, sql: 'ALTER TABLE workflow_runs DROP COLUMN plan_json; ALTER TABLE workflow_runs DROP COLUMN launch_json; DROP TABLE workflow_artifacts; DROP TABLE workflow_ingress; DROP TABLE workflow_run_queue;' },
    { version: 5, sql: 'ALTER TABLE workflow_runs DROP COLUMN launch_json; DROP TABLE workflow_artifacts; DROP TABLE workflow_ingress; DROP TABLE workflow_run_queue;' },
    { version: 6, sql: 'ALTER TABLE workflow_runs DROP COLUMN launch_json; DROP TABLE workflow_ingress; DROP TABLE workflow_run_queue;' },
    { version: 7, sql: 'ALTER TABLE workflow_runs DROP COLUMN launch_json; DROP TABLE workflow_run_queue;' },
    { version: 8, sql: 'DROP TABLE workflow_run_queue;' },
  ]) {
    it(`migrates a real v${fixture.version} schema fixture and reopens idempotently`, async () => {
      const path = dbPath()
      const initialized = new SqliteWorkflowRunStore({ path })
      initialized.close()
      const old = new DatabaseSync(path)
      old.exec(`${fixture.sql} PRAGMA user_version = ${fixture.version};`)
      old.close()
      const migrated = new SqliteWorkflowRunStore({ path })
      expect(await migrated.listRecoverableRuns()).toEqual([])
      migrated.close()
      const reopened = new SqliteWorkflowRunStore({ path })
      expect(await reopened.listRecoverableRuns()).toEqual([])
      reopened.close()
    })
  }

  it('coordinates durable worker claims with lease expiry and fencing tokens', async () => {
    const path = dbPath()
    let now = 1_000
    const coordinator = new SqliteWorkflowRunCoordinator({ path, now: () => now })
    await coordinator.enqueue('run-1')
    const first = await coordinator.claim({ workerId: 'worker-a', leaseMs: 100 })
    expect(first).toMatchObject({ runId: 'run-1', workerId: 'worker-a', expiresAt: 1_100 })
    expect(await coordinator.claim({ workerId: 'worker-b', leaseMs: 100 })).toBeUndefined()
    expect(await coordinator.heartbeat({ runId: 'run-1', leaseToken: 'wrong', leaseMs: 100 })).toBe(false)
    now = 1_101
    const second = await coordinator.claim({ workerId: 'worker-b', leaseMs: 100 })
    expect(second?.runId).toBe('run-1')
    expect(second?.leaseToken).not.toBe(first?.leaseToken)
    expect(await coordinator.heartbeat({ runId: 'run-1', leaseToken: first!.leaseToken, leaseMs: 100 })).toBe(false)
    await coordinator.release({ runId: 'run-1', leaseToken: second!.leaseToken })
    expect(await coordinator.claim({ workerId: 'worker-c', leaseMs: 100 })).toBeUndefined()
    coordinator.close()
  })

  it('publishes the SQLite run store as ctx.workflowRuns', async () => {
    const ctx = new Context()
    const service = await ctx.plugin(SqliteWorkflowRunsService, { path: ':memory:' })
    expect(await ctx.workflowRuns.listRecoverableRuns()).toEqual([])
    await service.dispose()
    expect(ctx.get('workflowRuns')).toBeUndefined()
  })
})
