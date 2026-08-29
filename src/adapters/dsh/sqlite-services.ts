import type { Context } from '@deepseek-ai/cordis'
import type { WorkflowEvent, WorkflowRunCheckpoint, WorkflowRunMetadata, WorkflowRunRecord } from '../../core/index.js'
import {
  SqliteWorkflowBindingRepository,
  SqliteWorkflowCatalogRepository,
  SqliteWorkflowDeliveryStore,
  SqliteWorkflowIngressStore,
  SqliteWorkflowRunStore,
  type SqliteWorkflowBindingRepositoryOptions,
  type SqliteWorkflowCatalogOptions,
  type SqliteWorkflowDeliveryStoreOptions,
  type SqliteWorkflowIngressStoreOptions,
  type SqliteWorkflowRunStoreOptions,
} from '../../storage/sqlite/index.js'
import type { WorkflowDeliveryRecord, WorkflowIngressRecord } from '../../triggers/core/index.js'
import {
  RepositoryWorkflowBindingsService,
  RepositoryWorkflowTemplatesService,
  WorkflowDeliveryRecordsService,
  WorkflowIngressRecordsService,
  WorkflowRunsService,
} from './services.js'

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
  createRun(record: WorkflowRunRecord) { return this.store.createRun(record) }
  commit(runId: string, expectedSeq: number, checkpoint: WorkflowRunCheckpoint, events: readonly WorkflowEvent[]) { return this.store.commit(runId, expectedSeq, checkpoint, events) }
  loadRun(runId: string) { return this.store.loadRun(runId) }
  getRunMetadata(runId: string): Promise<WorkflowRunMetadata | undefined> { return this.store.getRunMetadata(runId) }
  getCheckpoint(runId: string) { return this.store.getCheckpoint(runId) }
  readEvents(runId: string, query?: { readonly afterSeq?: number; readonly limit?: number }) { return this.store.readEvents(runId, query) }
  listRecoverableRuns() { return this.store.listRecoverableRuns() }
}

export class SqliteWorkflowBindingsService extends RepositoryWorkflowBindingsService {
  static inject = ['workflowTemplates', 'workflowTriggers']
  private readonly repository: SqliteWorkflowBindingRepository
  constructor(ctx: Context, config: SqliteWorkflowBindingRepositoryOptions) {
    const repository = new SqliteWorkflowBindingRepository(config)
    super(ctx, repository)
    this.repository = repository
    ctx.effect(() => () => { this.repository.close() }, 'agent-dag-workflow: close SQLite binding catalog')
  }
}

export class SqliteWorkflowIngressRecordsService extends WorkflowIngressRecordsService {
  private readonly store: SqliteWorkflowIngressStore
  constructor(ctx: Context, config: SqliteWorkflowIngressStoreOptions) {
    super(ctx)
    this.store = new SqliteWorkflowIngressStore(config)
    ctx.effect(() => () => { this.store.close() }, 'agent-dag-workflow: close SQLite ingress journal')
  }
  acceptOrGet(record: WorkflowIngressRecord) { return this.store.acceptOrGet(record) }
  markLaunched(triggerId: string, runId: string) { return this.store.markLaunched(triggerId, runId) }
  markRejected(triggerId: string, reasonCode: string) { return this.store.markRejected(triggerId, reasonCode) }
  get(triggerId: string) { return this.store.get(triggerId) }
  listPending() { return this.store.listPending() }
  list(query?: { readonly limit?: number }) { return this.store.list(query) }
}

export class SqliteWorkflowDeliveryRecordsService extends WorkflowDeliveryRecordsService {
  private readonly store: SqliteWorkflowDeliveryStore
  constructor(ctx: Context, config: SqliteWorkflowDeliveryStoreOptions) {
    super(ctx)
    this.store = new SqliteWorkflowDeliveryStore(config)
    ctx.effect(() => () => { this.store.close() }, 'agent-dag-workflow: close SQLite delivery journal')
  }
  get(invocationId: string) { return this.store.get(invocationId) }
  save(record: WorkflowDeliveryRecord, expectedAttempts: number) { return this.store.save(record, expectedAttempts) }
  listAttention(query?: { readonly limit?: number }) { return this.store.listAttention(query) }
}
