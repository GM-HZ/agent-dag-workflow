import { Context, Service } from '@deepseek-ai/cordis'
import type { WorkflowTemplate } from '../../src/core/index.js'
import * as DshWorkflow from '../../src/adapters/dsh/index.js'
import type {
  DshApprovalRuntimeLike,
  DshSkillRuntimeLike,
  DshSubagentRuntimeLike,
  DshToolRuntimeInput,
  DshToolRuntimeResult,
  DshWorkflowToolDefinition,
} from '../../src/adapters/dsh/index.js'
import { describe, expect, it, vi } from 'vitest'
import { starterTemplate } from '../../src/canvas/client/ux.js'
import type { CanvasWorkflowTemplate, WorkflowCanvasAction } from '../../src/canvas/types.js'

// Canvas host decorators are lowered by the production TypeScript build.
// An indirect specifier keeps clean typechecking independent from lib/.
const builtCanvasHost = '../../lib/canvas/index.js'
const CanvasPlugin = await import(builtCanvasHost)

declare module '@deepseek-ai/cordis' {
  interface Context {
    tools: StubTools
    subagents: StubSubagents
    approval: StubApproval
    skills: StubSkills
    agents: StubAgents
  }
}

class StubTools extends Service {
  private readonly definitions = new Map<string, DshWorkflowToolDefinition>()
  constructor(ctx: Context) { super(ctx, 'tools') }
  async execute(_input: DshToolRuntimeInput): Promise<DshToolRuntimeResult> { return { isError: false, value: null } }
  register(definition: DshWorkflowToolDefinition): () => void {
    this.definitions.set(definition.name, definition)
    return () => { this.definitions.delete(definition.name) }
  }
  schemas() { return [...this.definitions.values()].map(({ name, description, parameters }) => ({ name, description, parameters })) }
}

class StubSubagents extends Service implements DshSubagentRuntimeLike {
  constructor(ctx: Context) { super(ctx, 'subagents') }
  list(): readonly string[] { return ['spawn'] }
  getProvider(name: string) {
    return name === 'spawn'
      ? { capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true } }
      : undefined
  }
  async start(): ReturnType<DshSubagentRuntimeLike['start']> { throw new Error('not used') }
}

class StubApproval extends Service implements DshApprovalRuntimeLike {
  constructor(ctx: Context) { super(ctx, 'approval') }
  async request(): ReturnType<DshApprovalRuntimeLike['request']> { return 'allowed-once' }
}

class StubSkills extends Service implements DshSkillRuntimeLike {
  constructor(ctx: Context) { super(ctx, 'skills') }
  register(_skill: Parameters<DshSkillRuntimeLike['register']>[0]): () => void { return () => {} }
}

class StubAgents extends Service {
  private readonly values = new Map<string, unknown>()
  constructor(ctx: Context) { super(ctx, 'agents') }
  get(id: string): unknown { return this.values.get(id) }
  register(id: string, agent: unknown): void { this.values.set(id, agent) }
}

class Session {
  readonly entries: { readonly type: string; readonly data: unknown }[] = []
  append(type: string, data: unknown): void { this.entries.push({ type, data }) }
}

function workflow(): WorkflowTemplate {
  return {
    apiVersion: 'workflow.gm-hz.dev/v1alpha1',
    kind: 'WorkflowTemplate',
    metadata: { id: 'canvas-host-test', name: 'Canvas host test' },
    spec: {
      inputSchema: { type: 'object', additionalProperties: false, required: ['message'], properties: { message: { type: 'string' } } },
      outputSchema: { type: 'object', additionalProperties: false, required: ['message'], properties: { message: { type: 'string' } } },
      nodes: [
        { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
        { id: 'end', uses: 'core.end@1', with: {}, inputs: { message: { input: { path: ['message'] } } } },
      ],
      edges: [{ id: 'start-end', source: 'start', target: 'end' }],
      outputs: { message: { output: { nodeId: 'end', path: ['message'] } } },
    },
  }
}

async function runtime(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(StubTools)
  await ctx.plugin(StubSubagents)
  await ctx.plugin(StubApproval)
  await ctx.plugin(StubSkills)
  await ctx.plugin(StubAgents)
  await ctx.plugin(DshWorkflow)
  return ctx
}

describe('workflow canvas Host gateway', () => {
  it('validates and runs the first-use starter through the real DAG engine', async () => {
    const ctx = await runtime()
    const agent = { id: 'starter-session', session: new Session() }
    ctx.agents.register(agent.id, agent)
    await ctx.plugin(CanvasPlugin.WorkflowCanvasGateway)
    const template = starterTemplate(101)

    await expect(ctx.workflowCanvas.validate(agent.id, { template })).resolves.toEqual({ diagnostics: [] })
    const result = await ctx.workflowCanvas.runDraft(agent.id, {
      template, inputs: { message: 'first success' },
    }, new AbortController().signal)
    const trace = await ctx.workflowCanvas.trace(agent.id, { runId: result.runId })

    expect(result).toMatchObject({ status: 'completed', outputs: { message: 'first success' } })
    expect(trace.nodeStates).toEqual({ start: 'succeeded', end: 'succeeded' })
    expect(trace.events.map(event => event.type)).toEqual(expect.arrayContaining(['run.started', 'node.completed', 'run.completed']))
  })

  it('uses the local-profile authorization boundary when the gateway receives no config', async () => {
    const ctx = await runtime()
    const agent = { id: 'session-default-config', session: new Session() }
    ctx.agents.register(agent.id, agent)

    await ctx.plugin(CanvasPlugin.WorkflowCanvasGateway)

    await expect(ctx.workflowCanvas.nodes(agent.id)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ uses: 'core.start@1' })]),
    )
  })

  it('uses the resolved Agent scope by default and supports stricter policy denial', async () => {
    const ctx = await runtime()
    const agent = { id: 'session-1', session: new Session() }
    ctx.agents.register(agent.id, agent)
    ctx.tools.register({
      name: 'dms.query',
      description: 'Queries DMS through its own authorization policy.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['sql'],
        properties: { sql: { type: 'string' } },
      },
      output: { schema: { type: 'array' }, render: () => [] },
      async execute() { return [] },
    })
    const defaultPlugin = await ctx.plugin(CanvasPlugin)
    expect((await ctx.workflowCanvas.nodes(agent.id)).map(node => node.uses)).toContain('core.start@1')
    expect(await ctx.workflowCanvas.nodes(agent.id)).toContainEqual(expect.objectContaining({
      uses: 'core.script@1',
      defaultConfig: expect.objectContaining({ language: 'json.expr@1' }),
      dependencyKinds: ['script-runtime'],
      defaultRequirements: expect.arrayContaining([
        { kind: 'capability', uses: 'workflow.script.execute' },
        { kind: 'script-runtime', uses: 'json.expr@1' },
      ]),
    }))
    expect(await ctx.workflowCanvas.nodes(agent.id)).toContainEqual(expect.objectContaining({
      catalogId: 'tool:dms.query',
      kind: 'tool',
      uses: 'tool.call@1',
      toolName: 'dms.query',
      defaultConfig: { uses: 'dms.query' },
      defaultRequirements: [
        { kind: 'capability', uses: 'gateway.tool.execute' },
        { kind: 'tool', uses: 'dms.query' },
      ],
    }))
    await defaultPlugin.dispose()
    await ctx.plugin(CanvasPlugin, { authorize: () => undefined })
    await expect(ctx.workflowCanvas.nodes(agent.id)).rejects.toThrow(/access denied/)
  })

  it('guards every operation and exposes draft, publish, run, and persisted trace', async () => {
    const ctx = await runtime()
    const session = new Session()
    const agent = { id: 'session-1', session }
    ctx.agents.register(agent.id, agent)
    const actions: WorkflowCanvasAction[] = []
    const authorize = vi.fn(request => {
      actions.push(request.action)
      return request.agent === agent ? { subject: 'user-1', agent } : undefined
    })
    await ctx.plugin(CanvasPlugin, { authorize })

    const wireTemplate = structuredClone(workflow()) as unknown as CanvasWorkflowTemplate
    expect((await ctx.workflowCanvas.nodes(agent.id)).map(node => node.uses)).toContain('core.start@1')
    const draft = await ctx.workflowCanvas.createDraft(agent.id, { template: wireTemplate })
    expect((await ctx.workflowCanvas.validate(agent.id, { template: wireTemplate })).diagnostics).toEqual([])
    const published = await ctx.workflowCanvas.publish(agent.id, { id: draft.id, expectedRevision: draft.revision })
    const result = await ctx.workflowCanvas.run(agent.id, {
      id: published.id,
      revision: published.revision,
      inputs: { message: 'through remote' },
    }, new AbortController().signal)
    const trace = await ctx.workflowCanvas.trace(agent.id, { runId: result.runId })

    expect(result).toMatchObject({ status: 'completed', outputs: { message: 'through remote' } })
    expect(trace.status).toBe('completed')
    expect(trace.events.map(event => event.type)).toContain('checkpoint.committed')
    expect(actions).toEqual(['nodes:list', 'draft:create', 'draft:validate', 'draft:publish', 'run:start', 'run:trace'])
    expect(authorize).toHaveBeenLastCalledWith({ sessionId: agent.id, agent, action: 'run:trace', resourceId: result.runId })
  })

  it('exposes trigger bindings, duplicate ingress audit, and uncertain deliveries through the operations surface', async () => {
    const ctx = await runtime()
    const agent = { id: 'operations-session', session: new Session() }
    ctx.agents.register(agent.id, agent)
    const binding = {
      apiVersion: 'workflow.gm-hz.dev/v1alpha1' as const,
      kind: 'WorkflowBinding' as const,
      metadata: { id: 'dingtalk-weekly', revision: 2 },
      spec: {
        workflow: { id: 'ai-weekly', revision: 4 },
        trigger: { uses: 'dingtalk.message@1', with: {} },
        inputMapping: {}, authorityRef: 'principal:weekly', deliveryRef: 'dingtalk:conversation-1',
      },
    }
    const envelope = {
      schemaVersion: 1 as const, triggerId: 'trigger-2', source: 'dingtalk', sourceEventId: 'event-9',
      receivedAt: 101, payload: {},
    }
    const ingress = {
      triggerId: 'trigger-2', dedupeKey: 'dingtalk:event-9', binding: binding.metadata,
      source: 'dingtalk', sourceEventId: 'event-9', status: 'launched' as const,
      runId: 'run-operations', receivedAt: 101, envelope, duplicateCount: 2,
    }
    const delivery = {
      invocationId: 'run-operations:dingtalk:terminal', runId: 'run-operations', deliveryRef: 'dingtalk:conversation-1',
      phase: 'terminal' as const, payload: {}, status: 'unknown' as const, attempts: 2, updatedAt: 109,
      error: 'connection reset',
    }
    const authorize = vi.fn(request => ({ subject: 'operator', agent: request.agent }))
    await ctx.plugin(CanvasPlugin, {
      authorize,
      bindings: { list: async () => [binding] },
      ingress: { list: async () => [ingress] },
      delivery: { listAttention: async () => [delivery] },
    })

    await expect(ctx.workflowCanvas.operations(agent.id, { limit: 20 })).resolves.toEqual({
      bindings: [binding], ingress: [ingress], deliveryAttention: [delivery],
    })
    expect(authorize.mock.calls.map(([request]) => request.action)).toEqual(['bindings:list', 'ingress:list', 'delivery:list'])
  })
})
