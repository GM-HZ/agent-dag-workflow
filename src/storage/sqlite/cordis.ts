import type { Context } from '@deepseek-ai/cordis'
import { RepositoryWorkflowTemplatesService, WorkflowRunsService } from '../../adapters/dsh/services.js'
import type { WorkflowEvent, WorkflowRunCheckpoint, WorkflowRunMetadata, WorkflowRunRecord } from '../../core/index.js'
import { SqliteWorkflowCatalogRepository, type SqliteWorkflowCatalogOptions } from './catalog-repository.js'
import { SqliteWorkflowRunStore, type SqliteWorkflowRunStoreOptions } from './run-store.js'

export class SqliteWorkflowTemplatesService extends RepositoryWorkflowTemplatesService {
  static inject = ['workflowNodes']
  private readonly repository: SqliteWorkflowCatalogRepository

  constructor(ctx: Context, config: SqliteWorkflowCatalogOptions) {
    const repository = new SqliteWorkflowCatalogRepository(config)
    super(ctx, repository)
    this.repository = repository
    ctx.effect(() => () => { this.repository.close() }, 'agent-dag-workflow: close SQLite catalog')
  }
}

export class SqliteWorkflowRunsService extends WorkflowRunsService {
  private readonly store: SqliteWorkflowRunStore

  constructor(ctx: Context, config: SqliteWorkflowRunStoreOptions) {
    super(ctx)
    this.store = new SqliteWorkflowRunStore(config)
    ctx.effect(() => () => { this.store.close() }, 'agent-dag-workflow: close SQLite run store')
  }

  async createRun(record: WorkflowRunRecord): Promise<void> { await this.store.createRun(record) }
  async commit(runId: string, expectedSeq: number, checkpoint: WorkflowRunCheckpoint, events: readonly WorkflowEvent[]): Promise<void> {
    await this.store.commit(runId, expectedSeq, checkpoint, events)
  }
  async loadRun(runId: string): Promise<WorkflowRunRecord | undefined> { return this.store.loadRun(runId) }
  async getRunMetadata(runId: string): Promise<WorkflowRunMetadata | undefined> { return this.store.getRunMetadata(runId) }
  async getCheckpoint(runId: string): Promise<WorkflowRunCheckpoint | undefined> { return this.store.getCheckpoint(runId) }
  async readEvents(runId: string, query?: { readonly afterSeq?: number; readonly limit?: number }): Promise<readonly WorkflowEvent[]> { return this.store.readEvents(runId, query) }
  async listRecoverableRuns(): Promise<readonly WorkflowRunRecord[]> { return this.store.listRecoverableRuns() }
}
