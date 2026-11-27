import { createHash } from 'node:crypto'
import { resolveWorkflowBindings } from './bindings.js'
import { WorkflowExecutionError } from './errors.js'
import { stableJsonStringify } from './json.js'
import type { WorkflowNodeRegistry } from './registry.js'
import type {
  WorkflowEdgeTemplate,
  WorkflowEvent,
  WorkflowRecordedNodeResult,
  WorkflowRecordedReplay,
  JsonValue,
  WorkflowRunOrigin,
  WorkflowRunRecord,
} from './types.js'

export function isRecordedReplayOrigin(origin: WorkflowRunOrigin): boolean {
  return origin.type === 'replay' && origin.source === 'recorded'
}

export function replayValueHash(value: JsonValue): string {
  return createHash('sha256').update(stableJsonStringify(value)).digest('hex')
}

/** Reconstruct the executed external path from an immutable, completed run. */
export function buildRecordedReplay(record: WorkflowRunRecord, registry: WorkflowNodeRegistry): WorkflowRecordedReplay {
  if (!record.plan.replayable) throw new Error('recorded replay requires implementation digests for every node definition')
  const checkpoint = record.checkpoint
  if (checkpoint.status !== 'completed') throw new Error('recorded replay requires a completed source run')
  if (checkpoint.semanticHash !== record.semanticHash || checkpoint.resultOutputs === undefined) {
    throw new WorkflowExecutionError('RECORDED_SOURCE_INVALID', 'recorded replay source does not have a matching completed checkpoint')
  }
  const capabilities = new Map<string, Extract<WorkflowEvent, { readonly type: 'capability.completed' | 'capability.replayed' }>>()
  const requests = new Map<string, Extract<WorkflowEvent, { readonly type: 'capability.requested' }>>()
  const completions = new Map<string, Extract<WorkflowEvent, { readonly type: 'node.completed' }>>()
  const outputCommits = new Map<string, Extract<WorkflowEvent, { readonly type: 'node.output-committed' }>>()
  for (const event of record.events) {
    if (event.type === 'capability.completed' || event.type === 'capability.replayed') capabilities.set(event.nodeId, event)
    if (event.type === 'capability.requested') requests.set(event.nodeId, event)
    if (event.type === 'node.completed') completions.set(event.nodeId, event)
    if (event.type === 'node.output-committed') outputCommits.set(event.nodeId, event)
  }
  const outgoingByNode = new Map<string, WorkflowEdgeTemplate[]>()
  for (const edge of record.template.spec.edges) {
    const outgoing = outgoingByNode.get(edge.source) ?? []
    outgoing.push(edge)
    outgoingByNode.set(edge.source, outgoing)
  }
  const entries: [string, WorkflowRecordedNodeResult][] = []
  for (const node of record.template.spec.nodes) {
    const definition = registry.resolve(node.uses)
    if (definition === undefined) throw new WorkflowExecutionError('RECORDED_SOURCE_INVALID', `recorded replay does not have a definition for ${node.uses}`)
    if (definition.effects !== 'external' || checkpoint.nodeStates[node.id] === 'skipped') continue
    const outputs = checkpoint.nodeOutputs[node.id]
    const capability = capabilities.get(node.id)
    const completion = completions.get(node.id)
    if (checkpoint.nodeStates[node.id] !== 'succeeded' || outputs === undefined || capability === undefined || completion === undefined) {
      throw new WorkflowExecutionError('RECORDED_OUTPUT_MISSING', `recorded replay is missing committed external outputs: ${node.id}`)
    }
    const selectedPorts = recordedPorts(
      node.id, definition.outputPorts, completion.selectedPorts, outgoingByNode.get(node.id) ?? [], checkpoint.edgeStates,
    )
    const inputHash = replayValueHash(resolveWorkflowBindings(node.inputs, record.inputs, id => (
      Object.hasOwn(checkpoint.nodeOutputs, id) ? checkpoint.nodeOutputs[id] : undefined
    ), node.id))
    const committedInputHash = capability.type === 'capability.replayed' ? capability.inputHash : requests.get(node.id)?.inputHash
    if (committedInputHash !== undefined && committedInputHash !== inputHash) {
      throw new WorkflowExecutionError('RECORDED_INPUT_MISMATCH', `recorded replay hash does not match committed input for node ${node.id}`)
    }
    // Legacy replay records captured the recorded result as a node output but
    // omitted the artifact from capability.replayed itself.
    const legacy = capability.type === 'capability.replayed' ? outputCommits.get(node.id) : undefined
    const dataHash = capability.dataHash ?? legacy?.dataHash
    const artifact = capability.artifact ?? legacy?.artifact
    if (dataHash !== undefined && replayValueHash(outputs) !== dataHash) {
      throw new WorkflowExecutionError('RECORDED_OUTPUT_INVALID', `recorded replay hash does not match committed output for node ${node.id}`)
    }
    entries.push([node.id, {
      outputs, selectedPorts, inputHash, sourceEventId: capability.eventId,
      ...(dataHash === undefined ? {} : { dataHash }),
      ...(artifact === undefined ? {} : { artifact }),
      ...(capability.hostEvidence === undefined ? {} : { hostEvidence: capability.hostEvidence }),
    }])
  }
  return {
    sourceRunId: record.runId,
    semanticHash: record.semanticHash,
    nodeResults: Object.fromEntries(entries),
    nodeStates: checkpoint.nodeStates,
    edgeStates: checkpoint.edgeStates,
    outputs: checkpoint.resultOutputs,
  }
}

function recordedPorts(
  nodeId: string,
  declared: readonly string[],
  original: readonly string[] | undefined,
  outgoing: readonly WorkflowEdgeTemplate[],
  states: WorkflowRecordedReplay['edgeStates'],
): readonly string[] {
  const taken = new Set(outgoing.filter(edge => states[edge.id] === 'taken').map(edge => edge.sourcePort ?? 'success'))
  const connected = new Set(outgoing.map(edge => edge.sourcePort ?? 'success'))
  // Older events record only edges. If no edge was taken, an unconnected
  // declared port preserves that historical route.
  const selected = original ?? (taken.size > 0 ? [...taken] : declared.filter(port => !connected.has(port)).slice(0, 1))
  if (selected.length === 0 || new Set(selected).size !== selected.length || selected.some(port => !declared.includes(port))
    || outgoing.some(edge => states[edge.id] !== (selected.includes(edge.sourcePort ?? 'success') ? 'taken' : 'skipped'))) {
    throw new WorkflowExecutionError('RECORDED_ROUTE_INVALID', `recorded replay route is inconsistent for node ${nodeId}`)
  }
  return selected
}
