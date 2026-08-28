# @gm-hz/agent-dag-workflow/catalog

Workflow Template 的 draft、乐观并发和不可变发布版本领域层。

```ts
const repository = new InMemoryWorkflowCatalogRepository()
const catalog = new WorkflowTemplateCatalog(repository, workflowNodeRegistry)

const draft = await catalog.createDraft(template)
const next = await catalog.updateDraft(draft.id, draft.revision, editedTemplate)
const diagnostics = await catalog.validate(next.template)
const published = await catalog.publish(next.id, next.revision)
```

## 语义

- draft revision 从 1 开始，每次 update 必须携带 `expectedRevision`。
- draft 可以暂时无效，便于 Agent/Canvas 增量构建；publish 必须通过完整编译校验。
- published revision 独立单调递增，内容、节点版本、content hash 和 semantic hash 不可变。
- semantic hash 排除 `layout`，content hash 包含完整模板。
- `diff()` 分开报告 node、edge、layout 与 semantic 变化。
- Repository 接口把原子 CAS/publish 交给存储实现；内存实现用于测试，SQLite 实现单独提供。
