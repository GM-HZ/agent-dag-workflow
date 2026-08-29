import { describe, expect, it } from 'vitest'
import { WorkflowAgentAccess } from '../../src/access/index.js'
import { InMemoryWorkflowCatalogRepository, WorkflowTemplateCatalog } from '../../src/catalog/index.js'
import { InMemoryWorkflowRunStore, WorkflowNodeRegistry, registerCoreNodes } from '../../src/core/index.js'
import { WorkflowRuntime } from '../../src/runtime/index.js'
import { toolWorkflowTemplate } from './fixtures.js'

describe('WorkflowAgentAccess', () => {
  it('provides bounded discovery, explicit schema loading, compact runs, and authoritative trace', async () => {
    const nodes = new WorkflowNodeRegistry()
    registerCoreNodes(nodes)
    const runtime = new WorkflowRuntime({
      nodes,
      catalog: new WorkflowTemplateCatalog(new InMemoryWorkflowCatalogRepository(), nodes),
      runStore: new InMemoryWorkflowRunStore(),
      services: { tools: { async execute(request) { return { echo: request.inputs.message ?? null } } } },
    })
    const access = new WorkflowAgentAccess(runtime)
    const context = { authorityRef: 'agent:test', authority: {}, origin: { type: 'sdk', source: 'access-test' } }
    const draft = await access.putDraft({ ...toolWorkflowTemplate(), metadata: { ...toolWorkflowTemplate().metadata, description: 'Echo one message safely.' } }, context)
    const published = await access.publish(draft.id, draft.revision, context)
    expect(published.ref).toBe('tool-flow@1')
    expect(await access.search({ query: 'safely', limit: 1 }, context)).toMatchObject({ items: [{ ref: 'tool-flow@1' }] })
    const summary = await access.describe({ ref: 'tool-flow@1' }, context)
    expect(summary.inputSchema).toBeUndefined()
    expect(summary.template).toBeUndefined()
    const schema = await access.describe({ ref: 'tool-flow@1', view: 'schema' }, context)
    expect(schema.inputSchema).toMatchObject({ required: ['message'] })
    expect(schema.template).toBeUndefined()
    const result = await access.run({ ref: 'tool-flow@1', inputs: { message: 'access' } }, context)
    expect(result).toMatchObject({ status: 'completed', outputs: { answer: 'access' } })
    const run = await access.getRun(result.runId, context)
    expect(run).toMatchObject({ ref: 'tool-flow@1', status: 'completed' })
    expect(run).not.toHaveProperty('plan')
    expect(await access.trace({ runId: result.runId }, context)).toMatchObject({ run: { status: 'completed' } })
    const events = await access.trace({ runId: result.runId, view: 'events', limit: 3 }, context)
    expect(events.events).toHaveLength(3)
    expect(events.nextAfterSeq).toBeTypeOf('number')
  })

  it('fails closed when a caller omits the published revision', async () => {
    const nodes = new WorkflowNodeRegistry()
    registerCoreNodes(nodes)
    const access = new WorkflowAgentAccess(new WorkflowRuntime({
      nodes,
      catalog: new WorkflowTemplateCatalog(new InMemoryWorkflowCatalogRepository(), nodes),
      runStore: new InMemoryWorkflowRunStore(),
    }))
    await expect(access.describe({ ref: 'tool-flow' }, { authorityRef: 'agent:test', authority: {}, origin: { type: 'sdk' } }))
      .rejects.toMatchObject({ code: 'WORKFLOW_REVISION_REQUIRED' })
  })
})
