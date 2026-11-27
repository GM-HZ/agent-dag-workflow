import { snapshotJsonValue, type JsonObject, type WorkflowNodeRegistry, type WorkflowRecordedFixture, type WorkflowRunRecord } from '../core/index.js'
import { resolveWorkflowBindings } from '../core/bindings.js'
import { redactWorkflowFields } from './evidence.js'

export const WORKFLOW_CASE_FORMAT = 'agent-dag-workflow.case/v1'

type RecordedCaseNode = WorkflowRecordedFixture & { readonly uses: string; readonly configuration: JsonObject }
export interface WorkflowCaseExpectation {
  readonly status: 'completed' | 'failed'
  readonly outputs?: JsonObject
  readonly requiredNodes?: readonly string[]
  readonly forbiddenTools?: readonly string[]
  readonly failedNode?: string
  readonly errorCode?: string
}
export interface WorkflowCase {
  readonly format: typeof WORKFLOW_CASE_FORMAT
  readonly name: string
  readonly inputs: JsonObject
  readonly expected: WorkflowCaseExpectation
  readonly baselineExpected?: WorkflowCaseExpectation
  readonly reviewRubric?: { readonly id: string; readonly version: number; readonly criteria: readonly string[] }
  readonly recorded?: Readonly<Record<string, RecordedCaseNode>>
}

export function caseFromRun(record: WorkflowRunRecord, registry: WorkflowNodeRegistry, redactFields: readonly string[] = []) {
  const state = record.checkpoint
  if (state.status !== 'completed' && state.status !== 'failed') throw new Error('select a completed or failed run for a regression case')
  const recorded: [string, RecordedCaseNode][] = []
  const failed = record.events.findLast(event => event.type === 'node.failed')
  const completedByNode = new Map<string, Extract<WorkflowRunRecord['events'][number], { type: 'node.completed' }>>()
  const failedCapabilities = new Set<string>()
  for (const event of record.events) {
    if (event.type === 'node.completed') completedByNode.set(event.nodeId, event)
    if (event.type === 'capability.failed') failedCapabilities.add(event.nodeId)
  }
  for (const node of record.template.spec.nodes) {
    const definition = registry.resolve(node.uses)
    if (definition === undefined) throw new Error(`missing definition ${node.uses} in source run`)
    const status = state.nodeStates[node.id]
    if (definition.effects !== 'external' || (status !== 'succeeded' && status !== 'failed')) continue
    const expectedInputs = resolveWorkflowBindings(node.inputs, record.inputs, id => state.nodeOutputs[id])
    const common = { uses: node.uses, configuration: node.with, expectedInputs }
    if (status === 'failed' && failed?.type === 'node.failed' && failed.nodeId === node.id) {
      if (failedCapabilities.has(node.id)) recorded.push([node.id, { ...common, failure: { code: failed.errorCode ?? 'WORKFLOW_EXTERNAL_FAILURE', message: failed.error } }])
      continue
    }
    const outputs = state.nodeOutputs[node.id]
    if (outputs === undefined) throw new Error(`missing source output for ${node.id}`)
    const completed = completedByNode.get(node.id)
    const taken = [...new Set(record.template.spec.edges.filter(edge => edge.source === node.id && state.edgeStates[edge.id] === 'taken').map(edge => edge.sourcePort ?? 'success'))]
    const selectedPorts = completed?.type === 'node.completed' && completed.selectedPorts !== undefined
      ? completed.selectedPorts : taken.length > 0 ? taken : definition.outputPorts.length === 1 ? definition.outputPorts : []
    if (selectedPorts.length === 0) throw new Error(`cannot determine executed ports in historical node ${node.id}`)
    recorded.push([node.id, { ...common, outputs, selectedPorts }])
  }
  const { revision } = record.plan.root
  const sample = snapshotJsonValue({
    format: WORKFLOW_CASE_FORMAT, name: record.template.metadata.name,
    source: { runId: record.runId, ref: revision === undefined ? record.template.metadata.id : `${record.template.metadata.id}@${revision}`,
      semanticHash: record.semanticHash, checkpointSeq: state.seq },
    inputs: record.inputs,
    expected: {
      status: state.status, ...(state.resultOutputs === undefined ? {} : { outputs: state.resultOutputs }),
      requiredNodes: record.template.spec.nodes.filter(node => state.nodeStates[node.id] === 'succeeded').map(node => node.id),
      forbiddenTools: [],
      ...(failed?.type !== 'node.failed' ? {} : { failedNode: failed.nodeId, ...(failed.errorCode === undefined ? {} : { errorCode: failed.errorCode }) }),
    },
    recorded: Object.fromEntries(recorded),
  })
  return redactWorkflowFields(sample, new Set(redactFields))
}
