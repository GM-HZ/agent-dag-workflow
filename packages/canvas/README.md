# @gm-hz/dsh-workflow-canvas

Host-scoped Remote gateway and DSH `shell.overlay` visual studio for `WorkflowTemplate` v1alpha1.

Every RPC first resolves `sessionId` through DSH's live Host Agent registry and accepts only an attached, top-level Agent. Multi-user and multi-tenant deployments must layer a user/workspace/action policy after that lookup:

```ts
await ctx.plugin(workflowCanvas, {
  authorize: async ({ sessionId, agent, action, resourceId }) => {
    return mayUseWorkflow(currentUserId(), agent, action, resourceId)
      ? { subject: currentUserId(), agent }
      : undefined
  },
})
```

When `authorize` is omitted, the plugin uses a local single-user default: missing, detached, and subagent-owned session identities are rejected. A `sessionId` is a lookup key, not a multi-tenant credential.

The package contributes its generated Typert Remote client and XYFlow editor through its `dsh.client` manifest. The editor persists only the canonical workflow template and its `layout.canvas.positions`; there is no second graph DSL.

Custom node visuals can be installed from a Client plugin:

```tsx
import { workflowNodeRenderers } from '@gm-hz/dsh-workflow-canvas/client'

ctx.effect(() => workflowNodeRenderers.register('acme.review@1', ReviewNode))
```

Session/run renderers can open the already registered overlay without owning a second Canvas instance:

```ts
ctx.workflowCanvasUi.open({
  templateId: 'research-report',
  runId: 'dag-…',
  nodeId: 'summarize',
})
```

The Studio provides node/edge editing, top-level JSON Schema config fields plus a raw lossless JSON fallback, diagnostics, optimistic draft save, semantic/layout diff, publish, draft test-run, persisted trace, and explicit retry/fail decisions for unknown side effects.
