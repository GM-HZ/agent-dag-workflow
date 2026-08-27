import { Context, Service } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { parseWorkflowTemplate, type JsonValue, type WorkflowRunRecord, type WorkflowTemplate } from '@gm-hz/dsh-dag-workflow-core'
import { describe, expect, it, vi } from 'vitest'
import * as DshWorkflowPlugin from '../src/index.js'
import type {
  DshAgentLike,
  DshApprovalRuntimeLike,
  DshSkillRuntimeLike,
  DshSubagentRunLike,
  DshSubagentRuntimeLike,
  DshToolRuntimeInput,
  DshToolRuntimeResult,
  DshWorkflowToolDefinition,
} from '../src/index.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tools: StubToolRuntime
    subagents: StubSubagentRuntime
    approval: StubApprovalRuntime
    skills: StubSkillRuntime
  }
}

class StubSubagentRuntime extends Service implements DshSubagentRuntimeLike {
  readonly requests: Parameters<DshSubagentRuntimeLike['start']>[] = []
  handler: (...args: Parameters<DshSubagentRuntimeLike['start']>) => Promise<DshSubagentRunLike> = async () => ({
    id: 'child-1',
    result: Promise.resolve({ output: [{ type: 'text', text: 'child answer' }], structured: { answer: 'child answer' }, stopReason: 'completed' }),
    async dispose() {},
  })

  constructor(ctx: Context) {
    super(ctx, 'subagents')
  }

  list(): readonly string[] { return ['spawn'] }

  getProvider(name: string) {
    return name === 'spawn'
      ? { capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true } }
      : undefined
  }

  async start(...args: Parameters<DshSubagentRuntimeLike['start']>): ReturnType<DshSubagentRuntimeLike['start']> {
    this.requests.push(args)
    return this.handler(...args)
  }
}

class StubApprovalRuntime extends Service implements DshApprovalRuntimeLike {
  readonly requests: Parameters<DshApprovalRuntimeLike['request']>[0][] = []

  constructor(ctx: Context) {
    super(ctx, 'approval')
  }

  async request(input: Parameters<DshApprovalRuntimeLike['request']>[0]): ReturnType<DshApprovalRuntimeLike['request']> {
    this.requests.push(input)
    return 'allowed-once'
  }
}

class StubToolRuntime extends Service {
  readonly requests: DshToolRuntimeInput[] = []
  readonly definitions = new Map<string, DshWorkflowToolDefinition>()
  handler: (input: DshToolRuntimeInput) => Promise<DshToolRuntimeResult> = async input => ({
    isError: false,
    value: { echo: input.arguments.message ?? null },
  })

  constructor(ctx: Context) {
    super(ctx, 'tools')
  }

  async execute(input: DshToolRuntimeInput): Promise<DshToolRuntimeResult> {
    this.requests.push(input)
    return this.handler(input)
  }

  register(definition: DshWorkflowToolDefinition): () => void {
    if (this.definitions.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
    this.definitions.set(definition.name, definition)
    return () => { this.definitions.delete(definition.name) }
  }

  schemas(): readonly { readonly name: string; readonly description: string; readonly parameters: Readonly<Record<string, unknown>> }[] {
    return [...this.definitions.values()].map(({ name, description, parameters }) => ({ name, description, parameters }))
  }
}

class StubSkillRuntime extends Service implements DshSkillRuntimeLike {
  readonly definitions = new Map<string, Parameters<DshSkillRuntimeLike['register']>[0]>()

  constructor(ctx: Context) {
    super(ctx, 'skills')
  }

  register(skill: Parameters<DshSkillRuntimeLike['register']>[0]): () => void {
    this.definitions.set(skill.name, skill)
    return () => { this.definitions.delete(skill.name) }
  }
}

class StubSession {
  readonly events: { readonly type: string; readonly data: unknown }[] = []
  fail = false

  append(type: string, data: unknown): void {
    if (this.fail) throw new Error('session closed')
    this.events.push({ type, data: structuredClone(data) })
  }
}

function template(): WorkflowTemplate {
  return {
    apiVersion: 'dsh.workflow/v1alpha1',
    kind: 'WorkflowTemplate',
    metadata: { id: 'dsh-plugin-test', name: 'DSH plugin test' },
    spec: {
      requires: [
        { kind: 'capability', uses: 'dsh.tools.execute' },
        { kind: 'tool', uses: 'echo' },
      ],
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['message'],
        properties: { message: { type: 'string' } },
      },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['answer'],
        properties: { answer: { type: 'string' } },
      },
      nodes: [
        { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
        { id: 'echo', uses: 'dsh.tool@1', with: { name: 'echo' }, inputs: { message: { input: 'message' } } },
        { id: 'end', uses: 'core.end@1', with: {}, inputs: { answer: { output: { node: 'echo', path: ['result', 'echo'] } } } },
      ],
      edges: [
        { id: 'start-echo', source: 'start', target: 'echo' },
        { id: 'echo-end', source: 'echo', target: 'end' },
      ],
      outputs: { answer: { output: { node: 'end', path: ['answer'] } } },
    },
  }
}

function agentApprovalTemplate(): WorkflowTemplate {
  return {
    apiVersion: 'dsh.workflow/v1alpha1',
    kind: 'WorkflowTemplate',
    metadata: { id: 'agent-approval-test', name: 'Agent approval test' },
    spec: {
      requires: [
        { kind: 'capability', uses: 'dsh.subagents.start' },
        { kind: 'capability', uses: 'dsh.approval.request' },
        { kind: 'approval-action', uses: 'publish-report' },
      ],
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['answer', 'approved'],
        properties: { answer: { type: 'string' }, approved: { type: 'boolean' } },
      },
      nodes: [
        { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
        {
          id: 'delegate',
          uses: 'dsh.agent@1',
          with: {
            prompt: 'Produce the answer.',
            label: 'workflow child',
            outputSchema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } },
          },
          inputs: { topic: { literal: 'DSH' } },
        },
        {
          id: 'approve',
          uses: 'dsh.human-approval@1',
          with: { action: 'publish-report', reason: 'Approve the generated report.' },
          inputs: { answer: { output: { node: 'delegate', path: ['structured', 'answer'] } } },
        },
        {
          id: 'end',
          uses: 'core.end@1',
          with: {},
          inputs: {
            answer: { output: { node: 'delegate', path: ['structured', 'answer'] } },
            approved: { output: { node: 'approve', path: ['approved'] } },
          },
        },
      ],
      edges: [
        { id: 'start-delegate', source: 'start', target: 'delegate' },
        { id: 'delegate-approve', source: 'delegate', target: 'approve' },
        { id: 'approve-end-yes', source: 'approve', target: 'end', sourcePort: 'approved' },
        { id: 'approve-end-no', source: 'approve', target: 'end', sourcePort: 'rejected' },
      ],
      outputs: {
        answer: { output: { node: 'end', path: ['answer'] } },
        approved: { output: { node: 'end', path: ['approved'] } },
      },
    },
  }
}

function childTemplate(id: string, foreach = false): WorkflowTemplate {
  return {
    apiVersion: 'dsh.workflow/v1alpha1',
    kind: 'WorkflowTemplate',
    metadata: { id, name: `${id} child` },
    spec: {
      inputSchema: foreach
        ? {
            type: 'object',
            additionalProperties: false,
            required: ['item', 'index', 'shared'],
            properties: { item: {}, index: { type: 'integer' }, shared: { type: 'object' } },
          }
        : {
            type: 'object',
            additionalProperties: false,
            required: ['message'],
            properties: { message: { type: 'string' } },
          },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['value'],
        properties: { value: {} },
      },
      nodes: [
        { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
        {
          id: 'end',
          uses: 'core.end@1',
          with: {},
          inputs: { value: { input: foreach ? 'item' : 'message' } },
        },
      ],
      edges: [{ id: 'start-end', source: 'start', target: 'end' }],
      outputs: { value: { output: { node: 'end', path: ['value'] } } },
    },
  }
}

function nestedParentTemplate(): WorkflowTemplate {
  return {
    apiVersion: 'dsh.workflow/v1alpha1',
    kind: 'WorkflowTemplate',
    metadata: { id: 'nested-parent', name: 'Nested parent' },
    spec: {
      requires: [
        { kind: 'capability', uses: 'workflowTemplates.getPublished' },
        { kind: 'capability', uses: 'dagWorkflowEngine.invoke' },
        { kind: 'workflow', uses: 'nested-child@1' },
      ],
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['message'],
        properties: { message: { type: 'string' } },
      },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['value'],
        properties: { value: { type: 'string' } },
      },
      nodes: [
        { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
        {
          id: 'child',
          uses: 'core.subworkflow@1',
          with: { templateId: 'nested-child', revision: 1 },
          inputs: { message: { input: 'message' } },
        },
        { id: 'end', uses: 'core.end@1', with: {}, inputs: { value: { output: { node: 'child', path: ['outputs', 'value'] } } } },
      ],
      edges: [
        { id: 'start-child', source: 'start', target: 'child' },
        { id: 'child-end', source: 'child', target: 'end' },
      ],
      outputs: { value: { output: { node: 'end', path: ['value'] } } },
    },
  }
}

function foreachParentTemplate(): WorkflowTemplate {
  return {
    apiVersion: 'dsh.workflow/v1alpha1',
    kind: 'WorkflowTemplate',
    metadata: { id: 'foreach-parent', name: 'For each parent' },
    spec: {
      requires: [
        { kind: 'capability', uses: 'workflowTemplates.getPublished' },
        { kind: 'capability', uses: 'dagWorkflowEngine.invoke' },
        { kind: 'workflow', uses: 'item-worker@1' },
      ],
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['items'],
        properties: { items: { type: 'array' } },
      },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['results'],
        properties: { results: { type: 'array' } },
      },
      nodes: [
        { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
        {
          id: 'map',
          uses: 'core.foreach@1',
          with: { templateId: 'item-worker', revision: 1, maxConcurrency: 2, maxItems: 5 },
          inputs: { items: { input: 'items' }, shared: { literal: {} } },
        },
        { id: 'end', uses: 'core.end@1', with: {}, inputs: { results: { output: { node: 'map', path: ['results'] } } } },
      ],
      edges: [
        { id: 'start-map', source: 'start', target: 'map' },
        { id: 'map-end', source: 'map', target: 'end' },
      ],
      outputs: { results: { output: { node: 'end', path: ['results'] } } },
    },
  }
}

async function mountRuntime(ctx: Context): Promise<void> {
  await ctx.plugin(StubToolRuntime)
  await ctx.plugin(StubSubagentRuntime)
  await ctx.plugin(StubApprovalRuntime)
  await ctx.plugin(StubSkillRuntime)
}

describe('DSH Cordis plugin', () => {
  it('reuses caller-owned registry, catalog, and run store services', async () => {
    const ctx = new Context()
    await mountRuntime(ctx)
    const capabilitiesPlugin = await ctx.plugin(DshWorkflowPlugin.WorkflowCapabilityRegistryService)
    const scriptsPlugin = await ctx.plugin(DshWorkflowPlugin.WorkflowScriptRuntimeRegistryService)
    const nodesPlugin = await ctx.plugin(DshWorkflowPlugin.WorkflowNodeRegistryService)
    const templatesPlugin = await ctx.plugin(DshWorkflowPlugin.InMemoryWorkflowTemplatesService)
    const runsPlugin = await ctx.plugin(DshWorkflowPlugin.InMemoryWorkflowRunsService)
    const registry = ctx.workflowNodes.registry
    const capabilities = ctx.workflowCapabilities.registry
    const draft = ctx.workflowTemplates.createDraft(childTemplate('external-services'))

    const plugin = await ctx.plugin(DshWorkflowPlugin, { catalog: 'external', runStore: 'external' })

    expect(ctx.workflowNodes.registry).toBe(registry)
    expect(ctx.workflowCapabilities.registry).toBe(capabilities)
    expect(ctx.workflowTemplates.readDraft(draft.id)).toMatchObject({ id: draft.id, revision: 1 })
    const run = ctx.dagWorkflowEngine.start({
      template: childTemplate('external-run'),
      inputs: { message: 'persisted' },
      parent: { session: new StubSession() },
    })
    expect(await run.result).toMatchObject({ status: 'completed', outputs: { value: 'persisted' } })
    await run.dispose()
    await plugin.dispose()
    expect(ctx.workflowNodes.registry).toBe(registry)
    expect(ctx.workflowTemplates.readDraft(draft.id)).toMatchObject({ id: draft.id, revision: 1 })
    expect(ctx.workflowRuns.loadRun(run.id)?.checkpoint.status).toBe('completed')

    await runsPlugin.dispose()
    await templatesPlugin.dispose()
    await nodesPlugin.dispose()
    await scriptsPlugin.dispose()
    await capabilitiesPlugin.dispose()
  })

  it('publishes services and executes dsh.tool with the owning Agent', async () => {
    const ctx = new Context()
    await mountRuntime(ctx)
    const tools = ctx.tools
    const plugin = await ctx.plugin(DshWorkflowPlugin)
    const session = new StubSession()
    const parent: DshAgentLike = { session }
    const observed: string[] = []
    ctx.on('dag-workflow/event', event => { observed.push(event.type) })

    const run = ctx.dagWorkflowEngine.start({ template: template(), inputs: { message: 'hello' }, parent })
    const result = await run.result

    expect(result.status).toBe('completed')
    if (result.status !== 'completed') throw new Error(result.error)
    expect(result.outputs).toEqual({ answer: 'hello' })
    expect(tools.requests).toHaveLength(1)
    expect(tools.requests[0]).toMatchObject({ name: 'echo', arguments: { message: 'hello' }, agent: parent })
    expect(ctx.workflowNodes.list().map(node => `${node.type}@${node.version}`)).toEqual([
      'core.condition@1',
      'core.end@1',
      'core.foreach@1',
      'core.script@1',
      'core.start@1',
      'core.subworkflow@1',
      'dsh.agent@1',
      'dsh.human-approval@1',
      'dsh.tool@1',
    ])
    const draft = ctx.workflowTemplates.createDraft(template())
    const published = ctx.workflowTemplates.publish(draft.id, draft.revision)
    expect(ctx.workflowTemplates.getPublished(draft.id).revision).toBe(published.revision)
    expect(observed).toContain('run.completed')
    // Downstream Session event types cannot currently be registered with DSH.
    // Persist the complete trace in workflowRuns and keep the owning Session clean.
    expect(session.events).toEqual([])
    expect(ctx.workflowRuns.loadRun(run.id)?.checkpoint.status).toBe('completed')
    expect([...tools.definitions.keys()].sort()).toEqual([
      'workflow_diff',
      'workflow_draft_create',
      'workflow_draft_import',
      'workflow_draft_read',
      'workflow_draft_update',
      'workflow_draft_validate',
      'workflow_nodes_list',
      'workflow_publish',
      'workflow_run',
      'workflow_validate',
    ])
    expect(ctx.skills.definitions.get('workflow-builder')).toMatchObject({
      invocation: { modelInvocable: true, userInvocable: true },
      content: expect.stringContaining('workflow_nodes_list'),
    })
    const replayed = await ctx.dagWorkflowEngine.resume({ runId: run.id, parent }).result
    expect(replayed).toMatchObject({ status: 'completed', outputs: { answer: 'hello' } })
    expect(tools.requests).toHaveLength(1)

    await run.dispose()
    await plugin.dispose()
    expect(ctx.get('dagWorkflowEngine')).toBeUndefined()
    expect(ctx.get('workflowNodes')).toBeUndefined()
    expect(ctx.get('workflowCapabilities')).toBeUndefined()
    expect(ctx.get('workflowScripts')).toBeUndefined()
    expect(ctx.get('workflowTemplates')).toBeUndefined()
    expect(ctx.get('workflowRuns')).toBeUndefined()
    expect(tools.definitions).toEqual(new Map())
    expect(ctx.skills.definitions).toEqual(new Map())
  })

  it('executes the built-in web_search weekly-news DAG with implicit current-Agent delegation', async () => {
    const ctx = new Context()
    await mountRuntime(ctx)
    await ctx.plugin(DshWorkflowPlugin)
    const from = '2026-08-19T00:00:00+08:00'
    const to = '2026-08-25T23:59:59+08:00'
    const items = Array.from({ length: 100 }, (_, index) => {
      const publishedAt = `2026-08-${String(19 + (index % 7)).padStart(2, '0')}T${String(index % 24).padStart(2, '0')}:00:00+08:00`
      const url = `https://source.example/ai-model-${index}`
      return {
        id: url,
        title: `AI model item ${index}`,
        url,
        publishedAt,
        source: 'source.example',
        kind: (['release', 'research', 'news', 'analysis'] as const)[index % 4]!,
        summary: `Source-grounded summary ${index}`,
      }
    })
    const sources = [...items, ...Array.from({ length: 4 }, (_, index) => ({
      url: `https://source.example/extra-${index}`,
      title: `Extra result ${index}`,
      snippet: `Extra snippet ${index}`,
      publishedAt: from,
    }))]
    ctx.tools.handler = async input => {
      expect(input.name).toBe('web_search')
      expect(input.arguments.queries).toEqual(expect.arrayContaining([expect.any(String)]))
      expect(input.arguments.queries).toHaveLength(4)
      const requestIndex = ctx.tools.requests.indexOf(input)
      return {
        isError: false,
        value: {
          content: `Search batch ${requestIndex + 1}`,
          sources: sources.slice(requestIndex * 8, requestIndex * 8 + 8).map(item => ({
            url: item.url,
            title: item.title,
            snippet: 'summary' in item ? item.summary : item.snippet,
            publishedAt: item.publishedAt,
          })),
          truncated: true,
        },
      }
    }
    let childId = 0
    ctx.subagents.handler = async (_target, request) => {
      const marker = '\n\nWorkflow node inputs (JSON):\n'
      const markerIndex = request.prompt[0]?.text.indexOf(marker) ?? -1
      if (markerIndex < 0) throw new Error('missing workflow input marker')
      const inputs = JSON.parse(request.prompt[0]!.text.slice(markerIndex + marker.length)) as Record<string, unknown>
      let structured: unknown
      if (request.label === 'plan-weekly-ai-model-searches') {
        structured = { batches: Array.from({ length: 13 }, (_, index) => ({
          queries: Array.from({ length: 4 }, (_unused, query) => `AI model topic ${index}-${query} ${from} ${to}`),
        })) }
      } else if (request.label === 'normalize-weekly-ai-model-news') {
        structured = { items }
      } else if (request.label === 'score-weekly-ai-model-news') {
        const candidates = inputs.items as readonly { readonly id: string }[]
        structured = {
            scores: candidates.map((item, index) => ({
              id: item.id,
              importanceScore: (index * 37) % 101,
              importanceReason: `importance ${index}`,
            })),
        }
      } else {
        const candidates = inputs.items as readonly { readonly id: string }[]
        structured = {
            summaries: candidates.map((item, index) => ({
              id: item.id,
              digest: `摘要 ${index + 1}`,
            })),
        }
      }
      childId += 1
      return {
        id: `child-${childId}`,
        result: Promise.resolve({ output: [{ type: 'text', text: 'structured output' }], structured, stopReason: 'completed' }),
        async dispose() {},
      }
    }
    const workflow = parseWorkflowTemplate(readFileSync(new URL('../../../examples/weekly-ai-model-news.workflow.json', import.meta.url), 'utf8'))

    const result = await ctx.dagWorkflowEngine.start({
      template: workflow,
      inputs: { from, to },
      parent: { session: new StubSession() },
    }).result

    expect(result.status).toBe('completed')
    if (result.status !== 'completed') throw new Error(result.error)
    const outputs = result.outputs as {
      readonly period: { readonly from: string; readonly to: string }
      readonly candidateCount: number
      readonly items: readonly Record<string, JsonValue>[]
    }
    const expected = items.map((item, index) => ({
      ...item,
      importanceScore: (index * 37) % 101,
      importanceReason: `importance ${index}`,
    })).sort((left, right) =>
      right.importanceScore - left.importanceScore
      || right.publishedAt.localeCompare(left.publishedAt)
      || left.id.localeCompare(right.id),
    ).slice(0, 10)
    expect(outputs.period).toEqual({ from, to })
    expect(outputs.candidateCount).toBe(100)
    expect(outputs.items.map(item => item.id)).toEqual(expected.map(item => item.id))
    expect(outputs.items.map(item => item.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    for (const [index, item] of outputs.items.entries()) {
      expect(item).toEqual({ ...expected[index], rank: index + 1, digest: `摘要 ${index + 1}` })
    }
    expect(ctx.tools.requests).toHaveLength(13)
    expect(ctx.tools.requests.every(request => request.name === 'web_search')).toBe(true)
    expect(ctx.subagents.requests.every(args => args[0] === 'spawn')).toBe(true)
    expect(ctx.subagents.requests.map(args => args[1].label)).toEqual([
      'plan-weekly-ai-model-searches',
      'normalize-weekly-ai-model-news',
      'score-weekly-ai-model-news',
      'summarize-weekly-ai-model-news',
    ])
    const record = ctx.workflowRuns.loadRun(result.runId)
    expect(record?.checkpoint).toMatchObject({ status: 'completed' })
    expect(record?.checkpoint.nodeStates).toEqual(expect.objectContaining({
      'plan-searches': 'succeeded',
      'search-01': 'succeeded',
      'search-13': 'succeeded',
      'normalize-news': 'succeeded',
      'score-news': 'succeeded',
      'rank-top-10': 'succeeded',
      'summarize-top-10': 'succeeded',
      'finalize-top-10': 'succeeded',
    }))
  })

  it('supports the second extension level with a scoped custom Node capability', async () => {
    const ctx = new Context()
    await mountRuntime(ctx)
    const plugin = await ctx.plugin(DshWorkflowPlugin)
    const disposeCapability = ctx.workflowCapabilities.register('acme.jobs.execute', {
      async execute(value: string) { return `custom:${value}` },
    })
    const disposeNode = ctx.workflowNodes.register({
      type: 'acme.job', version: 1, title: 'Acme job', description: 'Custom lifecycle Node.',
      configSchema: { type: 'object', additionalProperties: false },
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['value'],
        properties: { value: { type: 'string' } },
      },
      outputSchema: {
        type: 'object', additionalProperties: false, required: ['value'],
        properties: { value: { type: 'string' } },
      },
      outputPorts: ['success'],
      capabilities: ['acme.jobs.execute'],
      retry: 'idempotent',
      async execute(execution) {
        const jobs = execution.capabilities.require<{ execute(value: string): Promise<string> }>('acme.jobs.execute')
        return { outputs: { value: await jobs.execute(String(execution.inputs.value)) } }
      },
    })
    const customTemplate: WorkflowTemplate = {
      apiVersion: 'dsh.workflow/v1alpha1', kind: 'WorkflowTemplate',
      metadata: { id: 'custom-node-dsh', name: 'Custom Node in DSH' },
      spec: {
        requires: [{ kind: 'capability', uses: 'acme.jobs.execute' }],
        inputSchema: {
          type: 'object', additionalProperties: false, required: ['value'],
          properties: { value: { type: 'string' } },
        },
        outputSchema: {
          type: 'object', additionalProperties: false, required: ['value'],
          properties: { value: { type: 'string' } },
        },
        nodes: [
          { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
          { id: 'custom', uses: 'acme.job@1', with: {}, inputs: { value: { input: 'value' } } },
          { id: 'end', uses: 'core.end@1', with: {}, inputs: { value: { output: { node: 'custom', path: ['value'] } } } },
        ],
        edges: [
          { id: 'start-custom', source: 'start', target: 'custom' },
          { id: 'custom-end', source: 'custom', target: 'end' },
        ],
        outputs: { value: { output: { node: 'end', path: ['value'] } } },
      },
    }

    const run = ctx.dagWorkflowEngine.start({
      template: customTemplate,
      inputs: { value: 'payload' },
      parent: { session: new StubSession() },
    })
    await expect(run.result).resolves.toMatchObject({ status: 'completed', outputs: { value: 'custom:payload' } })
    await run.dispose()
    disposeNode()
    disposeCapability()
    await plugin.dispose()
  })

  it('contains request observer failures without writing Session events', async () => {
    const ctx = new Context()
    await mountRuntime(ctx)
    await ctx.plugin(DshWorkflowPlugin)
    const session = new StubSession()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)

    const result = await ctx.dagWorkflowEngine.start({
      template: template(),
      inputs: { message: 'still-runs' },
      parent: { session },
      onEvent: () => { throw new Error('observer broke') },
    }).result

    expect(result.status).toBe('completed')
    expect(session.events).toEqual([])
    expect(warn.mock.calls.some(call => String(call[0]).includes('request observer failed'))).toBe(true)
  })

  it('cancels and drains active runs when the plugin is disposed', async () => {
    const ctx = new Context()
    await mountRuntime(ctx)
    const tools = ctx.tools
    tools.handler = input => new Promise<JsonValue>((_resolve, reject) => {
      input.signal.addEventListener('abort', () => { reject(new Error(String(input.signal.reason))) }, { once: true })
    }).then(value => ({ isError: false as const, value }))
    const plugin = await ctx.plugin(DshWorkflowPlugin)
    const run = ctx.dagWorkflowEngine.start({ template: template(), inputs: { message: 'wait' }, parent: { session: new StubSession() } })
    await vi.waitFor(() => { expect(tools.requests).toHaveLength(1) })

    await plugin.dispose()
    const result = await run.result

    expect(result.status).toBe('cancelled')
    expect(result).toMatchObject({ error: 'dag workflow service disposed' })
  })

  it('routes agent and approval nodes through their DSH capability seams', async () => {
    const ctx = new Context()
    await mountRuntime(ctx)
    await ctx.plugin(DshWorkflowPlugin)
    const parent: DshAgentLike = { session: new StubSession() }

    const result = await ctx.dagWorkflowEngine.start({ template: agentApprovalTemplate(), inputs: {}, parent }).result

    expect(result).toMatchObject({ status: 'completed', outputs: { answer: 'child answer', approved: true } })
    expect(ctx.subagents.requests).toHaveLength(1)
    expect(ctx.subagents.requests[0]).toEqual([
      'spawn',
      expect.objectContaining({
        parent,
        label: 'workflow child',
        prompt: [{ type: 'text', text: expect.stringContaining('"topic":"DSH"') }],
      }),
    ])
    expect(ctx.approval.requests).toHaveLength(1)
    expect(ctx.approval.requests[0]).toEqual(expect.objectContaining({
      agent: parent,
      toolName: 'publish-report',
      callId: expect.stringMatching(/:approve:approval$/),
      reason: expect.stringContaining('child answer'),
    }))
    const record = ctx.workflowRuns.loadRun(result.runId)
    expect(record?.events).toContainEqual(expect.objectContaining({ type: 'node.waiting', nodeId: 'approve' }))
  })

  it('executes fixed published subworkflows and durable foreach child invocations', async () => {
    const ctx = new Context()
    await mountRuntime(ctx)
    await ctx.plugin(DshWorkflowPlugin)
    const parent: DshAgentLike = { session: new StubSession() }
    for (const child of [childTemplate('nested-child'), childTemplate('item-worker', true)]) {
      const draft = ctx.workflowTemplates.createDraft(child)
      ctx.workflowTemplates.publish(draft.id, draft.revision)
    }

    const nested = await ctx.dagWorkflowEngine.start({
      template: nestedParentTemplate(),
      inputs: { message: 'nested value' },
      parent,
    }).result
    const mapped = await ctx.dagWorkflowEngine.start({
      template: foreachParentTemplate(),
      inputs: { items: ['alpha', 'beta', 'gamma'] },
      parent,
    }).result

    expect(nested).toMatchObject({ status: 'completed', outputs: { value: 'nested value' } })
    expect(mapped).toMatchObject({
      status: 'completed',
      outputs: {
        results: [
          { index: 0, outputs: { value: 'alpha' } },
          { index: 1, outputs: { value: 'beta' } },
          { index: 2, outputs: { value: 'gamma' } },
        ],
      },
    })
    if (mapped.status !== 'completed') throw new Error(mapped.error)
    for (const item of mapped.outputs.results as readonly { readonly runId: string }[]) {
      expect(ctx.workflowRuns.loadRun(item.runId)?.checkpoint).toMatchObject({ status: 'completed', depth: 1 })
    }
  })

  it('exposes the guarded authoring CRUD, validation, publish, and run tools', async () => {
    const ctx = new Context()
    await mountRuntime(ctx)
    await ctx.plugin(DshWorkflowPlugin)
    const parent: DshAgentLike = { session: new StubSession() }
    const execution = { agent: parent, signal: new AbortController().signal }
    const authored = childTemplate('tool-authored')
    const call = async (name: string, args: unknown) => {
      const definition = ctx.tools.definitions.get(name)
      if (definition === undefined) throw new Error(`missing ${name}`)
      return definition.execute(args, execution)
    }

    const nodes = await call('workflow_nodes_list', {})
    expect(nodes).toMatchObject({
      nodes: expect.arrayContaining([
        expect.objectContaining({ uses: 'core.foreach@1' }),
        expect.objectContaining({
          uses: 'core.script@1',
          defaultConfig: expect.objectContaining({ language: 'dsh.expr@1' }),
          dependencyKinds: ['script-runtime'],
          defaultRequirements: expect.arrayContaining([
            { kind: 'capability', uses: 'workflow.script.execute' },
            { kind: 'script-runtime', uses: 'dsh.expr@1' },
          ]),
        }),
      ]),
      scriptRuntimes: [expect.objectContaining({ uses: 'dsh.expr@1', deterministic: true })],
      agent: expect.objectContaining({
        mode: 'current',
        capabilities: expect.objectContaining({ outputSchema: true }),
        structuredOutputSchema: expect.objectContaining({ dialect: 'dsh.object-json-schema/v1' }),
      }),
    })
    const created = await call('workflow_draft_create', { template: authored })
    expect(created).toMatchObject({ id: 'tool-authored', revision: 1 })
    expect(await call('workflow_draft_read', { id: 'tool-authored' })).toEqual(created)
    const updatedTemplate = { ...authored, metadata: { ...authored.metadata, name: 'Updated through tool' } }
    const updated = await call('workflow_draft_update', { id: 'tool-authored', expectedRevision: 1, template: updatedTemplate })
    expect(updated).toMatchObject({ revision: 2, template: { metadata: { name: 'Updated through tool' } } })
    expect(await call('workflow_validate', { template: updatedTemplate })).toEqual({ diagnostics: [] })
    const importedTemplate = { ...updatedTemplate, metadata: { ...updatedTemplate.metadata, name: 'Imported JSON template' } }
    const imported = await call('workflow_draft_import', {
      expectedRevision: 2,
      templateJson: JSON.stringify(importedTemplate),
    })
    expect(imported).toMatchObject({ revision: 3, template: { metadata: { name: 'Imported JSON template' } } })
    expect(await call('workflow_draft_validate', { id: 'tool-authored' })).toEqual({ revision: 3, diagnostics: [] })
    expect(await call('workflow_diff', { id: 'tool-authored', candidate: importedTemplate })).toMatchObject({ semanticChanged: false })
    const published = await call('workflow_publish', { id: 'tool-authored', expectedRevision: 3 })
    expect(published).toMatchObject({ id: 'tool-authored', revision: 1 })
    expect(await call('workflow_run', { id: 'tool-authored', revision: 1, inputs: { message: 'from tool' } })).toMatchObject({
      status: 'completed',
      outputs: { value: 'from tool' },
    })
    await expect(call('workflow_run', { id: 'tool-authored', template: authored, inputs: {} })).rejects.toThrow(/exactly one/)
  })

  it('resolves secret bindings through a scoped Host callback and persists only the owner reference', async () => {
    const ctx = new Context()
    await mountRuntime(ctx)
    ctx.tools.handler = async () => ({ isError: false, value: { echo: 'credential accepted' } })
    const parent: DshAgentLike = { session: new StubSession() }
    const resolveSecret = vi.fn(async () => 'resolved-in-memory')
    await ctx.plugin(DshWorkflowPlugin, {
      resolveSecret,
      recovery: {
        reference: value => value === parent ? 'session:secret-owner' : 'session:other',
        async resolve() { return parent },
      },
    })
    const base = template()
    const secretTemplate = {
      ...base,
      spec: {
        ...base.spec,
        requires: [
          ...(base.spec.requires ?? []),
          { kind: 'capability', uses: 'workflow.secrets.resolve' },
          { kind: 'secret', uses: 'credential:report-api' },
        ],
        nodes: base.spec.nodes.map(node => node.id === 'echo'
          ? { ...node, inputs: { message: { secret: { ref: 'credential:report-api' } } } }
          : node),
      },
    } as WorkflowTemplate

    const result = await ctx.dagWorkflowEngine.start({ template: secretTemplate, inputs: { message: 'unused' }, parent }).result

    expect(result).toMatchObject({ status: 'completed', outputs: { answer: 'credential accepted' } })
    expect(resolveSecret).toHaveBeenCalledWith(expect.objectContaining({
      ref: 'credential:report-api', nodeId: 'echo', parent,
    }))
    const record = ctx.workflowRuns.loadRun(result.runId)
    expect(record?.ownerRef).toBe('session:secret-owner')
    expect(JSON.stringify(record)).not.toContain('resolved-in-memory')
  })

  it('auto-recovers only running records with a resolvable Host-owned Agent reference', async () => {
    const parent: DshAgentLike = { session: new StubSession() }
    const resume = vi.fn(() => ({
      id: 'run-owned', result: Promise.resolve({ status: 'completed' }), cancel() {}, async dispose() {},
    }))
    const warn = vi.fn()
    const records = [
      { runId: 'run-owned', ownerRef: 'session:1', checkpoint: { status: 'running' } },
      { runId: 'run-unowned', checkpoint: { status: 'running' } },
      { runId: 'run-paused', ownerRef: 'session:1', checkpoint: { status: 'paused' } },
    ] as unknown as readonly WorkflowRunRecord[]
    const fake = {
      workflowRuns: { listRecoverableRuns: () => records },
      dagWorkflowEngine: { resume },
      logger: { warn },
    } as unknown as Context
    const resolve = vi.fn(async (ownerRef: string) => ownerRef === 'session:1' ? parent : undefined)

    const started = await DshWorkflowPlugin.recoverPersistedWorkflowRuns(fake, {
      reference: () => 'session:1', resolve,
    }, new AbortController().signal)

    expect(started).toEqual(['run-owned'])
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-owned', parent }))
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('run-unowned'))
  })
})
