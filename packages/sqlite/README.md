# @gm-hz/dsh-workflow-sqlite

基于 Node `node:sqlite` 的 Host-only 持久化 provider。目前实现 Template Catalog repository；Run event/checkpoint 表会使用同一 application schema 扩展。

```ts
const repository = new SqliteWorkflowCatalogRepository({ path: './workflows.db' })
const catalog = new WorkflowTemplateCatalog(repository, nodes)
```

在 Cordis 中可直接发布服务：

```ts
await ctx.plugin(WorkflowNodeRegistryService)
await ctx.plugin(SqliteWorkflowTemplatesProvider, { path: './workflows.db' })
```

数据库启用 `trusted_schema=OFF`、`foreign_keys=ON`、`mmap_size=0`、`synchronous=FULL`，文件数据库使用 WAL。打开已有数据库时验证 application id、schema version 和必需表，不会把未知数据库当作空库初始化。
