import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { WorkflowTemplate } from '../src/core/index.js'
import type {
  DshApprovalRuntimeLike,
  DshSkillRuntimeLike,
  DshSubagentRuntimeLike,
  DshToolRuntimeInput,
  DshToolRuntimeResult,
  DshWorkflowToolDefinition,
} from '../src/adapters/dsh/index.js'
import { describe, expect, it } from 'vitest'
import * as Workflow from '../lib/adapters/dsh/bundle.js'

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

class StubSession {
  append(_type: string, _data: unknown): void {}
}

async function host(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(StubTools)
  await ctx.plugin(StubSubagents)
  await ctx.plugin(StubApproval)
  await ctx.plugin(StubSkills)
  return ctx
}

function template(): WorkflowTemplate {
  return {
    apiVersion: 'workflow.gm-hz.dev/v1alpha1',
    kind: 'WorkflowTemplate',
    metadata: { id: 'bundle-smoke', name: 'Bundle smoke' },
    spec: {
      inputSchema: { type: 'object', additionalProperties: false, required: ['value'], properties: { value: { type: 'string' } } },
      outputSchema: { type: 'object', additionalProperties: false, required: ['value'], properties: { value: { type: 'string' } } },
      nodes: [
        { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
        { id: 'end', uses: 'core.end@1', with: {}, inputs: { value: { input: { path: ['value'] } } } },
      ],
      edges: [{ id: 'start-end', source: 'start', target: 'end' }],
      outputs: { value: { output: { nodeId: 'end', path: ['value'] } } },
    },
  }
}

describe('installable DSH workflow package', () => {
  it('mounts the durable services and reopens their SQLite state', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-dag-workflow-bundle-'))
    const databasePath = join(directory, 'nested', 'workflows.db')
    try {
      const first = await host()
      const firstPlugin = await first.plugin(Workflow, { databasePath })
      const disposeCapability = first.workflowCapabilities.register('acme.bundle.lifecycle', { durable: true })
      expect(first.workflowCapabilities.resolve('acme.bundle.lifecycle')).toEqual({ durable: true })
      const disposeRules = first.workflowScripts.register({
        language: 'acme.rules',
        version: 1,
        title: 'Acme rules',
        description: 'Bundle registry wiring check.',
        deterministic: true,
        validate: source => source === 'accept' ? [] : ['unknown rule'],
        async execute() { return { accepted: true } },
      })
      expect(first.workflowNodes.resolve('core.script@1')?.validateConfig?.({
        language: 'acme.rules@1',
        source: 'accept',
      })).toEqual([])
      const draft = await first.workflowTemplates.createDraft(template())
      const run = await first.dagWorkflowEngine.start({
        template: draft.template,
        inputs: { value: 'persisted' },
        parent: { session: new StubSession() },
      })
      expect(await run.result).toMatchObject({ status: 'completed', outputs: { value: 'persisted' } })
      await run.dispose()
      disposeRules()
      disposeCapability()
      await firstPlugin.dispose()

      const second = await host()
      const secondPlugin = await second.plugin(Workflow, { databasePath })
      expect(await second.workflowTemplates.readDraft('bundle-smoke')).toMatchObject({ revision: 1 })
      expect((await second.workflowRuns.loadRun(run.id))?.checkpoint.status).toBe('completed')
      await secondPlugin.dispose()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
