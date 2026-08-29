import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorkflowMcpSdkServer, createMcpGateway } from '../../src/adapters/mcp/index.js'
import { InMemoryWorkflowCatalogRepository, WorkflowTemplateCatalog } from '../../src/catalog/index.js'
import { InMemoryWorkflowRunStore, WorkflowNodeRegistry, registerCoreNodes } from '../../src/core/index.js'
import { WorkflowRuntime } from '../../src/runtime/index.js'
import { toolWorkflowTemplate } from './fixtures.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('workflow MCP transports', () => {
  it('serves the fixed Gateway through the official MCP protocol', async () => {
    const nodes = new WorkflowNodeRegistry()
    registerCoreNodes(nodes)
    const runtime = new WorkflowRuntime({
      nodes,
      catalog: new WorkflowTemplateCatalog(new InMemoryWorkflowCatalogRepository(), nodes),
      runStore: new InMemoryWorkflowRunStore(),
      services: { tools: { async execute(request) { return { echo: request.inputs.message ?? null } } } },
    })
    const draft = await runtime.createDraft(toolWorkflowTemplate())
    await runtime.publish(draft.id, draft.revision)
    const server = createWorkflowMcpSdkServer(createMcpGateway(runtime), {
      context: ({ signal }) => ({ authorityRef: 'mcp:test', authority: {}, signal }),
    })
    const client = new Client({ name: 'workflow-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    try {
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual([
        'workflow_search', 'workflow_describe', 'workflow_run', 'workflow_run_get', 'workflow_trace',
      ])
      const search = await client.callTool({ name: 'workflow_search', arguments: { query: 'Tool' } })
      expect(search.structuredContent).toMatchObject({ items: [{ ref: 'tool-flow@1' }] })
      const run = await client.callTool({ name: 'workflow_run', arguments: { ref: 'tool-flow@1', inputs: { message: 'protocol' } } })
      expect(run.structuredContent).toMatchObject({ status: 'completed', outputs: { answer: 'protocol' } })
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('starts the packaged stdio executable without writing non-protocol data to stdout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-workflow-mcp-stdio-'))
    roots.push(root)
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(process.cwd(), 'lib', 'mcp-cli.js'), '--db', join(root, 'workflow.db')],
      cwd: process.cwd(),
      stderr: 'pipe',
    })
    const client = new Client({ name: 'workflow-stdio-test', version: '1.0.0' })
    await client.connect(transport)
    try {
      expect((await client.listTools()).tools).toHaveLength(5)
      const result = await client.callTool({ name: 'workflow_search', arguments: {} })
      expect(result.isError).not.toBe(true)
      expect(result.structuredContent).toEqual({ items: [] })
    } finally {
      await client.close()
    }
  })
})
