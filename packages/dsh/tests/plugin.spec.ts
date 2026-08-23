import { Context, Service } from '@deepseek-ai/cordis'
import type { JsonValue, WorkflowRunRecord, WorkflowTemplate } from '@gm-hz/dsh-workflow-core'
import { describe, expect, it, vi } from 'vitest'
import * as DshWorkflowPlugin from '../src/index.js'
import type {
  DshAgentLike,
  DshApprovalRuntimeLike,
  DshSkillRuntimeLike,
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

  constructor(ctx: Context) {
    super(ctx, 'subagents')
  }

  async start(...args: Parameters<DshSubagentRuntimeLike['start']>): ReturnType<DshSubagentRuntimeLike['start']> {
    this.requests.push(args)
    return {
      id: 'child-1',
      result: Promise.resolve({ output: [{ type: 'text', text: 'child answer' }], structured: { answer: 'child answer' }, stopReason: 'completed' }),
      async dispose() {},
    }
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
            provider: 'spawn',
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
    expect(session.events.map(event => event.type)).toEqual([
      'dsh-dag-workflow/run-start',
      'dsh-dag-workflow/node-start',
      'dsh-dag-workflow/node-end',
      'dsh-dag-workflow/node-start',
      'dsh-dag-workflow/node-end',
      'dsh-dag-workflow/node-start',
      'dsh-dag-workflow/node-end',
      'dsh-dag-workflow/run-end',
    ])
    expect(session.events[0]?.data).toEqual(expect.objectContaining({ templateId: 'dsh-plugin-test', semanticHash: expect.any(String) }))
    expect(ctx.workflowRuns.loadRun(run.id)?.checkpoint.status).toBe('completed')
    expect([...tools.definitions.keys()].sort()).toEqual([
      'workflow_diff',
      'workflow_draft_create',
      'workflow_draft_read',
      'workflow_draft_update',
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
    expect(ctx.get('workflowTemplates')).toBeUndefined()
    expect(ctx.get('workflowRuns')).toBeUndefined()
    expect(tools.definitions).toEqual(new Map())
    expect(ctx.skills.definitions).toEqual(new Map())
  })

  it('contains Session recording and request observer failures', async () => {
    const ctx = new Context()
    await mountRuntime(ctx)
    await ctx.plugin(DshWorkflowPlugin)
    const session = new StubSession()
    session.fail = true
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)

    const result = await ctx.dagWorkflowEngine.start({
      template: template(),
      inputs: { message: 'still-runs' },
      parent: { session },
      onEvent: () => { throw new Error('observer broke') },
    }).result

    expect(result.status).toBe('completed')
    expect(warn.mock.calls.some(call => String(call[0]).includes('disabled Session recording'))).toBe(true)
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
    expect(result).toMatchObject({ error: 'dag workflow provider disposed' })
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
    expect(nodes).toMatchObject({ nodes: expect.arrayContaining([expect.objectContaining({ uses: 'core.foreach@1' })]) })
    const created = await call('workflow_draft_create', { template: authored })
    expect(created).toMatchObject({ id: 'tool-authored', revision: 1 })
    expect(await call('workflow_draft_read', { id: 'tool-authored' })).toEqual(created)
    const updatedTemplate = { ...authored, metadata: { ...authored.metadata, name: 'Updated through tool' } }
    const updated = await call('workflow_draft_update', { id: 'tool-authored', expectedRevision: 1, template: updatedTemplate })
    expect(updated).toMatchObject({ revision: 2, template: { metadata: { name: 'Updated through tool' } } })
    expect(await call('workflow_validate', { template: updatedTemplate })).toEqual({ diagnostics: [] })
    expect(await call('workflow_diff', { id: 'tool-authored', candidate: updatedTemplate })).toMatchObject({ semanticChanged: false })
    const published = await call('workflow_publish', { id: 'tool-authored', expectedRevision: 2 })
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
