import { Context, Service } from '@deepseek-ai/cordis'
import type { WorkflowTemplate } from '../../src/core/index.js'
import * as DshWorkflow from '../../src/adapters/dsh/index.js'
import { createDshCanvasSchedules } from '../../src/adapters/dsh/schedules.js'
import { CRON_TRIGGER_DEFINITION, InMemoryWorkflowCronStore } from '../../src/triggers/cron/index.js'
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
import { toolWorkflowTemplate } from '../core/fixtures.js'

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
  private readonly hidden = new Map<unknown, string>()
  constructor(ctx: Context) { super(ctx, 'tools') }
  async execute(input: DshToolRuntimeInput): Promise<DshToolRuntimeResult> {
    const definition = this.definitions.get(input.name)
    if (definition === undefined) return { isError: false, value: null }
    return { isError: false, value: await definition.execute(input.arguments, input) }
  }
  register(definition: DshWorkflowToolDefinition): () => void {
    this.definitions.set(definition.name, definition)
    return () => { this.definitions.delete(definition.name) }
  }
  hide(scope: unknown, name: string): void { this.hidden.set(scope, name) }
  schemas(scope?: unknown) {
    return [...this.definitions.values()]
      .filter(definition => this.hidden.get(scope) !== definition.name)
      .map(({ name, description, parameters }) => ({ name, description, parameters }))
  }
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
    apiVersion: 'workflow.gm-hz.dev/v1',
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
  it('shows the scoped host context and launches a bound schedule trial exactly once without advancing the clock', async () => {
    const ctx = await runtime()
    const owner = { id: 'schedule-owner', session: new Session() }
    const other = { id: 'schedule-other', session: new Session() }
    ctx.agents.register(owner.id, owner)
    ctx.agents.register(other.id, other)
    const authorityRef = ctx.dagWorkflowEngine.authorityRefFor!(owner)!
    const draft = await ctx.workflowTemplates.createDraft(workflow())
    const revision = await ctx.workflowTemplates.publish(draft.id, draft.revision)
    ctx.workflowTriggers.register(CRON_TRIGGER_DEFINITION)
    const binding = await ctx.workflowBindings.publish({
      apiVersion: 'workflow.gm-hz.dev/v1', kind: 'WorkflowBinding', metadata: { id: 'scheduled-echo' },
      spec: { workflow: { id: revision.id, revision: revision.revision }, authorityRef,
        trigger: { uses: 'cron@1', with: { expression: '0 9 * * *', timezone: 'Asia/Shanghai' } },
        inputMapping: { message: { literal: 'run with fixed schedule input' } }, deliveryRef: 'private:delivery' },
    }, 0)
    const store = new InMemoryWorkflowCronStore()
    const lastTickAt = 1_797_300_000_000
    const prior = { bindingId: binding.metadata.id, bindingRevision: binding.metadata.revision, generation: 1,
      checkedThrough: lastTickAt, lastTickAt, activeRunIds: [], last: {
        scheduledAt: lastTickAt, status: 'rejected' as const, manual: false, reasonCode: 'INGRESS_WORKFLOW_INPUT_INVALID',
      },
    }
    await store.save(prior, 0)
    await ctx.plugin(CanvasPlugin, { bindings: ctx.workflowBindings, schedules: createDshCanvasSchedules(ctx, store), storage: { kind: 'memory' } })
    await expect(ctx.workflowCanvas.context(owner.id)).resolves.toEqual({ sessionId: owner.id, authorityRef, storage: { kind: 'memory' } })
    await expect(ctx.workflowCanvas.starterOrders(owner.id)).resolves.toMatchObject({
      template: { metadata: { id: 'script-transform-demo' } }, inputs: { orders: expect.any(Array) },
    })
    await expect(ctx.workflowCanvas.operations(owner.id, {})).resolves.toMatchObject({ bindings: [{ schedule: {
      nextRunAt: expect.any(Number), lastTickAt, lastDecision: { status: 'rejected', reasonCode: 'INGRESS_WORKFLOW_INPUT_INVALID' },
    } }] })
    await expect(ctx.workflowCanvas.operations(other.id, {})).resolves.toMatchObject({ bindings: [] })
    const request = { id: binding.metadata.id, revision: binding.metadata.revision, requestId: 'trial-request-test-001', requestedAt: lastTickAt }
    await expect(ctx.workflowCanvas.runSchedule(other.id, request)).rejects.toThrow(/access denied/)
    const [first, second] = await Promise.all([ctx.workflowCanvas.runSchedule(owner.id, request), ctx.workflowCanvas.runSchedule(owner.id, request)])
    expect(first).toMatchObject({ status: 'launched', runId: expect.any(String) })
    expect(second).toEqual(first)
    await vi.waitFor(async () => expect(await ctx.workflowCanvas.trace(owner.id, { runId: first.runId! })).toMatchObject({
      status: 'completed', origin: { type: 'trigger', source: 'cron-trial', sourceRef: 'scheduled-echo@1' },
      outputs: { message: 'run with fixed schedule input' },
    }))
    expect(await store.get(binding.metadata.id)).toEqual(prior)
    expect((await ctx.workflowRuns.getRunMetadata(first.runId!))?.launch.deliveryRef).toBeUndefined()
    await ctx.workflowBindings.publish({ ...binding, metadata: { id: binding.metadata.id }, spec: { ...binding.spec, enabled: false } }, 1)
    await expect(ctx.workflowCanvas.runSchedule(owner.id, request)).rejects.toThrow(/revision changed/)
  })

  it('acknowledges a published run before the Tool finishes, deduplicates the receipt, and exposes frozen inputs', async () => {
    const ctx = await runtime()
    const agent = { id: 'admit-run', session: new Session() }
    const other = { id: 'admit-other', session: new Session() }
    ctx.agents.register(agent.id, agent)
    ctx.agents.register(other.id, other)
    let finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    const output = 'x'.repeat(7000)
    const execute = vi.fn(async () => { await gate; return { echo: output } })
    ctx.tools.register({ name: 'echo', description: 'Echo', parameters: { type: 'object' },
      output: { schema: { type: 'object' }, render: () => [] }, execute })
    await ctx.plugin(CanvasPlugin.WorkflowCanvasGateway)
    const template = structuredClone(toolWorkflowTemplate()) as unknown as CanvasWorkflowTemplate
    const draft = await ctx.workflowCanvas.createDraft(agent.id, { template })
    const published = await ctx.workflowCanvas.publish(agent.id, { id: draft.id, expectedRevision: draft.revision })
    const later = await ctx.workflowCanvas.updateDraft(agent.id, {
      id: draft.id, expectedRevision: draft.revision, template: { ...template, metadata: { ...template.metadata, name: 'new draft name' } },
    })
    await ctx.workflowCanvas.publish(agent.id, { id: draft.id, expectedRevision: later.revision })
    expect(await ctx.workflowCanvas.revisions(agent.id, { id: draft.id, limit: 1 })).toMatchObject({ items: [{ revision: 2 }], nextBefore: 2 })
    expect(await ctx.workflowCanvas.revisions(agent.id, { id: draft.id, before: 2 })).toMatchObject({ items: [{ revision: 1 }] })
    const request = { target: { type: 'published' as const, id: published.id, revision: 1 }, inputs: { message: 'durable' }, requestId: 'resume-safe' }
    try {
      const receipt = await ctx.workflowCanvas.startRun(agent.id, request)
      expect(receipt.status).toBe('accepted')
      expect(await ctx.workflowCanvas.startRun(agent.id, request)).toEqual(receipt)
      await expect(ctx.workflowCanvas.startRun(agent.id, { ...request, inputs: { message: 'different' } })).rejects.toThrow(/idempotency key/)
      await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
      expect(await ctx.workflowCanvas.trace(agent.id, { runId: receipt.runId })).toMatchObject({ status: 'running', active: true })
      const details = await ctx.workflowCanvas.runDetails(agent.id, { runId: receipt.runId })
      expect(details).toMatchObject({ revision: 1, template: { metadata: { name: 'Tool flow' } }, inputs: { message: 'durable' }, nodeInputs: { call: { message: 'durable' } } })
      await expect(ctx.workflowCanvas.runDetails(other.id, { runId: receipt.runId })).rejects.toThrow(/access denied/)
      finish()
      await vi.waitFor(async () => expect(await ctx.workflowCanvas.trace(agent.id, { runId: receipt.runId })).toMatchObject({ status: 'completed', outputs: { answer: output } }))
      const fullPage = await ctx.workflowCanvas.trace(agent.id, { runId: receipt.runId, limit: 2 })
      const journalPage = await ctx.workflowCanvas.trace(agent.id, { runId: receipt.runId, limit: 2, eventsOnly: true })
      expect(journalPage.events).toEqual(fullPage.events)
      expect(Buffer.byteLength(JSON.stringify(journalPage))).toBeLessThan(Buffer.byteLength(JSON.stringify(fullPage)) / 4)
      await expect(ctx.workflowCanvas.listRuns(agent.id, { revision: 1, query: 'tool FLOW', origin: 'dsh' })).resolves.toMatchObject({ items: [{ runId: receipt.runId }] })
      expect(execute).toHaveBeenCalledTimes(1)
    } finally { finish() }
  })

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
    const firstPage = await ctx.workflowCanvas.trace(agent.id, { runId: result.runId, limit: 2 })
    const trace = await ctx.workflowCanvas.trace(agent.id, { runId: result.runId, afterSeq: firstPage.nextAfterSeq!, limit: 100 })
    const snapshot = await ctx.workflowCanvas.trace(agent.id, { runId: result.runId, throughSeq: 4, limit: 10 })
    const eventsPage = await ctx.workflowCanvas.trace(agent.id, { runId: result.runId, throughSeq: 4, limit: 10, eventsOnly: true })

    expect(result).toMatchObject({ status: 'completed', outputs: { message: 'first success' } })
    expect(trace.nodeStates).toEqual({ start: 'succeeded', end: 'succeeded' })
    expect(trace.outputs).toEqual({ message: 'first success' })
    expect(firstPage.events).toHaveLength(2)
    expect(firstPage.nextAfterSeq).toBe(2)
    expect(snapshot.events.map(event => event.seq)).toEqual([1, 2, 3, 4])
    expect(eventsPage).toMatchObject({ events: snapshot.events, nodeStates: {}, nodeOutputs: {}, edgeStates: {}, nodeProgress: {} })
    expect(eventsPage).not.toHaveProperty('outputs')
    expect(snapshot.nextAfterSeq).toBeUndefined()
    expect([...firstPage.events, ...trace.events].map(event => event.type)).toEqual(expect.arrayContaining(['run.started', 'node.completed', 'run.completed']))
    await expect(ctx.workflowCanvas.listRuns(agent.id, { status: 'completed' })).resolves.toEqual({
      items: [expect.objectContaining({ runId: result.runId, templateId: template.metadata.id, checkpointSeq: trace.checkpointSeq, needsAttention: false })],
    })

    const attacker = { id: 'other-session', session: new Session() }
    ctx.agents.register(attacker.id, attacker)
    await expect(ctx.workflowCanvas.trace(attacker.id, { runId: result.runId })).rejects.toThrow(/access denied/)
    await expect(ctx.workflowCanvas.listRuns(attacker.id, {})).resolves.toEqual({ items: [] })
  })

  it('preflights input and scoped tools for draft and published runs without starting invalid runs', async () => {
    const ctx = await runtime()
    const owner = { id: 'ready-session', session: new Session() }
    const restricted = { id: 'restricted-session', session: new Session() }
    ctx.agents.register(owner.id, owner)
    ctx.agents.register(restricted.id, restricted)
    const executeEcho = vi.fn(async () => ({ echo: 'ready' }))
    ctx.tools.register({
      name: 'echo', description: 'Echo the message.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['message'],
        properties: { message: { type: 'string' } },
      },
      output: { schema: { type: 'object' }, render: () => [] },
      execute: executeEcho,
    })
    ctx.tools.hide(restricted, 'echo')
    await ctx.plugin(CanvasPlugin.WorkflowCanvasGateway)
    const start = vi.spyOn(ctx.dagWorkflowEngine, 'start')
    const template = structuredClone(toolWorkflowTemplate()) as unknown as CanvasWorkflowTemplate
    const signal = new AbortController().signal
    const validInputs = { message: 'ready' }
    const draft = await ctx.workflowCanvas.createDraft(owner.id, { template })
    const published = await ctx.workflowCanvas.publish(owner.id, { id: draft.id, expectedRevision: draft.revision })
    const publishedRun = { id: published.id, revision: published.revision }

    await expect(ctx.workflowCanvas.validate(restricted.id, { template })).resolves.toEqual({ diagnostics: [] })
    await expect(ctx.workflowCanvas.validate(owner.id, { template, inputs: validInputs })).resolves.toEqual({ diagnostics: [] })
    await expect(ctx.workflowCanvas.validate(owner.id, { template, inputs: {} })).resolves.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'WORKFLOW_INPUT_INVALID', severity: 'error' })],
    })
    await expect(ctx.workflowCanvas.validate(restricted.id, { template, inputs: validInputs })).resolves.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'WORKFLOW_TOOL_UNAVAILABLE', severity: 'error' })],
    })
    await expect(ctx.workflowCanvas.runDraft(owner.id, { template, inputs: {} }, signal))
      .rejects.toThrow(/WORKFLOW_INPUT_INVALID.*message/)
    await expect(ctx.workflowCanvas.run(restricted.id, { ...publishedRun, inputs: validInputs }, signal))
      .rejects.toThrow(/WORKFLOW_TOOL_UNAVAILABLE.*echo/)
    expect(start).not.toHaveBeenCalled()
    expect(executeEcho).not.toHaveBeenCalled()

    await expect(ctx.workflowCanvas.run(owner.id, { ...publishedRun, inputs: validInputs }, signal)).resolves.toMatchObject({
      status: 'completed', outputs: { answer: 'ready' },
    })
    expect(executeEcho).toHaveBeenCalledTimes(1)
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
    await expect(ctx.workflowCanvas.listRuns(agent.id, { templateId: published.id })).resolves.toMatchObject({
      items: [{ runId: result.runId, revision: published.revision }],
    })

    expect(result).toMatchObject({ status: 'completed', outputs: { message: 'through remote' } })
    expect(trace.status).toBe('completed')
    expect(trace.events.map(event => event.type)).toContain('checkpoint.committed')
    expect(actions).toEqual(['nodes:list', 'draft:create', 'draft:validate', 'draft:publish', 'run:start', 'run:trace', 'run:list'])
    expect(authorize).toHaveBeenLastCalledWith({ sessionId: agent.id, agent, action: 'run:list', resourceId: published.id })
  })

  it('scopes operations to the calling session and projects summaries without raw delivery or ingress data', async () => {
    const ctx = await runtime()
    const agent = { id: 'operations-session', session: new Session() }
    const other = { id: 'operations-other-session', session: new Session() }
    ctx.agents.register(agent.id, agent)
    ctx.agents.register(other.id, other)
    const authorityRef = ctx.dagWorkflowEngine.authorityRefFor!(agent)!
    const otherAuthorityRef = ctx.dagWorkflowEngine.authorityRefFor!(other)!
    const [owned, unowned] = await Promise.all([agent, other].map(parent => ctx.dagWorkflowEngine.start({
      parent, template: workflow(), inputs: { message: 'Operations Run' },
    })))
    await Promise.all([owned!.result, unowned!.result])
    const binding = {
      apiVersion: 'workflow.gm-hz.dev/v1' as const,
      kind: 'WorkflowBinding' as const,
      metadata: { id: 'dingtalk-weekly', revision: 2 },
      spec: {
        workflow: { id: 'ai-weekly', revision: 4 },
        trigger: { uses: 'dingtalk.message@1', with: { credentialRef: 'private-config' } },
        inputMapping: { text: { literal: 'private-input' } }, authorityRef, deliveryRef: 'dingtalk:private-destination',
      },
    }
    const currentBinding = { ...binding, metadata: { ...binding.metadata, revision: 3 }, spec: { ...binding.spec, authorityRef: otherAuthorityRef } }
    const ownBinding = { ...binding, metadata: { id: 'owner-binding', revision: 1 } }
    const envelope = {
      schemaVersion: 1 as const, triggerId: 'trigger-2', source: 'dingtalk', sourceEventId: 'event-9',
      receivedAt: 101, payload: { text: 'private-event' }, metadata: { principal: 'private-principal' },
    }
    const ingress = {
      triggerId: 'trigger-2', dedupeKey: 'dingtalk:event-9', binding: binding.metadata,
      source: 'dingtalk', sourceEventId: 'event-9', status: 'launched' as const,
      runId: owned!.id, receivedAt: 101, envelope, duplicateCount: 2,
    }
    const delivery = {
      invocationId: 'delivery-compare', runId: owned!.id, deliveryRef: 'dingtalk:private-destination',
      phase: 'terminal' as const, payload: { result: 'private-delivery' }, status: 'unknown' as const, attempts: 2, updatedAt: 109,
      error: 'private-error-details',
    }
    const authorize = vi.fn(request => ({ subject: 'operator', agent: request.agent }))
    const listBindings = vi.fn(async () => [currentBinding, ownBinding])
    const listIngress = vi.fn(async () => [ingress, { ...ingress, triggerId: 'other-trigger', runId: unowned!.id, binding: currentBinding.metadata }])
    const listDeliveries = vi.fn(async () => [delivery, { ...delivery, invocationId: 'other-delivery', runId: unowned!.id }])
    await ctx.plugin(CanvasPlugin, {
      authorize,
      bindings: { list: listBindings, get: async (_id: string, revision: number) => revision === 2 ? binding : currentBinding },
      ingress: { list: listIngress },
      delivery: { listAttention: listDeliveries },
    })

    await expect(ctx.workflowCanvas.operations(agent.id, { limit: 20 })).resolves.toEqual({
      bindings: [{ metadata: ownBinding.metadata, spec: { workflow: binding.spec.workflow, trigger: { uses: binding.spec.trigger.uses }, enabled: true } }],
      ingress: [{ triggerId: 'trigger-2', binding: binding.metadata, source: 'dingtalk', sourceEventId: 'event-9',
        status: 'launched', runId: owned!.id, receivedAt: 101, duplicateCount: 2 }],
      deliveryAttention: [{ invocationId: 'delivery-compare', runId: owned!.id, phase: 'terminal', status: 'unknown', attempts: 2, updatedAt: 109 }],
    })
    expect(authorize.mock.calls.map(([request]) => request.action)).toEqual(['bindings:list', 'ingress:list', 'delivery:list'])
    expect(listBindings).toHaveBeenCalledWith({ authorityRef, limit: 20, latestOnly: true })
    expect(listIngress).toHaveBeenCalledWith({ authorityRef, limit: 20 })
    expect(listDeliveries).toHaveBeenCalledWith({ authorityRef, limit: 20 })
    const otherRows = await ctx.workflowCanvas.operations(other.id, {})
    expect(otherRows.bindings.map(item => item.metadata)).toEqual([currentBinding.metadata])
    expect(otherRows.ingress.map(item => item.triggerId)).toEqual(['other-trigger'])
    expect(otherRows.deliveryAttention.map(item => item.invocationId)).toEqual(['other-delivery'])
    await expect(ctx.workflowCanvas.trace(other.id, { runId: owned!.id })).rejects.toThrow(/access denied/)
    await expect(ctx.workflowCanvas.exportCase(other.id, { runId: owned!.id })).rejects.toThrow(/access denied/)
    await expect(ctx.workflowCanvas.exportEvidence(other.id, { runId: owned!.id })).rejects.toThrow(/access denied/)
    await expect(ctx.workflowCanvas.exportCase(agent.id, { runId: owned!.id })).resolves.toMatchObject({
      format: 'agent-dag-workflow.case/v1', source: { runId: owned!.id }, expected: { status: 'completed' },
    })
    await expect(ctx.workflowCanvas.exportEvidence(agent.id, { runId: owned!.id, redactFields: ['message'] })).resolves.toMatchObject({
      format: 'agent-dag-workflow.evidence/v1', run: { inputs: { message: '[REDACTED]' } }, sha256: expect.any(String),
    })
  })
})
