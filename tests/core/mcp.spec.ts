import { describe, expect, it } from 'vitest'
import { InMemoryWorkflowCatalogRepository, WorkflowTemplateCatalog } from '../../src/catalog/index.js'
import { InMemoryWorkflowRunStore, WorkflowNodeRegistry, registerCoreNodes } from '../../src/core/index.js'
import { WorkflowMcpServer } from '../../src/adapters/mcp/index.js'
import { WorkflowRuntime } from '../../src/runtime/index.js'
import { toolWorkflowTemplate } from './fixtures.js'

describe('workflow MCP control surface', () => {
  it('uses the same runtime for discovery, publishing, execution, and trace', async () => {
    const nodes = new WorkflowNodeRegistry()
    registerCoreNodes(nodes)
    const catalog = new WorkflowTemplateCatalog(new InMemoryWorkflowCatalogRepository(), nodes)
    const runtime = new WorkflowRuntime({
      nodes,
      catalog,
      runStore: new InMemoryWorkflowRunStore(),
      services: { tools: { async execute(request) { return { echo: request.inputs.message ?? null } } } },
    })
    const mcp = new WorkflowMcpServer(runtime)
    const context = { authorityRef: 'mcp:user', authority: {} }
    expect((await mcp.listTools()).map(item => item.name)).toContain('workflow_nodes_list')
    expect(await mcp.callTool('workflow_nodes_list', {}, context)).toEqual(expect.arrayContaining([
      expect.objectContaining({ uses: 'tool.call@1' }),
    ]))
    const draft = await mcp.callTool('workflow_draft_create', { template: toolWorkflowTemplate() as unknown as import('../../src/core/index.js').JsonValue }, context) as import('../../src/core/index.js').JsonObject
    await mcp.callTool('workflow_publish', { id: draft.id!, expectedRevision: draft.revision! }, context)
    expect(await mcp.listTools()).toContainEqual(expect.objectContaining({
      name: 'workflow_tool_flow_r1', kind: 'workflow', workflow: { id: 'tool-flow', revision: 1 },
      inputSchema: expect.objectContaining({ required: ['message'] }),
      outputSchema: expect.objectContaining({ required: ['answer'] }),
    }))
    const projected = await mcp.callTool('workflow_tool_flow_r1', { message: 'ordinary MCP tool' }, context) as import('../../src/core/index.js').JsonObject
    expect(projected).toEqual({ answer: 'ordinary MCP tool' })
    const result = await mcp.callTool('workflow_run', { id: draft.id!, revision: 1, inputs: { message: 'mcp' } }, context) as import('../../src/core/index.js').JsonObject
    expect(result).toMatchObject({ status: 'completed', outputs: { answer: 'mcp' } })
    const trace = await mcp.callTool('workflow_trace', { runId: result.runId!, limit: 5 }, context) as import('../../src/core/index.js').JsonObject
    expect(trace.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'run.accepted' })]))
  })
})
