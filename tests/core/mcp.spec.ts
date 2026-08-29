import { describe, expect, it } from 'vitest'
import { InMemoryWorkflowCatalogRepository, WorkflowTemplateCatalog } from '../../src/catalog/index.js'
import { InMemoryWorkflowRunStore, WorkflowNodeRegistry, materializeWorkflowTemplate, registerCoreNodes, type JsonObject, type JsonValue } from '../../src/core/index.js'
import { createMcpGateway } from '../../src/adapters/mcp/index.js'
import { WorkflowRuntime } from '../../src/runtime/index.js'
import { toolWorkflowTemplate } from './fixtures.js'

describe('workflow MCP gateway', () => {
  it('keeps a fixed invoke surface and discovers one schema on demand', async () => {
    const runtime = fixtureRuntime()
    const invoke = createMcpGateway(runtime)
    const context = { authorityRef: 'mcp:user', authority: {} }
    expect(invoke.listTools().map(item => item.name)).toEqual([
      'workflow_search', 'workflow_describe', 'workflow_run', 'workflow_run_get', 'workflow_trace',
    ])
    const beforeSize = JSON.stringify(invoke.listTools()).length
    const draft = await runtime.createDraft(toolWorkflowTemplate())
    await runtime.publish(draft.id, draft.revision)
    expect(invoke.listTools()).toHaveLength(5)
    expect(JSON.stringify(invoke.listTools())).toHaveLength(beforeSize)

    const search = await invoke.callTool('workflow_search', { query: 'Tool' }, context) as JsonObject
    expect(search.items).toEqual([expect.objectContaining({ ref: 'tool-flow@1', name: 'Tool flow' })])
    const described = await invoke.callTool('workflow_describe', { ref: 'tool-flow@1', view: 'schema' }, context) as JsonObject
    expect(described).toMatchObject({ ref: 'tool-flow@1', inputSchema: { required: ['message'] }, outputSchema: { required: ['answer'] } })

    const result = await invoke.callTool('workflow_run', { ref: 'tool-flow@1', inputs: { message: 'mcp' } }, context) as JsonObject
    expect(result).toMatchObject({ status: 'completed', outputs: { answer: 'mcp' } })
    const run = await invoke.callTool('workflow_run_get', { runId: result.runId! }, context) as JsonObject
    expect(run).toMatchObject({ ref: 'tool-flow@1', status: 'completed' })
    expect(run.plan).toBeUndefined()
    const trace = await invoke.callTool('workflow_trace', { runId: result.runId!, view: 'events', limit: 5 }, context) as JsonObject
    expect(trace.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'run.accepted' })]))
  })

  it('adds authoring tools only when the server starts in author profile', async () => {
    const runtime = fixtureRuntime()
    const invoke = createMcpGateway(runtime)
    const author = createMcpGateway(runtime, { profile: 'author' })
    const context = { authorityRef: 'mcp:author', authority: {} }
    expect(invoke.listTools()).toHaveLength(5)
    expect(author.listTools()).toHaveLength(11)
    await expect(invoke.callTool('workflow_validate', { template: toolWorkflowTemplate() as unknown as JsonValue }, context))
      .rejects.toMatchObject({ code: 'WORKFLOW_REQUEST_INVALID' })
    const nodes = await author.callTool('workflow_nodes_list', { query: 'tool.call' }, context) as JsonObject
    expect(nodes.items).toEqual([expect.objectContaining({ uses: 'tool.call@1' })])
    const draft = await author.callTool('workflow_draft_put', { template: toolWorkflowTemplate() as unknown as JsonValue }, context) as JsonObject
    expect(draft).toMatchObject({ id: 'tool-flow', revision: 1 })
    const published = await author.callTool('workflow_publish', { id: 'tool-flow', expectedDraftRevision: 1 }, context)
    expect(published).toMatchObject({ ref: 'tool-flow@1' })
  })

  it('keeps tool count and serialized schema size constant with one thousand published workflows', async () => {
    const nodes = new WorkflowNodeRegistry()
    registerCoreNodes(nodes)
    const repository = new InMemoryWorkflowCatalogRepository()
    const catalog = new WorkflowTemplateCatalog(repository, nodes)
    const runtime = new WorkflowRuntime({ nodes, catalog, runStore: new InMemoryWorkflowRunStore() })
    const gateway = createMcpGateway(runtime)
    const baseline = JSON.stringify(gateway.listTools())
    for (let index = 0; index < 1000; index++) {
      const workflow = toolWorkflowTemplate()
      const id = `flow-${index}`
      const template = { ...workflow, metadata: { ...workflow.metadata, id, name: `Flow ${index}` } }
      await repository.createDraft(materializeWorkflowTemplate(template), index)
      await repository.publishDraft(id, 1, index)
    }
    expect(gateway.listTools()).toHaveLength(5)
    expect(JSON.stringify(gateway.listTools())).toBe(baseline)
    const result = await gateway.callTool('workflow_search', { query: 'Flow', limit: 10 }, { authorityRef: 'mcp:test', authority: {} }) as JsonObject
    expect(result.items).toHaveLength(10)
    expect(result.nextAfter).toBeTypeOf('string')
  })
})

function fixtureRuntime(): WorkflowRuntime {
  const nodes = new WorkflowNodeRegistry()
  registerCoreNodes(nodes)
  const catalog = new WorkflowTemplateCatalog(new InMemoryWorkflowCatalogRepository(), nodes)
  return new WorkflowRuntime({
    nodes,
    catalog,
    runStore: new InMemoryWorkflowRunStore(),
    services: { tools: { async execute(request) { return { echo: request.inputs.message ?? null } } } },
  })
}
