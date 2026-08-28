import { readFile } from 'node:fs/promises'
import {
  DagWorkflowEngine,
  registerCoreNodes,
  WorkflowNodeRegistry,
} from '../lib/core/index.js'

const template = JSON.parse(await readFile(new URL('./script-transform.workflow.json', import.meta.url), 'utf8'))
const registry = new WorkflowNodeRegistry()
registerCoreNodes(registry)
const result = await new DagWorkflowEngine(registry).start({
  template,
  inputs: {
    customer: '  gm-hz  ',
    orders: [
      { id: 'A-100', amount: 28.5, approved: true },
      { id: 'A-101', amount: 11.5, approved: false },
      { id: 'A-102', amount: 60, approved: true }
    ]
  }
}).result

if (result.status !== 'completed') throw new Error(result.error)
console.log(JSON.stringify({ runId: result.runId, outputs: result.outputs }, null, 2))
