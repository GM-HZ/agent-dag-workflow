import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'agent-dag-workflow-native-smoke'
export const inject = ['agents', 'workspaceRegistry', 'workspaceController', 'dagWorkflowEngine']

export async function apply(ctx) {
  const workspace = await ctx.workspaceController.create({ path: process.cwd() })
  const owner = await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: process.cwd() } })
  await ctx.workspaceRegistry.get(workspace.workspace.workspaceId).attachSession(owner.agent.id)
  owner.agent.session.append('turn/start', { turn: 1 })
  owner.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  const other = await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: process.cwd() } })
  ctx.effect(() => async () => { await other.dispose(); await owner.dispose() }, 'dispose native DSH fixture agents')
  const messageSchema = { type: 'object', required: ['message'], properties: { message: { type: 'string' } } }
  const run = await ctx.dagWorkflowEngine.start({
    parent: other.agent, inputs: { message: 'Other native smoke session' },
    template: {
      apiVersion: 'workflow.gm-hz.dev/v1', kind: 'WorkflowTemplate',
      metadata: { id: 'native-smoke-hidden', name: 'Other native smoke session' },
      spec: {
        inputSchema: messageSchema, outputSchema: messageSchema,
        nodes: [
          { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
          { id: 'end', uses: 'core.end@1', with: {}, inputs: { message: { input: { path: ['message'] } } } },
        ],
        edges: [{ id: 'start-end', source: 'start', target: 'end' }],
        outputs: { message: { output: { nodeId: 'end', path: ['message'] } } },
      },
    },
  })
  assert.equal((await run.result).status, 'completed')
  writeFileSync(join(process.env.DSH_HOME, 'fixture-ready.json'), JSON.stringify({ owner: owner.agent.id, hiddenRunId: run.id }))
}
