import type { Context } from '@deepseek-ai/cordis'
import { RepositoryWorkflowTemplatesProvider } from '@gm-hz/dsh-workflow-dsh'
import { SqliteWorkflowCatalogRepository, type SqliteWorkflowCatalogOptions } from './catalog-repository.js'

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
