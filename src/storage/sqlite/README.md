# @gm-hz/agent-dag-workflow/sqlite

基于 Node `node:sqlite` 的 Host-only 持久化实现。Template Catalog 与 Run event/checkpoint 使用同一 application schema。

```ts
const repository = new SqliteWorkflowCatalogRepository({ path: './workflows.db' })
const catalog = new WorkflowTemplateCatalog(repository, nodes)

const runs = new SqliteWorkflowRunStore({ path: './workflows.db' })
```

通用入口不加载 Cordis。DSH Host 需要发布 Cordis 服务时从专用入口导入：

```ts
import {
  SqliteWorkflowRunsService,
  SqliteWorkflowTemplatesService,
  WorkflowNodeRegistryService,
} from '@gm-hz/agent-dag-workflow/dsh/host'

await ctx.plugin(WorkflowNodeRegistryService)
await ctx.plugin(SqliteWorkflowTemplatesService, { path: './workflows.db' })
await ctx.plugin(SqliteWorkflowRunsService, { path: './workflows.db' })
```

Run Store 在单个事务里追加连续事件并提交对应 checkpoint，使用 expected sequence 防止多个 writer 静默覆盖。数据库启用 `trusted_schema=OFF`、`foreign_keys=ON`、`mmap_size=0`、`synchronous=FULL`，文件数据库使用 WAL。只有空数据库会被初始化；已有数据库必须精确匹配当前 application id、schema version 和完整表集合。旧、未知或被篡改的数据库会被拒绝，打开过程不会修改它们。
