# @gm-hz/dsh-dag-workflow-sqlite

基于 Node `node:sqlite` 的 Host-only 持久化实现。Template Catalog 与 Run event/checkpoint 使用同一 application schema。

```ts
const repository = new SqliteWorkflowCatalogRepository({ path: './workflows.db' })
const catalog = new WorkflowTemplateCatalog(repository, nodes)

const runs = new SqliteWorkflowRunStore({ path: './workflows.db' })
```

在 Cordis 中可直接发布服务：

```ts
await ctx.plugin(WorkflowNodeRegistryService)
await ctx.plugin(SqliteWorkflowTemplatesService, { path: './workflows.db' })
await ctx.plugin(SqliteWorkflowRunsService, { path: './workflows.db' })
```

Run Store 在单个事务里追加连续事件并提交对应 checkpoint，使用 expected sequence 防止多个 writer 静默覆盖。数据库启用 `trusted_schema=OFF`、`foreign_keys=ON`、`mmap_size=0`、`synchronous=FULL`，文件数据库使用 WAL。打开已有数据库时验证 application id、schema version 和必需表，不会把未知数据库当作空库初始化；catalog-only v1 与 run-store v2 会迁移到当前 v3（增加 nullable `owner_ref`）。
