import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
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
        'workflow_search', 'workflow_describe', 'workflow_run', 'workflow_run_get', 'workflow_cancel', 'workflow_trace',
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
      const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
      expect(client.getServerVersion()).toEqual({ name: 'agent-dag-workflow', version })
      expect((await client.listTools()).tools).toHaveLength(6)
      const result = await client.callTool({ name: 'workflow_search', arguments: {} })
      expect(result.isError).not.toBe(true)
      expect(result.structuredContent).toEqual({ items: [] })
    } finally {
      await client.close()
    }
  })

  it('opens the same config and run identity as CLI from a different cwd', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-workflow-mcp-workspace-')))
    roots.push(root)
    const build = join(process.cwd(), 'lib')
    const cli = join(build, 'cli.js')
    const mcp = join(build, 'mcp-cli.js')
    const project = join(root, 'orders')
    const runCli = (cwd: string, ...args: string[]) => JSON.parse(execFileSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
    runCli(root, 'init', project)
    runCli(project, 'draft', 'put', 'workflow.json')
    runCli(project, 'publish', 'orders', '--expected', '1')
    const previous = runCli(project, 'run', 'orders@1', '--input', 'input.json').data
    const configPath = join(project, '.agent-dag-workflow.json')
    const outside = join(root, 'outside')
    mkdirSync(outside)
    const doctor = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [mcp, '--doctor', ...args], { cwd: outside, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
    expect(doctor('--config', configPath)).toMatchObject({ database: join(project, '.agent-dag-workflow.db'), authorityRef: 'cli:local' })
    expect(doctor()).toMatchObject({ database: join(outside, '.agent-dag-workflow.db'), authorityRef: 'mcp:local' })
    expect(existsSync(join(outside, '.agent-dag-workflow.db'))).toBe(false)

    const client = new Client({ name: 'workflow-workspace-stdio-test', version: '1.0.0' })
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [mcp, '--config', configPath], cwd: outside, stderr: 'pipe' }))
    try {
      const search = await client.callTool({ name: 'workflow_search', arguments: { query: 'orders' } })
      expect(search.structuredContent).toMatchObject({ items: [{ ref: 'orders@1' }] })
      const before = await client.callTool({ name: 'workflow_run_get', arguments: { runId: previous.runId } })
      expect(before.structuredContent).toMatchObject({ runId: previous.runId, status: 'completed', outputs: { total: 100 } })
      const run = await client.callTool({ name: 'workflow_run', arguments: { ref: 'orders@1', inputs: { customer: 'shared workspace', orders: [] } } })
      const runId = (run.structuredContent as { readonly runId?: unknown } | undefined)?.runId
      expect(run.structuredContent).toMatchObject({ status: 'completed', outputs: { customer: 'SHARED WORKSPACE' } })
      expect(runCli(project, 'trace', String(runId))).toMatchObject({ data: { run: { runId, status: 'completed' } } })
    } finally { await client.close() }
  })
})
