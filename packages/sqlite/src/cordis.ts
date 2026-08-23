import type { Context } from '@deepseek-ai/cordis'
import { RepositoryWorkflowTemplatesProvider } from '@gm-hz/dsh-dag-workflow-host'
import { WorkflowRunsService } from '@gm-hz/dsh-dag-workflow-host'
import type { WorkflowEvent, WorkflowRunCheckpoint, WorkflowRunRecord } from '@gm-hz/dsh-dag-workflow-core'
import { SqliteWorkflowCatalogRepository, type SqliteWorkflowCatalogOptions } from './catalog-repository.js'
import { SqliteWorkflowRunStore, type SqliteWorkflowRunStoreOptions } from './run-store.js'

export class SqliteWorkflowTemplatesProvider extends RepositoryWorkflowTemplatesProvider {
  static inject = ['workflowNodes']
  private readonly repository: SqliteWorkflowCatalogRepository

  constructor(ctx: Context, config: SqliteWorkflowCatalogOptions) {
    const repository = new SqliteWorkflowCatalogRepository(config)
    super(ctx, repository)
    this.repository = repository
    ctx.effect(() => () => { this.repository.close() }, 'dsh-dag-workflow: close SQLite catalog')
  }
}

export class SqliteWorkflowRunsProvider extends WorkflowRunsService {
  private readonly store: SqliteWorkflowRunStore

  constructor(ctx: Context, config: SqliteWorkflowRunStoreOptions) {
    super(ctx)
    this.store = new SqliteWorkflowRunStore(config)
    ctx.effect(() => () => { this.store.close() }, 'dsh-dag-workflow: close SQLite run store')
  }

  createRun(record: WorkflowRunRecord): void { this.store.createRun(record) }
  commit(runId: string, expectedSeq: number, checkpoint: WorkflowRunCheckpoint, events: readonly WorkflowEvent[]): void {
    this.store.commit(runId, expectedSeq, checkpoint, events)
  }
  loadRun(runId: string): WorkflowRunRecord | undefined { return this.store.loadRun(runId) }
  listRecoverableRuns(): readonly WorkflowRunRecord[] { return this.store.listRecoverableRuns() }
}
