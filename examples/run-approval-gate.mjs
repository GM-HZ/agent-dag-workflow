import { readFile } from 'node:fs/promises'
import {
  DagWorkflowEngine,
  registerCoreNodes,
  WorkflowNodeRegistry,
} from '../lib/core/index.js'

const template = JSON.parse(await readFile(new URL('./approval-gate.workflow.json', import.meta.url), 'utf8'))
const registry = new WorkflowNodeRegistry()
registerCoreNodes(registry)
const engine = new DagWorkflowEngine(registry)
const execution = { authorityRef: 'example:local', authority: {}, origin: { type: 'sdk', source: 'demo' } }

for (const inputs of [
  { request: 'Publish a workflow plugin to DSH Market', riskScore: 88 },
  { request: 'Render the local workflow canvas', riskScore: 35 },
]) {
  const run = await engine.start({ template, inputs, execution })
  const result = await run.result
  if (result.status !== 'completed') throw new Error(result.error)
  const route = result.edgeStates['high-risk-route'] === 'taken' ? 'high-risk-route' : 'normal-route'
  console.log(JSON.stringify({ runId: result.runId, route, outputs: result.outputs }, null, 2))
}
