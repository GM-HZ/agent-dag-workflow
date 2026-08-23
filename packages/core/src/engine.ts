import { createHash, randomUUID } from 'node:crypto'
import type { CompiledWorkflow, CompiledWorkflowNode } from './compiler.js'
import { compileWorkflowOrThrow } from './compiler.js'
import { WorkflowExecutionError, WorkflowPauseError } from './errors.js'
import { isJsonObject, snapshotJsonObject, snapshotJsonValue, stableJsonStringify } from './json.js'
import type { WorkflowNodeRegistry } from './registry.js'
import type {
  JsonObject,
  JsonValue,
  PersistedWorkflowRunStatus,
  WorkflowBinding,
  WorkflowEdgeStatus,
  WorkflowEvent,
  WorkflowEventInput,
  WorkflowInvocationRequest,
  WorkflowNodeExecutionResult,
  WorkflowNodeServices,
  WorkflowNodeStatus,
  WorkflowResumeRequest,
  WorkflowRun,
  WorkflowRunCheckpoint,
  WorkflowRunFailure,
  WorkflowRunRecord,
  WorkflowRunResult,
  WorkflowRunStore,
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

class WorkflowCommitFailure extends Error {
  constructor(readonly original: unknown) {
    super(renderError(original))
    this.name = 'WorkflowCommitFailure'
  }
}

type NodeCompletion = NodeCompletionSuccess | NodeCompletionFailure

interface RuntimeState {
  readonly nodeStates: Map<string, WorkflowNodeStatus>
  readonly edgeStates: Map<string, WorkflowEdgeStatus>
  readonly nodeOutputs: Map<string, JsonObject>
  readonly nodeProgress: Map<string, JsonValue>
  readonly ready: string[]
  readonly events: WorkflowEvent[]
  nodeRuns: number
  seq: number
  status: PersistedWorkflowRunStatus
  readonly depth: number
  readonly subworkflowDepthLimit: number
  readonly invocationId?: string
  error?: string
  resultOutputs?: JsonObject
}

export interface DagWorkflowEngineOptions {
  readonly runStore?: WorkflowRunStore
  readonly now?: () => number
}

const DEFAULT_POLICIES = {
  maxConcurrentNodes: 4,
  maxNodeRuns: 100,
  maxDurationMs: 10 * 60_000,
  maxOutputBytes: 1024 * 1024,
} as const

export class DagWorkflowEngine {
  readonly #registry: WorkflowNodeRegistry
  readonly #services: WorkflowNodeServices
  readonly #runStore: WorkflowRunStore | undefined
  readonly #now: () => number

  constructor(registry: WorkflowNodeRegistry, services: WorkflowNodeServices = {}, options: DagWorkflowEngineOptions = {}) {
    this.#registry = registry
    this.#services = services
    this.#runStore = options.runStore
    this.#now = options.now ?? Date.now
  }

  start(request: WorkflowStartRequest): WorkflowRun {
    const workflow = compileWorkflowOrThrow(request.template, this.#registry)
    const inputs = snapshotJsonObject(request.inputs)
    const inputErrors = workflow.validateWorkflowInputs(inputs)
    if (inputErrors.length > 0) throw new WorkflowExecutionError('WORKFLOW_INPUT_INVALID', inputErrors.join('; '))

    return this.#startNew(
      `dag-${randomUUID()}`,
      workflow,
      inputs,
      0,
      workflow.template.spec.policies?.subworkflowMaxDepth ?? 8,
      undefined,
      request,
    )
  }

  invoke(request: WorkflowInvocationRequest): WorkflowRun {
    if (this.#runStore === undefined) throw new WorkflowExecutionError('RUN_STORE_MISSING', 'nested workflow invocation requires a WorkflowRunStore')
    if (!Number.isSafeInteger(request.depth) || request.depth < 1) {
      throw new WorkflowExecutionError('SUBWORKFLOW_DEPTH_INVALID', 'nested workflow depth must be a positive safe integer')
    }
    if (!Number.isSafeInteger(request.subworkflowDepthLimit) || request.subworkflowDepthLimit < request.depth) {
      throw new WorkflowExecutionError('SUBWORKFLOW_DEPTH_INVALID', 'nested workflow depth limit must be a safe integer at least as large as depth')
    }
    if (typeof request.invocationId !== 'string' || request.invocationId.length === 0 || request.invocationId.length > 1024) {
      throw new WorkflowExecutionError('INVOCATION_ID_INVALID', 'invocationId must be a non-empty string no longer than 1024 characters')
    }
    const workflow = compileWorkflowOrThrow(request.template, this.#registry)
    const inputs = snapshotJsonObject(request.inputs)
    const inputErrors = workflow.validateWorkflowInputs(inputs)
    if (inputErrors.length > 0) throw new WorkflowExecutionError('WORKFLOW_INPUT_INVALID', inputErrors.join('; '))
    const id = invocationRunId(request.invocationId)
    const existing = this.#runStore.loadRun(id)
    const effectiveDepthLimit = Math.min(request.subworkflowDepthLimit, workflow.template.spec.policies?.subworkflowMaxDepth ?? 8)
    if (existing === undefined) return this.#startNew(id, workflow, inputs, request.depth, effectiveDepthLimit, request.invocationId, request)
    if (existing.semanticHash !== workflow.semanticHash
      || stableJsonStringify(existing.inputs) !== stableJsonStringify(inputs)
      || existing.checkpoint.depth !== request.depth
      || existing.checkpoint.subworkflowDepthLimit !== effectiveDepthLimit
      || existing.checkpoint.invocationId !== request.invocationId) {
      throw new WorkflowExecutionError('INVOCATION_CONFLICT', `invocation ${request.invocationId} was already bound to different immutable inputs`)
    }
    return this.resume({
      runId: id,
      owner: request.owner,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.onEvent === undefined ? {} : { onEvent: request.onEvent }),
    })
  }

  #startNew(
    id: string,
    workflow: CompiledWorkflow,
    inputs: JsonObject,
    depth: number,
    subworkflowDepthLimit: number,
    invocationId: string | undefined,
    request: WorkflowStartRequest,
  ): WorkflowRun {
    const state = createInitialState(workflow, depth, subworkflowDepthLimit, invocationId)
    const createdAt = this.#now()
    this.#runStore?.createRun({
      runId: id,
      template: workflow.template,
      semanticHash: workflow.semanticHash,
      inputs,
      createdAt,
      checkpoint: checkpointOf(id, workflow.semanticHash, state, createdAt, 0),
      events: [],
    })
    return this.#startOwnedRun({
      id,
      createdAt,
      workflow,
      inputs,
      state,
      owner: request.owner,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.onEvent === undefined ? {} : { onEvent: request.onEvent }),
      initialEvents: [{ type: 'run.started' }, { type: 'node.ready', nodeId: workflow.startNodeId }],
      initializeStart: true,
    })
  }

  resume(request: WorkflowResumeRequest): WorkflowRun {
    if (this.#runStore === undefined) throw new WorkflowExecutionError('RUN_STORE_MISSING', 'resume requires a WorkflowRunStore')
    const record = this.#runStore.loadRun(request.runId)
    if (record === undefined) throw new WorkflowExecutionError('RUN_NOT_FOUND', `workflow run not found: ${request.runId}`)
    const workflow = compileWorkflowOrThrow(record.template, this.#registry)
    if (workflow.semanticHash !== record.semanticHash || workflow.semanticHash !== record.checkpoint.semanticHash) {
      throw new WorkflowExecutionError('CHECKPOINT_TEMPLATE_MISMATCH', 'checkpoint semantic hash does not match the stored template')
    }
    const state = restoreState(record, workflow)
    if (state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled') {
      return terminalRun(record.runId, state)
    }

    const attentionEvents: WorkflowEventInput[] = []
    const explicitFailures: string[] = []
    for (const [nodeId, status] of state.nodeStates) {
      if (status !== 'running' && status !== 'waiting' && status !== 'needs_attention') continue
      const resolution = request.unknownNodeResolutions?.[nodeId]
      const definition = workflow.nodes.get(nodeId)!.definition
      if (resolution === 'fail') {
        state.nodeStates.set(nodeId, 'failed')
        explicitFailures.push(nodeId)
      } else if (resolution === 'retry' || ((status === 'running' || status === 'waiting') && definition.retry !== 'never')) {
        state.nodeStates.set(nodeId, 'ready')
        if (!state.ready.includes(nodeId)) state.ready.push(nodeId)
        attentionEvents.push({ type: 'node.ready', nodeId })
      } else {
        state.nodeStates.set(nodeId, 'needs_attention')
        if (status !== 'needs_attention') attentionEvents.push({ type: 'node.needs-attention', nodeId })
      }
    }
    sortReady(state.ready, workflow)

    if (explicitFailures.length > 0) {
      state.status = 'failed'
      state.error = `operator marked unknown nodes failed: ${explicitFailures.join(', ')}`
      const events: WorkflowEventInput[] = [
        ...explicitFailures.map(nodeId => ({ type: 'node.failed' as const, nodeId, error: state.error! })),
        { type: 'run.failed', error: state.error },
      ]
      this.#commit(record.runId, workflow, state, events, request.onEvent, request.owner)
      return terminalRun(record.runId, state)
    }

    const needsAttention = attentionNodeIds(state)
    if (needsAttention.length > 0) {
      state.status = 'paused'
      state.error = `nodes require an explicit retry/fail decision: ${needsAttention.join(', ')}`
      if (attentionEvents.length > 0 || record.checkpoint.status !== 'paused') {
        this.#commit(record.runId, workflow, state, [
          ...attentionEvents,
          { type: 'run.paused', reason: state.error },
        ], request.onEvent, request.owner)
      }
      return terminalRun(record.runId, state)
    }

    state.status = 'running'
    delete state.error
    return this.#startOwnedRun({
      id: record.runId,
      createdAt: record.createdAt,
      workflow,
      inputs: record.inputs,
      state,
      owner: request.owner,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.onEvent === undefined ? {} : { onEvent: request.onEvent }),
      initialEvents: [{ type: 'run.resumed' }, ...attentionEvents],
      initializeStart: false,
    })
  }

  #startOwnedRun(options: {
    readonly id: string
    readonly createdAt: number
    readonly workflow: CompiledWorkflow
    readonly inputs: JsonObject
    readonly state: RuntimeState
    readonly owner: unknown
    readonly signal?: AbortSignal
    readonly onEvent?: (event: WorkflowEvent) => void
    readonly initialEvents: readonly WorkflowEventInput[]
    readonly initializeStart: boolean
  }): WorkflowRun {
    const controller = new AbortController()
    let cancelReason = 'cancelled'
    const abortFromCaller = () => {
      cancelReason = renderAbortReason(options.signal?.reason, 'caller cancelled')
      controller.abort(options.signal?.reason)
    }
    if (options.signal?.aborted === true) abortFromCaller()
    else options.signal?.addEventListener('abort', abortFromCaller, { once: true })

    const result = this.#execute({
      ...options,
      controller,
      cancelReason: () => cancelReason,
    }).catch((error: unknown): WorkflowRunFailure => {
      options.state.status = 'failed'
      options.state.error = renderError(error)
      return failureResult(options.id, options.state)
    }).finally(() => options.signal?.removeEventListener('abort', abortFromCaller))

    return {
      id: options.id,
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

  async #execute(options: {
    readonly id: string
    readonly createdAt: number
    readonly workflow: CompiledWorkflow
    readonly inputs: JsonObject
    readonly state: RuntimeState
    readonly owner: unknown
    readonly controller: AbortController
    readonly cancelReason: () => string
    readonly onEvent?: (event: WorkflowEvent) => void
    readonly initialEvents: readonly WorkflowEventInput[]
    readonly initializeStart: boolean
  }): Promise<WorkflowRunResult> {
    const { id: runId, workflow, inputs: workflowInputs, state, owner, controller, onEvent } = options
    const services = this.#services
    const commit = (events: readonly WorkflowEventInput[]): void => {
      this.#commit(runId, workflow, state, events, onEvent, owner)
    }
    const policies = { ...DEFAULT_POLICIES, ...workflow.template.spec.policies }
    let deadlineExceeded = false
    const active = new Map<string, Promise<NodeCompletion>>()
    if (options.initializeStart) {
      state.nodeStates.set(workflow.startNodeId, 'ready')
      state.ready.push(workflow.startNodeId)
    }
    commit(options.initialEvents)

    const remainingDurationMs = Math.max(0, policies.maxDurationMs - Math.max(0, this.#now() - options.createdAt))
    let deadline: ReturnType<typeof setTimeout> | undefined
    if (remainingDurationMs === 0) {
      deadlineExceeded = true
      controller.abort('workflow duration exceeded')
    } else {
      deadline = setTimeout(() => {
        deadlineExceeded = true
        controller.abort('workflow duration exceeded')
      }, remainingDurationMs)
    }

    try {
      while (state.ready.length > 0 || active.size > 0) {
        if (controller.signal.aborted && active.size === 0) {
          return finishCancellation(deadlineExceeded ? 'workflow duration exceeded' : options.cancelReason(), deadlineExceeded)
        }

        const launch: { readonly nodeId: string; readonly node: CompiledWorkflowNode }[] = []
        while (!controller.signal.aborted && state.ready.length > 0 && active.size + launch.length < policies.maxConcurrentNodes) {
          if (state.nodeRuns + 1 > policies.maxNodeRuns) {
            controller.abort('workflow exceeded maxNodeRuns')
            await settleActive(active)
            return finishFailure('workflow exceeded maxNodeRuns')
          }
          const nodeId = state.ready.shift()!
          const node = workflow.nodes.get(nodeId)!
          state.nodeRuns++
          state.nodeStates.set(nodeId, node.definition.execution === 'human-wait' ? 'waiting' : 'running')
          launch.push({ nodeId, node })
        }
        if (launch.length > 0) {
          commit(launch.flatMap(item => item.node.definition.execution === 'human-wait'
            ? [{ type: 'node.started' as const, nodeId: item.nodeId }, { type: 'node.waiting' as const, nodeId: item.nodeId }]
            : [{ type: 'node.started' as const, nodeId: item.nodeId }]))
          for (const item of launch) {
            active.set(item.nodeId, this.#executeNode(
              runId,
              item.node,
              workflowInputs,
              state,
              owner,
              controller.signal,
              policies.maxOutputBytes,
              Math.min(state.subworkflowDepthLimit, policies.subworkflowMaxDepth ?? 8),
              progress => {
                if (controller.signal.aborted) throw new WorkflowExecutionError('WORKFLOW_CANCELLED', 'cannot checkpoint node progress after cancellation', { nodeId: item.nodeId })
                const value = snapshotJsonValue(progress)
                assertOutputSize(value, policies.maxOutputBytes, `node ${item.nodeId} progress`)
                state.nodeProgress.set(item.nodeId, value)
                try {
                  commit([{ type: 'node.progress', nodeId: item.nodeId }])
                } catch (error: unknown) {
                  throw new WorkflowCommitFailure(error)
                }
              },
            ))
          }
        }

        if (active.size === 0) continue
        const completion = await Promise.race(active.values())
        active.delete(completion.nodeId)
        if (!completion.ok) {
          if (completion.error instanceof WorkflowPauseError) {
            return finishPause(completion.nodeId, completion.error.message)
          }
          if (controller.signal.aborted) {
            state.nodeStates.set(completion.nodeId, 'cancelled')
            const cancelled = await settleActive(active)
            return finishCancellation(deadlineExceeded ? 'workflow duration exceeded' : options.cancelReason(), deadlineExceeded, [completion.nodeId, ...cancelled])
          }
          const error = renderError(completion.error)
          state.nodeStates.set(completion.nodeId, 'failed')
          controller.abort(`node ${completion.nodeId} failed`)
          const cancelled = await settleActive(active)
          return finishFailure(error, completion.nodeId, cancelled)
        }

        state.nodeStates.set(completion.nodeId, 'succeeded')
        state.nodeOutputs.set(completion.nodeId, completion.result.outputs)
        const events: WorkflowEventInput[] = [{ type: 'node.completed', nodeId: completion.nodeId }]
        settleOutgoingEdges(completion.nodeId, completion.result.selectedPorts ?? ['success'], events)
        commit(events)
      }

      const unresolved = [...state.nodeStates].filter(([, status]) => status === 'pending' || status === 'ready' || status === 'running' || status === 'waiting')
      if (unresolved.length > 0) return finishFailure(`scheduler stopped with unresolved nodes: ${unresolved.map(([id]) => id).join(', ')}`)

      const outputs = snapshotJsonObject(await resolveBindings(workflow.template.spec.outputs, undefined))
      const outputErrors = workflow.validateWorkflowOutputs(outputs)
      if (outputErrors.length > 0) return finishFailure(`workflow output is invalid: ${outputErrors.join('; ')}`)
      assertOutputSize(outputs, policies.maxOutputBytes, 'workflow result')
      state.status = 'completed'
      state.resultOutputs = outputs
      delete state.error
      commit([{ type: 'run.completed' }])
      return successResult(runId, state)
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        return finishCancellation(deadlineExceeded ? 'workflow duration exceeded' : options.cancelReason(), deadlineExceeded)
      }
      state.status = 'failed'
      state.error = renderError(error)
      return failureResult(runId, state)
    } finally {
      if (deadline !== undefined) clearTimeout(deadline)
    }

    async function settleActive(pending: ReadonlyMap<string, Promise<NodeCompletion>>): Promise<string[]> {
      await Promise.allSettled(pending.values())
      const cancelled: string[] = []
      for (const nodeId of pending.keys()) {
        if (state.nodeStates.get(nodeId) === 'running' || state.nodeStates.get(nodeId) === 'waiting') {
          state.nodeStates.set(nodeId, 'cancelled')
          cancelled.push(nodeId)
        }
      }
      return cancelled
    }

    function finishFailure(error: string, failedNodeId?: string, cancelled: readonly string[] = []): WorkflowRunFailure {
      state.status = 'failed'
      state.error = error
      const events: WorkflowEventInput[] = [
        ...(failedNodeId === undefined ? [] : [{ type: 'node.failed' as const, nodeId: failedNodeId, error }]),
        ...cancelled.map(nodeId => ({ type: 'node.cancelled' as const, nodeId })),
        { type: 'run.failed', error },
      ]
      commit(events)
      return failureResult(runId, state)
    }

    function finishCancellation(reason: string, asFailure: boolean, explicit: readonly string[] = []): WorkflowRunFailure {
      const cancelled = new Set(explicit)
      for (const [nodeId, status] of state.nodeStates) {
        if (status === 'pending' || status === 'ready' || status === 'running' || status === 'waiting') {
          state.nodeStates.set(nodeId, 'cancelled')
          cancelled.add(nodeId)
        }
      }
      state.status = asFailure ? 'failed' : 'cancelled'
      state.error = reason
      commit([
        ...[...cancelled].map(nodeId => ({ type: 'node.cancelled' as const, nodeId })),
        asFailure ? { type: 'run.failed', error: reason } : { type: 'run.cancelled', reason },
      ])
      return failureResult(runId, state)
    }

    async function finishPause(nodeId: string, reason: string): Promise<WorkflowRunFailure> {
      state.nodeStates.set(nodeId, 'needs_attention')
      controller.abort('workflow paused for nested run attention')
      await Promise.allSettled(active.values())
      const events: WorkflowEventInput[] = [{ type: 'node.needs-attention', nodeId }]
      for (const activeNodeId of active.keys()) {
        const status = state.nodeStates.get(activeNodeId)
        if (status !== 'running' && status !== 'waiting') continue
        const definition = workflow.nodes.get(activeNodeId)!.definition
        if (definition.retry === 'never') {
          state.nodeStates.set(activeNodeId, 'needs_attention')
          events.push({ type: 'node.needs-attention', nodeId: activeNodeId })
        } else {
          state.nodeStates.set(activeNodeId, 'ready')
          if (!state.ready.includes(activeNodeId)) state.ready.push(activeNodeId)
          events.push({ type: 'node.ready', nodeId: activeNodeId })
        }
      }
      sortReady(state.ready, workflow)
      state.status = 'paused'
      state.error = reason
      events.push({ type: 'run.paused', reason })
      commit(events)
      return failureResult(runId, state)
    }

    function settleOutgoingEdges(nodeId: string, selectedPorts: readonly string[], events: WorkflowEventInput[]): void {
      const node = workflow.nodes.get(nodeId)!
      const selected = new Set(selectedPorts)
      for (const edge of node.outgoing) {
        const taken = selected.has(edge.sourcePort ?? 'success')
        state.edgeStates.set(edge.id, taken ? 'taken' : 'skipped')
        events.push({ type: taken ? 'edge.taken' : 'edge.skipped', edgeId: edge.id })
      }
      for (const target of new Set(node.outgoing.map(edge => edge.target))) reconcileNode(target, events)
    }

    function reconcileNode(nodeId: string, events: WorkflowEventInput[]): void {
      if (state.nodeStates.get(nodeId) !== 'pending') return
      const node = workflow.nodes.get(nodeId)!
      const statuses = node.incoming.map(edge => state.edgeStates.get(edge.id)!)
      if (statuses.some(status => status === 'unknown')) return
      if (statuses.some(status => status === 'taken')) {
        state.nodeStates.set(nodeId, 'ready')
        state.ready.push(nodeId)
        sortReady(state.ready, workflow)
        events.push({ type: 'node.ready', nodeId })
        return
      }
      state.nodeStates.set(nodeId, 'skipped')
      events.push({ type: 'node.skipped', nodeId })
      for (const edge of node.outgoing) {
        state.edgeStates.set(edge.id, 'skipped')
        events.push({ type: 'edge.skipped', edgeId: edge.id })
      }
      for (const target of new Set(node.outgoing.map(edge => edge.target))) reconcileNode(target, events)
    }

    async function resolveBindings(bindings: Readonly<Record<string, WorkflowBinding>>, nodeId: string | undefined): Promise<JsonObject> {
      const result: JsonObject = {}
      for (const [name, binding] of Object.entries(bindings)) result[name] = await resolveBinding(binding, nodeId)
      return result
    }

    async function resolveBinding(binding: WorkflowBinding, nodeId: string | undefined): Promise<JsonValue> {
      if ('literal' in binding) return snapshotJsonValue(binding.literal)
      if ('input' in binding) {
        if (!(binding.input in workflowInputs)) throw executionError('WORKFLOW_INPUT_MISSING', `workflow input is missing: ${binding.input}`, nodeId)
        return snapshotJsonValue(workflowInputs[binding.input]!)
      }
      if ('secret' in binding) {
        if (nodeId === undefined) throw new WorkflowExecutionError('SECRET_OUTPUT_FORBIDDEN', 'workflow outputs cannot contain secret bindings')
        if (services.secrets === undefined) throw executionError('SECRET_GATEWAY_MISSING', `secret gateway is required for ${binding.secret.ref}`, nodeId)
        return services.secrets.resolve(binding.secret.ref, { runId, nodeId, signal: controller.signal })
      }
      const source = state.nodeOutputs.get(binding.output.node)
      if (source === undefined) throw executionError('BINDING_SOURCE_UNAVAILABLE', `output is unavailable from node ${binding.output.node}`, nodeId)
      return snapshotJsonValue(readPath(source, binding.output.path, binding.output.node))
    }
  }

  #commit(
    runId: string,
    workflow: CompiledWorkflow,
    state: RuntimeState,
    inputs: readonly WorkflowEventInput[],
    onEvent: ((event: WorkflowEvent) => void) | undefined,
    _owner: unknown,
  ): void {
    if (inputs.length === 0) return
    let nextSeq = state.seq
    const events = inputs.map(input => ({ ...input, runId, seq: ++nextSeq }) as WorkflowEvent)
    const checkpointSeq = ++nextSeq
    events.push({ type: 'checkpoint.committed', runId, seq: checkpointSeq, checkpointSeq })
    const checkpoint = checkpointOf(runId, workflow.semanticHash, state, this.#now(), nextSeq)
    this.#runStore?.commit(runId, state.seq, checkpoint, events)
    state.seq = nextSeq
    state.events.push(...events)
    for (const event of events) {
      try { onEvent?.(event) } catch { /* observers cannot affect execution */ }
    }
  }

  async #executeNode(
    runId: string,
    node: CompiledWorkflowNode,
    workflowInputs: JsonObject,
    state: RuntimeState,
    owner: unknown,
    runSignal: AbortSignal,
    maxOutputBytes: number,
    subworkflowMaxDepth: number,
    checkpointProgress: (progress: JsonValue) => void,
  ): Promise<NodeCompletion> {
    try {
      const inputs = snapshotJsonObject(await resolveNodeInputs(node, workflowInputs, state.nodeOutputs, runId, runSignal, this.#services))
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
        depth: state.depth,
        subworkflowMaxDepth,
        ...(state.nodeProgress.get(node.template.id) === undefined ? {} : { progress: state.nodeProgress.get(node.template.id)! }),
        checkpointProgress,
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
      assertOutputSize(outputs, maxOutputBytes, `node ${node.template.id} output`)
      return { nodeId: node.template.id, ok: true, result }
    } catch (error: unknown) {
      if (error instanceof WorkflowCommitFailure) throw error.original
      return { nodeId: node.template.id, ok: false, error }
    }
  }
}

function createInitialState(workflow: CompiledWorkflow, depth: number, subworkflowDepthLimit: number, invocationId?: string): RuntimeState {
  return {
    nodeStates: new Map([...workflow.nodes.keys()].map(id => [id, 'pending'] as const)),
    edgeStates: new Map([...workflow.edges.keys()].map(id => [id, 'unknown'] as const)),
    nodeOutputs: new Map(),
    nodeProgress: new Map(),
    ready: [],
    events: [],
    nodeRuns: 0,
    seq: 0,
    status: 'running',
    depth,
    subworkflowDepthLimit,
    ...(invocationId === undefined ? {} : { invocationId }),
  }
}

function restoreState(record: WorkflowRunRecord, workflow: CompiledWorkflow): RuntimeState {
  const checkpoint = record.checkpoint
  const nodeIds = [...workflow.nodes.keys()].sort()
  const edgeIds = [...workflow.edges.keys()].sort()
  if (Object.keys(checkpoint.nodeStates).sort().join('\0') !== nodeIds.join('\0')
    || Object.keys(checkpoint.edgeStates).sort().join('\0') !== edgeIds.join('\0')
    || checkpoint.seq !== (record.events.at(-1)?.seq ?? 0)
    || !Number.isSafeInteger(checkpoint.depth ?? 0)
    || (checkpoint.depth ?? 0) < 0) {
    throw new WorkflowExecutionError('CHECKPOINT_INVALID', 'checkpoint graph keys or event sequence do not match the stored run')
  }
  const state: RuntimeState = {
    nodeStates: new Map(Object.entries(checkpoint.nodeStates)),
    edgeStates: new Map(Object.entries(checkpoint.edgeStates)),
    nodeOutputs: new Map(Object.entries(checkpoint.nodeOutputs)),
    nodeProgress: new Map(Object.entries(checkpoint.nodeProgress ?? {})),
    ready: [...checkpoint.ready],
    events: [...record.events],
    nodeRuns: checkpoint.nodeRuns,
    seq: checkpoint.seq,
    status: checkpoint.status,
    depth: checkpoint.depth ?? 0,
    subworkflowDepthLimit: checkpoint.subworkflowDepthLimit ?? workflow.template.spec.policies?.subworkflowMaxDepth ?? 8,
    ...(checkpoint.invocationId === undefined ? {} : { invocationId: checkpoint.invocationId }),
    ...(checkpoint.error === undefined ? {} : { error: checkpoint.error }),
    ...(checkpoint.resultOutputs === undefined ? {} : { resultOutputs: checkpoint.resultOutputs }),
  }
  for (const nodeId of state.ready) {
    if (state.nodeStates.get(nodeId) !== 'ready') throw new WorkflowExecutionError('CHECKPOINT_INVALID', `ready queue contains non-ready node ${nodeId}`)
  }
  return state
}

function checkpointOf(
  runId: string,
  semanticHash: string,
  state: RuntimeState,
  updatedAt: number,
  seq: number,
): WorkflowRunCheckpoint {
  return snapshotJsonValue({
    version: 1,
    runId,
    semanticHash,
    seq,
    status: state.status,
    nodeStates: Object.fromEntries(state.nodeStates),
    edgeStates: Object.fromEntries(state.edgeStates),
    nodeOutputs: Object.fromEntries(state.nodeOutputs),
    nodeProgress: Object.fromEntries(state.nodeProgress),
    ready: state.ready,
    nodeRuns: state.nodeRuns,
    depth: state.depth,
    subworkflowDepthLimit: state.subworkflowDepthLimit,
    ...(state.invocationId === undefined ? {} : { invocationId: state.invocationId }),
    updatedAt,
    ...(state.resultOutputs === undefined ? {} : { resultOutputs: state.resultOutputs }),
    ...(state.error === undefined ? {} : { error: state.error }),
  }) as unknown as WorkflowRunCheckpoint
}

function invocationRunId(invocationId: string): string {
  return `dag-child-${createHash('sha256').update(invocationId).digest('hex').slice(0, 40)}`
}

function terminalRun(runId: string, state: RuntimeState): WorkflowRun {
  const result = Promise.resolve(state.status === 'completed' ? successResult(runId, state) : failureResult(runId, state))
  return { id: runId, result, cancel() {}, async dispose() { await result } }
}

function successResult(runId: string, state: RuntimeState): WorkflowRunSuccess {
  if (state.resultOutputs === undefined) throw new WorkflowExecutionError('CHECKPOINT_INVALID', 'completed run is missing result outputs')
  return {
    status: 'completed',
    runId,
    outputs: state.resultOutputs,
    nodeStates: Object.fromEntries(state.nodeStates),
    edgeStates: Object.fromEntries(state.edgeStates),
    events: [...state.events],
  }
}

function failureResult(runId: string, state: RuntimeState): WorkflowRunFailure {
  const status = state.status === 'paused' ? 'paused' : state.status === 'cancelled' ? 'cancelled' : 'failed'
  const needsAttention = attentionNodeIds(state)
  return {
    status,
    runId,
    error: state.error ?? status,
    nodeStates: Object.fromEntries(state.nodeStates),
    edgeStates: Object.fromEntries(state.edgeStates),
    events: [...state.events],
    ...(needsAttention.length === 0 ? {} : { needsAttention }),
  }
}

function attentionNodeIds(state: RuntimeState): string[] {
  return [...state.nodeStates].filter(([, status]) => status === 'needs_attention').map(([id]) => id).sort()
}

function sortReady(ready: string[], workflow: CompiledWorkflow): void {
  ready.sort((left, right) => workflow.order.indexOf(left) - workflow.order.indexOf(right))
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

function executionError(code: string, message: string, nodeId: string | undefined): WorkflowExecutionError {
  return new WorkflowExecutionError(code, message, nodeId === undefined ? undefined : { nodeId })
}

function assertOutputSize(value: JsonValue, maxBytes: number, label: string): void {
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
  if (bytes > maxBytes) throw new WorkflowExecutionError('OUTPUT_TOO_LARGE', `${label} is ${bytes} bytes, limit is ${maxBytes}`)
}

function renderAbortReason(reason: unknown, fallback: string): string {
  return reason === undefined ? fallback : renderError(reason)
}

function renderError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
