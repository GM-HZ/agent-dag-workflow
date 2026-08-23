# @gm-hz/dsh-workflow-canvas

Authorized Host Remote gateway and DSH `shell.overlay` visual studio for `WorkflowTemplate` v1alpha1.

The Host plugin fails closed unless `authorize` resolves a browser `sessionId` from Host-owned state and returns the real DSH Agent for that session:

```ts
await ctx.plugin(workflowCanvas, {
  authorize: async ({ sessionId, action, resourceId }) => {
    const agent = resolveAgentTheCallerMayUse(sessionId, action, resourceId)
    return agent === undefined ? undefined : { subject: currentUserId(), agent }
  },
})
```

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
