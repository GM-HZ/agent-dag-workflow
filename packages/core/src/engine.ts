import { randomUUID } from 'node:crypto'
import type { CompiledWorkflow, CompiledWorkflowNode } from './compiler.js'
import { compileWorkflowOrThrow } from './compiler.js'
import { WorkflowExecutionError } from './errors.js'
import type { WorkflowNodeRegistry } from './registry.js'
import { isJsonObject, snapshotJsonObject, snapshotJsonValue } from './json.js'
import type {
  JsonObject,
  JsonValue,
  WorkflowBinding,
  WorkflowEdgeStatus,
  WorkflowEvent,
  WorkflowEventInput,
  WorkflowNodeExecutionResult,
  WorkflowNodeServices,
  WorkflowNodeStatus,
  WorkflowRun,
  WorkflowRunFailure,
  WorkflowRunResult,
  WorkflowRunSuccess,
  WorkflowStartRequest,
} from './types.js'

interface NodeCompletionSuccess {
  readonly nodeId: string
  readonly ok: true
  readonly result: WorkflowNodeExecutionResult
}

interface NodeCompletionFailure {
  readonly nodeId: string
  readonly ok: false
  readonly error: unknown
}

type NodeCompletion = NodeCompletionSuccess | NodeCompletionFailure

const DEFAULT_POLICIES = {
  maxConcurrentNodes: 4,
  maxNodeRuns: 100,
  maxDurationMs: 10 * 60_000,
  maxOutputBytes: 1024 * 1024,
} as const

export class DagWorkflowEngine {
  readonly #registry: WorkflowNodeRegistry
  readonly #services: WorkflowNodeServices

  constructor(registry: WorkflowNodeRegistry, services: WorkflowNodeServices = {}) {
    this.#registry = registry
    this.#services = services
  }

  start(request: WorkflowStartRequest): WorkflowRun {
    const workflow = compileWorkflowOrThrow(request.template, this.#registry)
    const inputErrors = workflow.validateWorkflowInputs(request.inputs)
    if (inputErrors.length > 0) {
      throw new WorkflowExecutionError('WORKFLOW_INPUT_INVALID', inputErrors.join('; '))
    }

    const id = `dag-${randomUUID()}`
    const controller = new AbortController()
    let cancelReason = 'cancelled'
    const abortFromCaller = () => {
      cancelReason = renderAbortReason(request.signal?.reason, 'caller cancelled')
      controller.abort(request.signal?.reason)
    }
    if (request.signal?.aborted === true) abortFromCaller()
    else request.signal?.addEventListener('abort', abortFromCaller, { once: true })

    const result = this.#execute(id, workflow, snapshotJsonObject(request.inputs), request.owner, controller, () => cancelReason, request.onEvent)
      .catch((error: unknown): WorkflowRunFailure => ({
        status: 'failed',
        runId: id,
        error: renderError(error),
        nodeStates: {},
        edgeStates: {},
        events: [],
      }))
      .finally(() => request.signal?.removeEventListener('abort', abortFromCaller))

    return {
      id,
      result,
      cancel(reason?: string) {
        if (controller.signal.aborted) return
        cancelReason = reason ?? 'cancelled'
        controller.abort(cancelReason)
      },
      async dispose() {
        if (!controller.signal.aborted) {
          cancelReason = 'run disposed'
          controller.abort(cancelReason)
        }
        await result
      },
    }
  }

  async #execute(
    runId: string,
    workflow: CompiledWorkflow,
    workflowInputs: JsonObject,
    owner: unknown,
    controller: AbortController,
    cancelReason: () => string,
    onEvent?: (event: WorkflowEvent) => void,
  ): Promise<WorkflowRunResult> {
    const nodeStates = new Map<string, WorkflowNodeStatus>([...workflow.nodes.keys()].map(id => [id, 'pending']))
    const edgeStates = new Map<string, WorkflowEdgeStatus>([...workflow.edges.keys()].map(id => [id, 'unknown']))
    const nodeOutputs = new Map<string, JsonObject>()
    const events: WorkflowEvent[] = []
    const services = this.#services
    let seq = 0
    let deadlineExceeded = false
    let nodeRuns = 0
    const policies = { ...DEFAULT_POLICIES, ...workflow.template.spec.policies }
    const emit = (event: WorkflowEventInput): void => {
      const complete = { ...event, seq: ++seq, runId } as WorkflowEvent
      events.push(complete)
      try {
        onEvent?.(complete)
      } catch {
        // Observers cannot affect execution.
      }
    }

    const deadline = setTimeout(() => {
      deadlineExceeded = true
      controller.abort('workflow duration exceeded')
    }, policies.maxDurationMs)

    emit({ type: 'run.started' })
    const ready: string[] = [workflow.startNodeId]
    nodeStates.set(workflow.startNodeId, 'ready')
    emit({ type: 'node.ready', nodeId: workflow.startNodeId })
    const active = new Map<string, Promise<NodeCompletion>>()

    try {
      while (ready.length > 0 || active.size > 0) {
        if (controller.signal.aborted && active.size === 0) {
          return deadlineExceeded
            ? failedResult('workflow duration exceeded')
            : cancelledResult(cancelReason())
        }

        while (!controller.signal.aborted && ready.length > 0 && active.size < policies.maxConcurrentNodes) {
          if (++nodeRuns > policies.maxNodeRuns) {
            const error = 'workflow exceeded maxNodeRuns'
            controller.abort(error)
            await settleActiveAsCancelled(active, nodeStates)
            return failedResult(error)
          }
          const nodeId = ready.shift()!
          const node = workflow.nodes.get(nodeId)!
          nodeStates.set(nodeId, 'running')
          emit({ type: 'node.started', nodeId })
          active.set(nodeId, this.#executeNode(runId, node, workflowInputs, nodeOutputs, owner, controller.signal, policies.maxOutputBytes))
        }

        if (active.size === 0) continue
        const completion = await Promise.race(active.values())
        active.delete(completion.nodeId)
        if (!completion.ok) {
          if (controller.signal.aborted) {
            nodeStates.set(completion.nodeId, 'cancelled')
            await settleActiveAsCancelled(active, nodeStates)
            return deadlineExceeded
              ? failedResult('workflow duration exceeded')
              : cancelledResult(cancelReason())
          }
          const error = renderError(completion.error)
          nodeStates.set(completion.nodeId, 'failed')
          emit({ type: 'node.failed', nodeId: completion.nodeId, error })
          controller.abort(`node ${completion.nodeId} failed`)
          await settleActiveAsCancelled(active, nodeStates)
          return failedResult(error)
        }

        nodeStates.set(completion.nodeId, 'succeeded')
        nodeOutputs.set(completion.nodeId, completion.result.outputs)
        emit({ type: 'node.completed', nodeId: completion.nodeId })
        settleOutgoingEdges(completion.nodeId, completion.result.selectedPorts ?? ['success'])
      }

      const unresolved = [...nodeStates].filter(([, status]) => status === 'pending' || status === 'ready' || status === 'running')
      if (unresolved.length > 0) return failedResult(`scheduler stopped with unresolved nodes: ${unresolved.map(([id]) => id).join(', ')}`)

      const outputs = snapshotJsonObject(await resolveBindings(workflow.template.spec.outputs, undefined))
      const outputErrors = workflow.validateWorkflowOutputs(outputs)
      if (outputErrors.length > 0) return failedResult(`workflow output is invalid: ${outputErrors.join('; ')}`)
      assertOutputSize(outputs, policies.maxOutputBytes, 'workflow result')
      emit({ type: 'run.completed' })
      return successResult(outputs)
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        return deadlineExceeded
          ? failedResult('workflow duration exceeded')
          : cancelledResult(cancelReason())
      }
      return failedResult(renderError(error))
    } finally {
      clearTimeout(deadline)
    }

    function settleOutgoingEdges(nodeId: string, selectedPorts: readonly string[]): void {
      const node = workflow.nodes.get(nodeId)!
      const selected = new Set(selectedPorts)
      for (const edge of node.outgoing) {
        const taken = selected.has(edge.sourcePort ?? 'success')
        edgeStates.set(edge.id, taken ? 'taken' : 'skipped')
        emit({ type: taken ? 'edge.taken' : 'edge.skipped', edgeId: edge.id })
      }
      for (const target of new Set(node.outgoing.map(edge => edge.target))) reconcileNode(target)
    }

    function reconcileNode(nodeId: string): void {
      if (nodeStates.get(nodeId) !== 'pending') return
      const node = workflow.nodes.get(nodeId)!
      const statuses = node.incoming.map(edge => edgeStates.get(edge.id)!)
      if (statuses.some(status => status === 'unknown')) return
      if (statuses.some(status => status === 'taken')) {
        nodeStates.set(nodeId, 'ready')
        ready.push(nodeId)
        ready.sort((left, right) => workflow.order.indexOf(left) - workflow.order.indexOf(right))
        emit({ type: 'node.ready', nodeId })
        return
      }
      nodeStates.set(nodeId, 'skipped')
      emit({ type: 'node.skipped', nodeId })
      for (const edge of node.outgoing) {
        edgeStates.set(edge.id, 'skipped')
        emit({ type: 'edge.skipped', edgeId: edge.id })
      }
      for (const target of new Set(node.outgoing.map(edge => edge.target))) reconcileNode(target)
    }

    async function resolveBindings(bindings: Readonly<Record<string, WorkflowBinding>>, nodeId: string | undefined): Promise<JsonObject> {
      const result: JsonObject = {}
      for (const [name, binding] of Object.entries(bindings)) {
        result[name] = await resolveBinding(binding, nodeId)
      }
      return result
    }

    async function resolveBinding(binding: WorkflowBinding, nodeId: string | undefined): Promise<JsonValue> {
      if ('literal' in binding) return snapshotJsonValue(binding.literal)
      if ('input' in binding) {
        if (!(binding.input in workflowInputs)) throw new WorkflowExecutionError('WORKFLOW_INPUT_MISSING', `workflow input is missing: ${binding.input}`, nodeId === undefined ? undefined : { nodeId })
        return snapshotJsonValue(workflowInputs[binding.input]!)
      }
      if ('secret' in binding) {
        if (nodeId === undefined) throw new WorkflowExecutionError('SECRET_OUTPUT_FORBIDDEN', 'workflow outputs cannot contain secret bindings')
        const secrets = services.secrets
        if (secrets === undefined) throw new WorkflowExecutionError('SECRET_GATEWAY_MISSING', `secret gateway is required for ${binding.secret.ref}`, { nodeId })
        return secrets.resolve(binding.secret.ref, { runId, nodeId, signal: controller.signal })
      }
      const source = nodeOutputs.get(binding.output.node)
      if (source === undefined) throw new WorkflowExecutionError('BINDING_SOURCE_UNAVAILABLE', `output is unavailable from node ${binding.output.node}`, nodeId === undefined ? undefined : { nodeId })
      return snapshotJsonValue(readPath(source, binding.output.path, binding.output.node))
    }

    function successResult(outputs: JsonObject): WorkflowRunSuccess {
      return {
        status: 'completed',
        runId,
        outputs,
        nodeStates: Object.fromEntries(nodeStates),
        edgeStates: Object.fromEntries(edgeStates),
        events: [...events],
      }
    }

    function failedResult(error: string): WorkflowRunFailure {
      emit({ type: 'run.failed', error })
      return {
        status: 'failed',
        runId,
        error,
        nodeStates: Object.fromEntries(nodeStates),
        edgeStates: Object.fromEntries(edgeStates),
        events: [...events],
      }
    }

    function cancelledResult(reason: string): WorkflowRunFailure {
      emit({ type: 'run.cancelled', reason })
      return {
        status: 'cancelled',
        runId,
        error: reason,
        nodeStates: Object.fromEntries(nodeStates),
        edgeStates: Object.fromEntries(edgeStates),
        events: [...events],
      }
    }
  }

  async #executeNode(
    runId: string,
    node: CompiledWorkflowNode,
    workflowInputs: JsonObject,
    nodeOutputs: ReadonlyMap<string, JsonObject>,
    owner: unknown,
    runSignal: AbortSignal,
    maxOutputBytes: number,
  ): Promise<NodeCompletion> {
    try {
      const inputs = snapshotJsonObject(await resolveNodeInputs(node, workflowInputs, nodeOutputs, runId, runSignal, this.#services))
      const inputErrors = node.validateInputs(inputs)
      if (inputErrors.length > 0) throw new WorkflowExecutionError('NODE_INPUT_INVALID', inputErrors.join('; '), { nodeId: node.template.id })
      const timeoutSignal = node.template.policy?.timeoutMs === undefined
        ? runSignal
        : AbortSignal.any([runSignal, AbortSignal.timeout(node.template.policy.timeoutMs)])
      const rawResult = await node.definition.execute({
        runId,
        nodeId: node.template.id,
        workflowInputs,
        inputs,
        config: node.template.with,
        signal: timeoutSignal,
        services: this.#services,
        ...(owner === undefined ? {} : { owner }),
      })
      const outputs = snapshotJsonObject(rawResult.outputs)
      const result: WorkflowNodeExecutionResult = {
        outputs,
        ...(rawResult.selectedPorts === undefined ? {} : { selectedPorts: Object.freeze([...rawResult.selectedPorts]) }),
      }
      const outputErrors = node.validateOutputs(outputs)
      if (outputErrors.length > 0) throw new WorkflowExecutionError('NODE_OUTPUT_INVALID', outputErrors.join('; '), { nodeId: node.template.id })
      const selected = result.selectedPorts ?? ['success']
      if (selected.length === 0 || new Set(selected).size !== selected.length || selected.some(port => !node.definition.outputPorts.includes(port))) {
        throw new WorkflowExecutionError('NODE_PORT_INVALID', `node selected invalid output ports: ${selected.join(', ')}`, { nodeId: node.template.id })
      }
      assertOutputSize(result.outputs, maxOutputBytes, `node ${node.template.id} output`)
      return { nodeId: node.template.id, ok: true, result }
    } catch (error: unknown) {
      return { nodeId: node.template.id, ok: false, error }
    }
  }
}

async function resolveNodeInputs(
  node: CompiledWorkflowNode,
  workflowInputs: JsonObject,
  nodeOutputs: ReadonlyMap<string, JsonObject>,
  runId: string,
  signal: AbortSignal,
  services: WorkflowNodeServices,
): Promise<JsonObject> {
  const result: JsonObject = {}
  for (const [name, binding] of Object.entries(node.template.inputs)) {
    if ('literal' in binding) result[name] = snapshotJsonValue(binding.literal)
    else if ('input' in binding) {
      if (!(binding.input in workflowInputs)) throw new WorkflowExecutionError('WORKFLOW_INPUT_MISSING', `workflow input is missing: ${binding.input}`, { nodeId: node.template.id })
      result[name] = snapshotJsonValue(workflowInputs[binding.input]!)
    } else if ('secret' in binding) {
      if (services.secrets === undefined) throw new WorkflowExecutionError('SECRET_GATEWAY_MISSING', `secret gateway is required for ${binding.secret.ref}`, { nodeId: node.template.id })
      result[name] = await services.secrets.resolve(binding.secret.ref, { runId, nodeId: node.template.id, signal })
    } else {
      const source = nodeOutputs.get(binding.output.node)
      if (source === undefined) throw new WorkflowExecutionError('BINDING_SOURCE_UNAVAILABLE', `output is unavailable from node ${binding.output.node}`, { nodeId: node.template.id })
      result[name] = snapshotJsonValue(readPath(source, binding.output.path, binding.output.node))
    }
  }
  return result
}

function readPath(root: JsonValue, path: readonly (string | number)[], sourceNodeId: string): JsonValue {
  let value: JsonValue | undefined = root
  for (const segment of path) {
    if (typeof segment === 'number') {
      if (!Array.isArray(value) || segment >= value.length) throw new WorkflowExecutionError('BINDING_PATH_INVALID', `path does not exist on node ${sourceNodeId}`)
      value = value[segment]
    } else {
      if (value === undefined || !isJsonObject(value) || !(segment in value)) throw new WorkflowExecutionError('BINDING_PATH_INVALID', `path does not exist on node ${sourceNodeId}`)
      value = value[segment]
    }
  }
  if (value === undefined) throw new WorkflowExecutionError('BINDING_PATH_INVALID', `path does not exist on node ${sourceNodeId}`)
  return value
}

async function settleActiveAsCancelled(
  active: ReadonlyMap<string, Promise<NodeCompletion>>,
  states: Map<string, WorkflowNodeStatus>,
): Promise<void> {
  await Promise.allSettled(active.values())
  for (const nodeId of active.keys()) {
    if (states.get(nodeId) === 'running') states.set(nodeId, 'cancelled')
  }
}

function assertOutputSize(value: JsonValue, maxBytes: number, label: string): void {
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
  if (bytes > maxBytes) throw new WorkflowExecutionError('OUTPUT_TOO_LARGE', `${label} is ${bytes} bytes, limit is ${maxBytes}`)
}

function renderAbortReason(reason: unknown, fallback: string): string {
  if (reason === undefined) return fallback
  return renderError(reason)
}

function renderError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
