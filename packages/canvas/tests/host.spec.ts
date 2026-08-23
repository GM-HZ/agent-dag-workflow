import { Context, Service } from '@deepseek-ai/cordis'
import type { WorkflowTemplate } from '@gm-hz/dsh-workflow-core'
import * as DshWorkflow from '@gm-hz/dsh-workflow-dsh'
import type {
  DshAgentLike,
  DshApprovalRuntimeLike,
  DshSkillRuntimeLike,
  DshSubagentRuntimeLike,
  DshToolRuntimeInput,
  DshToolRuntimeResult,
  DshWorkflowToolDefinition,
} from '@gm-hz/dsh-workflow-dsh'
import { describe, expect, it, vi } from 'vitest'
import * as CanvasPlugin from '../lib/index.js'
import type { CanvasWorkflowTemplate, WorkflowCanvasAction } from '../src/types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tools: StubTools
    subagents: StubSubagents
    approval: StubApproval
    skills: StubSkills
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

class Session {
  readonly entries: { readonly type: string; readonly data: unknown }[] = []
  append(type: string, data: unknown): void { this.entries.push({ type, data }) }
}

function workflow(): WorkflowTemplate {
  return {
    apiVersion: 'dsh.workflow/v1alpha1',
    kind: 'WorkflowTemplate',
    metadata: { id: 'canvas-host-test', name: 'Canvas host test' },
    spec: {
      inputSchema: { type: 'object', additionalProperties: false, required: ['message'], properties: { message: { type: 'string' } } },
      outputSchema: { type: 'object', additionalProperties: false, required: ['message'], properties: { message: { type: 'string' } } },
      nodes: [
        { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
        { id: 'end', uses: 'core.end@1', with: {}, inputs: { message: { input: 'message' } } },
      ],
      edges: [{ id: 'start-end', source: 'start', target: 'end' }],
      outputs: { message: { output: { node: 'end', path: ['message'] } } },
    },
  }
}

async function runtime(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(StubTools)
  await ctx.plugin(StubSubagents)
  await ctx.plugin(StubApproval)
  await ctx.plugin(StubSkills)
  await ctx.plugin(DshWorkflow)
  return ctx
}

describe('workflow canvas Host gateway', () => {
  it('fails closed without an authority and rejects denied sessions', async () => {
    const ctx = await runtime()
    await expect(ctx.plugin(CanvasPlugin, undefined as never)).rejects.toThrow(/requires a fail-closed authorize/)
    await ctx.plugin(CanvasPlugin, { authorize: () => undefined })
    await expect(ctx.workflowCanvas.nodes('forged')).rejects.toThrow(/access denied/)
  })

  it('guards every operation and exposes draft, publish, run, and persisted trace', async () => {
    const ctx = await runtime()
    const session = new Session()
    const agent: DshAgentLike = { session }
    const actions: WorkflowCanvasAction[] = []
    const authorize = vi.fn(request => {
      actions.push(request.action)
      return request.sessionId === 'session-1' ? { subject: 'user-1', agent } : undefined
    })
    await ctx.plugin(CanvasPlugin, { authorize })

    const wireTemplate = structuredClone(workflow()) as unknown as CanvasWorkflowTemplate
    expect((await ctx.workflowCanvas.nodes('session-1')).map(node => node.uses)).toContain('core.start@1')
    const draft = await ctx.workflowCanvas.createDraft('session-1', { template: wireTemplate })
    expect((await ctx.workflowCanvas.validate('session-1', { template: wireTemplate })).diagnostics).toEqual([])
    const published = await ctx.workflowCanvas.publish('session-1', { id: draft.id, expectedRevision: draft.revision })
    const result = await ctx.workflowCanvas.run('session-1', {
      id: published.id,
      revision: published.revision,
      inputs: { message: 'through remote' },
    }, new AbortController().signal)
    const trace = await ctx.workflowCanvas.trace('session-1', { runId: result.runId })

    expect(result).toMatchObject({ status: 'completed', outputs: { message: 'through remote' } })
    expect(trace.status).toBe('completed')
    expect(trace.events.map(event => event.type)).toContain('checkpoint.committed')
    expect(actions).toEqual(['nodes:list', 'draft:create', 'draft:validate', 'draft:publish', 'run:start', 'run:trace'])
    expect(authorize).toHaveBeenLastCalledWith({ sessionId: 'session-1', action: 'run:trace', resourceId: result.runId })
  })
})
