import { Context, Service } from '@deepseek-ai/cordis'
import type { JsonValue, WorkflowTemplate } from '@gm-hz/dsh-workflow-core'
import { describe, expect, it, vi } from 'vitest'
import * as DshWorkflowPlugin from '../src/index.js'
import type {
  DshAgentLike,
  DshApprovalRuntimeLike,
  DshSubagentRuntimeLike,
  DshToolRuntimeInput,
  DshToolRuntimeResult,
} from '../src/index.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tools: StubToolRuntime
    subagents: StubSubagentRuntime
    approval: StubApprovalRuntime
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

async function mountRuntime(ctx: Context): Promise<void> {
  await ctx.plugin(StubToolRuntime)
  await ctx.plugin(StubSubagentRuntime)
  await ctx.plugin(StubApprovalRuntime)
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
      'core.start@1',
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
    const replayed = await ctx.dagWorkflowEngine.resume({ runId: run.id, parent }).result
    expect(replayed).toMatchObject({ status: 'completed', outputs: { answer: 'hello' } })
    expect(tools.requests).toHaveLength(1)

    await run.dispose()
    await plugin.dispose()
    expect(ctx.get('dagWorkflowEngine')).toBeUndefined()
    expect(ctx.get('workflowNodes')).toBeUndefined()
    expect(ctx.get('workflowTemplates')).toBeUndefined()
    expect(ctx.get('workflowRuns')).toBeUndefined()
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
})
