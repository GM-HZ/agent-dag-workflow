import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { createMcpGateway } from '../../src/adapters/mcp/index.js'
import { runWorkflowCli } from '../../src/adapters/cli/index.js'
import * as DshWorkflow from '../../src/adapters/dsh/index.js'
import type {
  DshApprovalRuntimeLike,
  DshSkillRuntimeLike,
  DshSubagentRunLike,
  DshSubagentRuntimeLike,
  DshToolRuntimeInput,
  DshToolRuntimeLike,
  DshToolRuntimeResult,
  DshWorkflowToolDefinition,
} from '../../src/adapters/dsh/index.js'
import { InMemoryWorkflowCatalogRepository, WorkflowTemplateCatalog } from '../../src/catalog/index.js'
import {
  InMemoryWorkflowRunStore,
  WorkflowNodeRegistry,
  parseWorkflowTemplate,
  registerCoreNodes,
  type JsonObject,
  type JsonValue,
  type WorkflowEngineServices,
} from '../../src/core/index.js'
import { WorkflowRuntime } from '../../src/runtime/index.js'
import { InMemoryWorkflowArtifactStore } from '../../src/journal/index.js'
import { SqliteWorkflowRunStore } from '../../src/storage/sqlite/index.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const templatePath = join(process.cwd(), 'examples', 'weekly-ai-model-news.workflow.json')
const hostPath = join(process.cwd(), 'examples', 'weekly-ai-model-news.mock-host.mjs')
const template = parseWorkflowTemplate(readFileSync(templatePath, 'utf8'))
const inputs = { from: '2026-08-19T00:00:00+08:00', to: '2026-08-25T23:59:59+08:00' }

describe('weekly AI model workflow Host conformance', () => {
  it('keeps SDK, MCP, CLI, and DSH plans, outputs, and Journal contracts aligned', async () => {
    const sdk = fixtureRuntime()
    const sdkHandle = await sdk.runtime.launch({
      target: { type: 'inline', template }, inputs, authorityRef: 'sdk:test', authority: {}, origin: { type: 'sdk' },
    })
    const sdkResult = await sdkHandle.result
    if (sdkResult.status !== 'completed') throw new Error(sdkResult.error)
    expect(sdkResult.status).toBe('completed')
    expect(sdk.toolCalls).toBe(13)
    expect(sdk.agentCalls).toBe(4)
    const replay = await sdk.runtime.replay({ runId: sdkHandle.runId, mode: 'recorded' })
    const replayResult = await replay.result
    expect(replayResult).toMatchObject({ status: 'completed', outputs: sdkResult.outputs })
    expect(replayResult.events.filter(event => event.type === 'capability.replayed')).toHaveLength(17)
    expect(sdk.toolCalls).toBe(13)
    expect(sdk.agentCalls).toBe(4)

    const mcpFixture = fixtureRuntime()
    const draft = await mcpFixture.runtime.createDraft(template)
    await mcpFixture.runtime.publish(draft.id, draft.revision)
    const mcp = createMcpGateway(mcpFixture.runtime)
    const mcpResult = await mcp.callTool('workflow_run', {
      ref: `${draft.id}@1`,
      inputs,
    }, { authorityRef: 'mcp:test', authority: {} }) as JsonObject
    expect(mcpResult.status).toBe('completed')

    const root = mkdtempSync(join(tmpdir(), 'weekly-host-conformance-'))
    roots.push(root)
    const inputPath = join(root, 'inputs.json')
    const database = join(root, 'workflow.db')
    writeFileSync(inputPath, JSON.stringify(inputs))
    const cliLines: string[] = []
    expect(await runWorkflowCli(['draft', 'put', templatePath, '--host', hostPath, '--db', database], line => cliLines.push(line))).toBe(0)
    const cliDraft = envelopeData(cliLines.pop()!) as { readonly revision: number }
    expect(await runWorkflowCli(['publish', template.metadata.id, '--expected', String(cliDraft.revision), '--host', hostPath, '--db', database], line => cliLines.push(line))).toBe(0)
    cliLines.pop()
    expect(await runWorkflowCli([
      'run', `${template.metadata.id}@1`, '--input', inputPath, '--host', hostPath, '--db', database,
    ], line => cliLines.push(line))).toBe(0)
    const cliResult = envelopeData(cliLines.pop()!) as { readonly runId: string; readonly status: string; readonly outputs: JsonObject }

    expect(mcpResult.outputs).toEqual(sdkResult.outputs)
    expect(cliResult.outputs).toEqual(sdkResult.outputs)
    expectWeeklyOutput(sdkResult.outputs)

    const sdkEvents = (await sdk.runtime.readEvents(sdkHandle.runId, { limit: 1000 })).events
    const mcpTrace = await mcp.callTool('workflow_trace', { runId: mcpResult.runId!, view: 'events', limit: 1000 }, { authorityRef: 'mcp:test', authority: {} }) as JsonObject
    const cliTrace: string[] = []
    expect(await runWorkflowCli(['trace', cliResult.runId, '--events', '--limit', '1000', '--host', hostPath, '--db', database], line => cliTrace.push(line))).toBe(0)
    const cliTraceData = envelopeData(cliTrace.pop()!) as { readonly events: readonly JsonObject[] }
    const dsh = await dshFixture()
    const dshRun = await dsh.ctx.dagWorkflowEngine.start({ template, inputs, parent: { session: { append() {} } } })
    const dshResult = await dshRun.result
    if (dshResult.status !== 'completed') throw new Error(dshResult.error)
    const dshEvents = await dsh.ctx.workflowRuns.readEvents(dshRun.id, { limit: 1000 })
    const planProjections = await Promise.all([
      sdk.runStore.getRunMetadata(sdkHandle.runId),
      mcpFixture.runStore.getRunMetadata(String(mcpResult.runId)),
      new SqliteWorkflowRunStore({ path: database }).getRunMetadata(cliResult.runId),
      dsh.ctx.workflowRuns.getRunMetadata(dshRun.id),
    ]).then(records => records.map(record => {
      if (record === undefined) throw new Error('Host did not persist its execution plan')
      return {
        semanticHash: record.plan.root.semanticHash,
        engineVersion: record.plan.engineVersion,
        nodeDefinitionSetHash: record.plan.nodeDefinitionSetHash,
        dependencies: record.plan.dependencies.map(dependency => `${dependency.id}:${dependency.semanticHash}`).sort(),
      }
    }))

    expect(dshResult.outputs).toEqual(sdkResult.outputs)
    expect(dsh.tools.requests).toHaveLength(13)
    expect(dsh.subagents.requests).toHaveLength(4)
    expect(planProjections.slice(1)).toEqual([planProjections[0], planProjections[0], planProjections[0]])

    const signatures = [
      sdkEvents.map(event => `${event.type}:${event.node?.id ?? ''}`),
      (mcpTrace.events as readonly JsonObject[]).map(event => `${event.type}:${(event.node as JsonObject | undefined)?.id ?? ''}`),
      cliTraceData.events.map(event => `${event.type}:${(event.node as JsonObject | undefined)?.id ?? ''}`),
      dshEvents.map(event => `${event.type}:${event.node?.id ?? ''}`),
    ]
    expect([...signatures[1]!].sort()).toEqual([...signatures[0]!].sort())
    expect([...signatures[2]!].sort()).toEqual([...signatures[0]!].sort())
    expect([...signatures[3]!].sort()).toEqual([...signatures[0]!].sort())
    expect(signatures[0]!.filter(value => value.startsWith('capability.completed:'))).toHaveLength(17)
    await dsh.plugin.dispose()
  })
})

function envelopeData(source: string): unknown {
  const envelope = JSON.parse(source) as { readonly ok: boolean; readonly data?: unknown; readonly error?: unknown }
  if (!envelope.ok) throw new Error(`CLI failed: ${JSON.stringify(envelope.error)}`)
  return envelope.data
}

function fixtureRuntime() {
  const nodes = new WorkflowNodeRegistry()
  registerCoreNodes(nodes)
  const catalog = new WorkflowTemplateCatalog(new InMemoryWorkflowCatalogRepository(), nodes)
  let toolCalls = 0
  let agentCalls = 0
  const runStore = new InMemoryWorkflowRunStore()
  const runtime = new WorkflowRuntime({
    nodes,
    catalog,
    runStore,
    artifactStore: new InMemoryWorkflowArtifactStore(),
    capturePolicy: { mode: 'replayable', maxArtifactBytes: 2 * 1024 * 1024 },
    services: weeklyServices(() => { toolCalls++ }, () => { agentCalls++ }),
  })
  return { runtime, runStore, get toolCalls() { return toolCalls }, get agentCalls() { return agentCalls } }
}

function weeklyServices(onTool = () => {}, onAgent = () => {}): WorkflowEngineServices {
  const items = weeklyItems()
  return {
    tools: { async execute(request) {
      onTool()
      if (request.uses !== 'web_search') throw new Error(`unexpected Tool: ${request.uses}`)
      const batch = Number(request.nodeId.slice('search-'.length)) - 1
      return { content: request.nodeId, sources: items.slice(batch * 8, batch * 8 + 8).map(item => ({ url: item.url, title: item.title, snippet: item.summary, publishedAt: item.publishedAt })), truncated: true }
    } },
    agents: { async execute(request) {
      onAgent()
      let structured: JsonValue
      if (request.nodeId === 'plan-searches') structured = { batches: Array.from({ length: 13 }, (_, batch) => ({ queries: Array.from({ length: 4 }, (_, query) => `AI model topic ${batch}-${query}`) })) }
      else if (request.nodeId === 'normalize-news') structured = { items }
      else if (request.nodeId === 'score-news') structured = { scores: (request.inputs.items as readonly JsonObject[]).map((item, index) => ({ id: item.id!, importanceScore: (index * 37) % 101, importanceReason: `importance ${index}` })) }
      else if (request.nodeId === 'summarize-top-10') structured = { summaries: (request.inputs.items as readonly JsonObject[]).map((item, index) => ({ id: item.id!, digest: `摘要 ${index + 1}` })) }
      else throw new Error(`unexpected Agent node: ${request.nodeId}`)
      return { runId: `${request.runId}:${request.nodeId}:mock-agent`, content: [], structured }
    } },
  }
}

function weeklyItems() {
  return Array.from({ length: 100 }, (_, index) => {
    const publishedAt = `2026-08-${String(19 + (index % 7)).padStart(2, '0')}T${String(index % 24).padStart(2, '0')}:00:00+08:00`
    const url = `https://source.example/ai-model-${index}`
    return { id: url, title: `AI model item ${index}`, url, publishedAt, source: 'source.example', kind: ['release', 'research', 'news', 'analysis'][index % 4]!, summary: `Source-grounded summary ${index}` }
  })
}

class ConformanceTools extends Service implements DshToolRuntimeLike {
  readonly requests: DshToolRuntimeInput[] = []
  readonly definitions = new Map<string, DshWorkflowToolDefinition>()
  constructor(ctx: Context) { super(ctx, 'tools') }
  async execute(input: DshToolRuntimeInput): Promise<DshToolRuntimeResult> {
    this.requests.push(input)
    const batch = Number(input.callId.match(/search-(\d+)/)?.[1] ?? this.requests.length) - 1
    const items = weeklyItems().slice(batch * 8, batch * 8 + 8)
    return { isError: false, value: { content: input.callId, sources: items.map(item => ({ url: item.url, title: item.title, snippet: item.summary, publishedAt: item.publishedAt })), truncated: true } }
  }
  register(definition: DshWorkflowToolDefinition): () => void { this.definitions.set(definition.name, definition); return () => { this.definitions.delete(definition.name) } }
  schemas() { return [...this.definitions.values()].map(({ name, description, parameters }) => ({ name, description, parameters })) }
}

class ConformanceSubagents extends Service implements DshSubagentRuntimeLike {
  readonly requests: Parameters<DshSubagentRuntimeLike['start']>[] = []
  constructor(ctx: Context) { super(ctx, 'subagents') }
  list(): readonly string[] { return ['spawn'] }
  getProvider() { return { capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true } } }
  async start(...args: Parameters<DshSubagentRuntimeLike['start']>): Promise<DshSubagentRunLike> {
    this.requests.push(args)
    const request = args[1]
    const marker = '\n\nWorkflow node inputs (JSON):\n'
    const text = request.prompt[0]?.text ?? ''
    const inputs = JSON.parse(text.slice(text.indexOf(marker) + marker.length)) as JsonObject
    const items = weeklyItems()
    let structured: JsonValue
    if (request.label === 'plan-searches') structured = { batches: Array.from({ length: 13 }, (_, batch) => ({ queries: Array.from({ length: 4 }, (_, query) => `AI model topic ${batch}-${query}`) })) }
    else if (request.label === 'normalize-news') structured = { items }
    else if (request.label === 'score-news') structured = { scores: (inputs.items as readonly JsonObject[]).map((item, index) => ({ id: item.id!, importanceScore: (index * 37) % 101, importanceReason: `importance ${index}` })) }
    else structured = { summaries: (inputs.items as readonly JsonObject[]).map((item, index) => ({ id: item.id!, digest: `摘要 ${index + 1}` })) }
    return { id: `dsh-child-${this.requests.length}`, result: Promise.resolve({ output: [], structured, stopReason: 'completed' }), async dispose() {} }
  }
}

class ConformanceApproval extends Service implements DshApprovalRuntimeLike {
  constructor(ctx: Context) { super(ctx, 'approval') }
  async request(): ReturnType<DshApprovalRuntimeLike['request']> { return 'allowed-once' }
}
class ConformanceSkills extends Service implements DshSkillRuntimeLike {
  constructor(ctx: Context) { super(ctx, 'skills') }
  register(): () => void { return () => {} }
}

async function dshFixture() {
  const ctx = new Context()
  await ctx.plugin(ConformanceTools)
  await ctx.plugin(ConformanceSubagents)
  await ctx.plugin(ConformanceApproval)
  await ctx.plugin(ConformanceSkills)
  const plugin = await ctx.plugin(DshWorkflow)
  const tools = ctx.get('tools') as ConformanceTools
  const subagents = ctx.get('subagents') as ConformanceSubagents
  return { ctx, tools, subagents, plugin }
}

function expectWeeklyOutput(outputs: JsonObject): void {
  expect(outputs.candidateCount).toBe(100)
  expect(outputs.period).toEqual(inputs)
  const items = outputs.items as readonly JsonObject[]
  expect(items).toHaveLength(10)
  expect(items.map(item => item.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  expect(items.every(item => typeof item.digest === 'string' && typeof item.importanceScore === 'number')).toBe(true)
}
