import { createHash } from 'node:crypto'
import {
  DagWorkflowEngine,
  WORKFLOW_ENGINE_VERSION,
  compileWorkflowOrThrow,
  snapshotJsonObject,
  snapshotJsonValue,
  type JsonObject,
  type JsonValue,
  type WorkflowAuthorityResolver,
  type WorkflowEngineServices,
  type WorkflowEvent,
  type WorkflowExecutionPlanEntry,
  type WorkflowExecutionPlanSnapshot,
  type WorkflowNodeRegistry,
  type WorkflowRun,
  type WorkflowRunRecord,
  type WorkflowRunResult,
  type WorkflowRunStore,
  type WorkflowTemplate,
  stableJsonStringify,
  isJsonObject,
  WorkflowPauseError,
} from '../core/index.js'
import type { WorkflowTemplateCatalog } from '../catalog/index.js'
import type { WorkflowArtifactStore, WorkflowCapturePolicy } from '../journal/index.js'
import { WorkflowLiveEventBus } from './live.js'
import type {
  WorkflowEventPage,
  WorkflowLaunchRequest,
  WorkflowReplayRequest,
  WorkflowRunHandle,
  WorkflowRunSummary,
  WorkflowRunQueue,
  WorkflowRuntimeApi,
} from './types.js'

export interface WorkflowRuntimeOptions {
  readonly nodes: WorkflowNodeRegistry
  readonly catalog: WorkflowTemplateCatalog
  readonly runStore: WorkflowRunStore
  readonly services?: WorkflowEngineServices
  readonly authorityResolver?: WorkflowAuthorityResolver
  readonly liveEvents?: WorkflowLiveEventBus
  readonly allowInline?: boolean
  readonly artifactStore?: WorkflowArtifactStore
  readonly capturePolicy?: WorkflowCapturePolicy
  readonly queue?: WorkflowRunQueue
}

export class WorkflowRuntime implements WorkflowRuntimeApi {
  readonly #nodes: WorkflowNodeRegistry
  readonly #catalog: WorkflowTemplateCatalog
  readonly #runStore: WorkflowRunStore
  readonly #services: WorkflowEngineServices
  readonly #authorityResolver: WorkflowAuthorityResolver | undefined
  readonly #live: WorkflowLiveEventBus
  readonly #allowInline: boolean
  readonly #capture: import('../core/index.js').WorkflowDataCaptureGateway
  readonly #capturePolicy: WorkflowCapturePolicy
  readonly #artifactStore: WorkflowArtifactStore | undefined
  readonly #queue: WorkflowRunQueue | undefined
  readonly #idempotent = new Map<string, { readonly fingerprint: string; readonly handle: Promise<WorkflowRunHandle> }>()

  constructor(options: WorkflowRuntimeOptions) {
    this.#nodes = options.nodes
    this.#catalog = options.catalog
    this.#runStore = options.runStore
    this.#services = options.services ?? {}
    this.#authorityResolver = options.authorityResolver
    this.#live = options.liveEvents ?? new WorkflowLiveEventBus()
    this.#allowInline = options.allowInline ?? true
    this.#queue = options.queue
    const policy = options.capturePolicy ?? { mode: 'metadata', maxArtifactBytes: 1024 * 1024 }
    if (!Number.isSafeInteger(policy.maxArtifactBytes) || policy.maxArtifactBytes < 0) throw new Error('capturePolicy.maxArtifactBytes must be a non-negative safe integer')
    if (policy.mode === 'replayable' && options.artifactStore === undefined) throw new Error('replayable capture policy requires an artifact store')
    if (policy.encryptArtifacts === true && options.artifactStore?.capabilities?.encryptionAtRest !== true) {
      throw new Error('capturePolicy.encryptArtifacts requires an artifact store with encryptionAtRest capability')
    }
    if (policy.retentionDays !== undefined) {
      if (!Number.isSafeInteger(policy.retentionDays) || policy.retentionDays <= 0) throw new Error('capturePolicy.retentionDays must be a positive safe integer')
      if (options.artifactStore?.capabilities?.retentionPolicy !== true) {
        throw new Error('capturePolicy.retentionDays requires an artifact store with retentionPolicy capability')
      }
    }
    this.#capturePolicy = policy
    this.#artifactStore = options.artifactStore
    this.#capture = createCaptureGateway(policy, options.artifactStore)
  }

  async validate(template: WorkflowTemplate) { return this.#catalog.validate(template) }
  async listNodes() {
    return this.#nodes.list().map(definition => snapshotJsonValue({
      uses: `${definition.type}@${definition.version}`,
      title: definition.title,
      description: definition.description,
      configSchema: definition.configSchema,
      inputSchema: definition.inputSchema,
      outputSchema: definition.outputSchema,
      outputPorts: definition.outputPorts,
      ...(definition.dependencyKinds === undefined ? {} : { dependencyKinds: definition.dependencyKinds }),
    }) as unknown as import('./types.js').WorkflowNodeDescriptor)
  }
  async listTemplates() { return this.#catalog.list() }
  async searchTemplates(request: import('../catalog/index.js').WorkflowCatalogSearchRequest = {}) { return this.#catalog.search(request) }
  async readDraft(id: string) { return this.#catalog.readDraft(id) }
  async getPublished(id: string, revision?: number) { return this.#catalog.getPublished(id, revision) }
  async diffDraft(id: string, candidate: WorkflowTemplate) { return this.#catalog.diff(id, candidate) }
  async createDraft(template: WorkflowTemplate) { return this.#catalog.createDraft(template) }
  async updateDraft(id: string, expectedRevision: number, template: WorkflowTemplate) { return this.#catalog.updateDraft(id, expectedRevision, template) }
  async publish(id: string, expectedDraftRevision: number) { return this.#catalog.publish(id, expectedDraftRevision) }

  async launch(request: WorkflowLaunchRequest): Promise<WorkflowRunHandle> {
    const key = request.idempotencyKey
    if (key === undefined) return this.#launch(request)
    if (key.length === 0 || key.length > 512) throw new Error('idempotencyKey must be 1-512 characters')
    const scoped = `${request.authorityRef}\0${key}`
    const existing = this.#idempotent.get(scoped)
    const fingerprint = launchRequestFingerprint(request)
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) throw new Error(`idempotency key is already bound to a different immutable launch: ${key}`)
      return existing.handle
    }
    const launched = this.#launch(request)
    this.#idempotent.set(scoped, { fingerprint, handle: launched })
    try {
      const handle = await launched
      if ((request.executionMode ?? 'foreground') === 'background') {
        // Persistence and queue insertion are complete. Do not observe the
        // lazy terminal result in an ingress/CLI process that only needs the
        // acceptance receipt.
        if (this.#idempotent.get(scoped)?.handle === launched) this.#idempotent.delete(scoped)
      } else {
        void handle.result.finally(() => {
          if (this.#idempotent.get(scoped)?.handle === launched) this.#idempotent.delete(scoped)
        })
      }
      return handle
    } catch (error: unknown) {
      this.#idempotent.delete(scoped)
      throw error
    }
  }

  async #launch(request: WorkflowLaunchRequest): Promise<WorkflowRunHandle> {
    const executionMode = request.executionMode ?? 'foreground'
    if (executionMode === 'background' && this.#queue === undefined) throw new Error('background workflow launch requires a WorkflowRunQueue')
    if (executionMode === 'background' && this.#authorityResolver === undefined) throw new Error('background workflow launch requires a WorkflowAuthorityResolver for worker recovery')
    const authority = await this.#resolveAuthority(request.authorityRef, request.authority, request.signal)
    const root = request.target.type === 'published'
      ? await this.#publishedEntry(request.target.id, request.target.revision)
      : this.#inlineEntry(request.target.template)
    if (request.target.type === 'inline' && !this.#allowInline) throw new Error('inline workflow launch is disabled by runtime policy')
    const plan = await this.#buildPlan(root)
    const emit = (event: WorkflowEvent) => { this.#projectLive(event); request.onEvent?.(event) }
    const engine = this.#createEngine(plan, request.authorityRef, authority, emit)
    const execution = {
      authorityRef: request.authorityRef,
      authority,
      origin: request.origin,
      ...(request.traceContext === undefined ? {} : { traceContext: request.traceContext }),
    }
    const inputs = snapshotJsonObject(request.inputs)
    const runId = request.idempotencyKey === undefined
      ? undefined
      : idempotentRunId(request.authorityRef, request.idempotencyKey)
    if (runId !== undefined) {
      const existing = await this.#runStore.loadRun(runId)
      if (existing !== undefined) {
        assertIdempotentLaunch(existing, request, plan, inputs)
        if (executionMode === 'background' && existing.checkpoint.status === 'running') await this.#queue!.enqueue(existing.runId)
        return this.#persistedHandle(existing)
      }
    }
    let run: WorkflowRun
    try {
      const startRequest = {
        ...(runId === undefined ? {} : { runId }),
        template: root.template,
        plan,
        inputs,
        execution,
        ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
        ...(request.deliveryRef === undefined ? {} : { deliveryRef: request.deliveryRef }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        onEvent: emit,
      }
      run = executionMode === 'background'
        ? await engine.queue(startRequest)
        : await engine.start(startRequest)
      if (executionMode === 'background') await this.#queue!.enqueue(run.id)
    } catch (error: unknown) {
      if (runId === undefined || !isRunAlreadyExists(error)) throw error
      const existing = await this.#runStore.loadRun(runId)
      if (existing === undefined) throw error
      assertIdempotentLaunch(existing, request, plan, inputs)
      if (executionMode === 'background' && existing.checkpoint.status === 'running') await this.#queue!.enqueue(existing.runId)
      return this.#persistedHandle(existing)
    }
    return this.#handle(run)
  }

  async resume(request: import('./types.js').WorkflowRuntimeResumeRequest): Promise<WorkflowRunHandle> {
    const record = await this.#runStore.loadRun(request.runId)
    if (record === undefined) throw new Error(`workflow run not found: ${request.runId}`)
    const authority = await this.#resolveAuthority(request.authorityRef, request.authority, request.signal)
    const emit = (event: WorkflowEvent) => { this.#projectLive(event); request.onEvent?.(event) }
    const engine = this.#createEngine(record.plan, request.authorityRef, authority, emit)
    const run = await engine.resume({
      runId: request.runId,
      execution: { authorityRef: request.authorityRef, authority, origin: { type: 'sdk', source: 'resume' } },
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.unknownNodeResolutions === undefined ? {} : { unknownNodeResolutions: request.unknownNodeResolutions }),
      onEvent: emit,
    })
    return this.#handle(run)
  }

  async getRun(runId: string): Promise<WorkflowRunSummary | undefined> {
    const [metadata, checkpoint] = await Promise.all([
      this.#runStore.getRunMetadata(runId),
      this.#runStore.getCheckpoint(runId),
    ])
    if (metadata === undefined || checkpoint === undefined) return undefined
    const needsAttention = Object.entries(checkpoint.nodeStates)
      .filter(([, status]) => status === 'needs_attention')
      .map(([nodeId]) => nodeId)
      .sort()
    return {
      runId: metadata.runId,
      templateId: metadata.templateId,
      status: checkpoint.status,
      semanticHash: metadata.semanticHash,
      plan: metadata.plan,
      authorityRef: metadata.execution.authorityRef,
      origin: metadata.execution.origin,
      createdAt: metadata.createdAt,
      updatedAt: checkpoint.updatedAt,
      checkpointSeq: checkpoint.seq,
      nodeStates: checkpoint.nodeStates,
      edgeStates: checkpoint.edgeStates,
      ...(checkpoint.resultOutputs === undefined ? {} : { outputs: checkpoint.resultOutputs }),
      ...(checkpoint.error === undefined ? {} : { error: checkpoint.error }),
      ...(needsAttention.length === 0 ? {} : { needsAttention }),
    }
  }

  async readEvents(runId: string, query: { readonly afterSeq?: number; readonly limit?: number } = {}): Promise<WorkflowEventPage> {
    const after = query.afterSeq ?? 0
    const limit = Math.min(1000, Math.max(1, query.limit ?? 100))
    const page = await this.#runStore.readEvents(runId, { afterSeq: after, limit: limit + 1 })
    const events = page.slice(0, limit)
    const last = events.at(-1)?.seq
    return { events, ...(page.length > limit && last !== undefined ? { nextAfterSeq: last } : {}) }
  }

  async replay(request: WorkflowReplayRequest): Promise<WorkflowRunHandle> {
    const record = await this.#runStore.loadRun(request.runId)
    if (record === undefined) throw new Error(`workflow run not found: ${request.runId}`)
    if (request.mode === 'inspect') return historicalHandle(record)
    if (request.mode === 'recorded') {
      if (!record.plan.replayable) throw new Error('recorded replay requires implementation digests for every node definition')
      if (record.checkpoint.status !== 'completed') throw new Error('recorded replay requires a completed source run')
      const missing = record.template.spec.nodes
        .filter(node => isExternalUses(node.uses) && record.checkpoint.nodeOutputs[node.id] === undefined)
        .map(node => node.id)
      if (missing.length > 0) throw new Error(`recorded replay is missing committed external outputs: ${missing.join(', ')}`)
      if (this.#capturePolicy.mode === 'replayable') await verifyReplayArtifacts(record, this.#artifactStore)
      const engine = new DagWorkflowEngine(this.#nodes, this.#services, { runStore: this.#runStore, capture: this.#capture })
      const run = await engine.start({
        template: record.plan.root.template,
        plan: record.plan,
        inputs: record.inputs,
        execution: {
          authorityRef: record.execution.authorityRef,
          authority: request.authority,
          origin: { type: 'replay', source: 'recorded', sourceRef: request.runId },
        },
        recordedNodeOutputs: record.checkpoint.nodeOutputs,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        onEvent: event => this.#projectLive(event),
      })
      return this.#handle(run)
    }
    return this.launch({
      target: record.plan.root.revision === undefined
        ? { type: 'inline', template: record.plan.root.template }
        : { type: 'published', id: record.plan.root.id, revision: record.plan.root.revision },
      inputs: record.inputs,
      authorityRef: request.authorityRef ?? record.execution.authorityRef,
      ...(request.authority === undefined ? {} : { authority: request.authority }),
      origin: { type: 'replay', source: 'live', sourceRef: request.runId },
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
  }

  async #buildPlan(root: WorkflowExecutionPlanEntry): Promise<WorkflowExecutionPlanSnapshot> {
    const dependencies = new Map<string, WorkflowExecutionPlanEntry & { readonly revision: number }>()
    const visit = async (template: WorkflowTemplate): Promise<void> => {
      for (const dependency of dependenciesOf(template)) {
        const key = `${dependency.id}@${dependency.revision}`
        if (dependencies.has(key)) continue
        const entry = await this.#publishedEntry(dependency.id, dependency.revision)
        if (entry.revision === undefined) throw new Error(`published dependency lost its revision: ${key}`)
        dependencies.set(key, entry as WorkflowExecutionPlanEntry & { readonly revision: number })
        await visit(entry.template)
      }
    }
    await visit(root.template)
    const entries = [...dependencies.values()].sort((left, right) => `${left.id}@${left.revision}`.localeCompare(`${right.id}@${right.revision}`))
    const uses = [root, ...entries].flatMap(entry => entry.template.spec.nodes.map(node => node.uses))
    const definitionSet = this.#nodes.definitionSet(uses)
    return snapshotJsonValue({
      root,
      dependencies: entries,
      engineVersion: WORKFLOW_ENGINE_VERSION,
      nodeDefinitionSetHash: definitionSet.hash,
      replayable: definitionSet.replayable,
    }) as unknown as WorkflowExecutionPlanSnapshot
  }

  #createEngine(
    plan: WorkflowExecutionPlanSnapshot,
    authorityRef: string,
    authority: unknown,
    emit: (event: WorkflowEvent) => void,
  ): DagWorkflowEngine {
    let engine: DagWorkflowEngine
    const services: WorkflowEngineServices = {
      ...this.#services,
      subworkflows: {
        execute: async child => {
          const entry = plan.dependencies.find(item => item.id === child.templateId && item.revision === child.revision)
          if (entry === undefined) throw new Error(`workflow dependency is not locked in the execution plan: ${child.templateId}@${child.revision}`)
          const childPlan = planForEntry(plan, entry, this.#nodes)
          const run = await engine.invoke({
            invocationId: child.invocationId,
            depth: child.depth,
            subworkflowDepthLimit: child.depthLimit,
            template: entry.template,
            plan: childPlan,
            inputs: child.inputs,
            execution: { authorityRef, authority, origin: { type: 'host', source: 'subworkflow', sourceRef: child.parentRunId } },
            signal: child.signal,
            onEvent: emit,
          })
          const result = await run.result
          if (result.status === 'paused') throw new WorkflowPauseError(`subworkflow ${result.runId} requires operator attention: ${result.error}`, result.runId)
          if (result.status !== 'completed') throw new Error(`subworkflow ${result.runId} ${result.status}: ${result.error}`)
          return { runId: result.runId, outputs: result.outputs }
        },
      },
    }
    engine = new DagWorkflowEngine(this.#nodes, services, { runStore: this.#runStore, capture: this.#capture })
    return engine
  }

  async #publishedEntry(id: string, revision: number): Promise<WorkflowExecutionPlanEntry & { readonly revision: number }> {
    const published = await this.#catalog.getPublished(id, revision)
    if (published.revision !== revision) throw new Error(`published revision mismatch: ${id}@${revision}`)
    compileWorkflowOrThrow(published.template, this.#nodes)
    return { id, revision, semanticHash: published.semanticHash, template: published.template }
  }

  #inlineEntry(template: WorkflowTemplate): WorkflowExecutionPlanEntry {
    const compiled = compileWorkflowOrThrow(template, this.#nodes)
    return { id: compiled.template.metadata.id, semanticHash: compiled.semanticHash, template: compiled.template }
  }

  async #resolveAuthority(authorityRef: string, authority: unknown, signal?: AbortSignal): Promise<unknown> {
    if (authority !== undefined) return authority
    if (this.#authorityResolver === undefined) throw new Error(`authority ${authorityRef} cannot be resolved without a WorkflowAuthorityResolver`)
    const resolved = await this.#authorityResolver.resolve(authorityRef, signal ?? new AbortController().signal)
    if (resolved === undefined) throw new Error(`workflow authority is unavailable: ${authorityRef}`)
    return resolved
  }

  #handle(run: WorkflowRun): WorkflowRunHandle {
    let observedResult: Promise<WorkflowRunResult> | undefined
    const live = this.#live
    return {
      runId: run.id,
      get result() {
        observedResult ??= run.result.finally(() => live.close(run.id))
        return observedResult
      },
      live: options => this.#live.subscribe(run.id, options?.signal),
      cancel: reason => run.cancel(reason),
    }
  }

  #persistedHandle(record: WorkflowRunRecord): WorkflowRunHandle {
    if (isTerminal(record.checkpoint.status)) return historicalHandle(record)
    const runId = record.runId
    const store = this.#runStore
    let observedResult: Promise<WorkflowRunResult> | undefined
    return {
      runId,
      get result() {
        observedResult ??= waitForPersistedResult(store, runId)
        return observedResult
      },
      live: options => this.#live.subscribe(runId, options?.signal),
      async cancel() {},
    }
  }

  #projectLive(event: WorkflowEvent): void {
    if (event.type !== 'node.progress' || event.node === undefined) return
    this.#live.publish({
      schemaVersion: 1,
      runId: event.runId,
      nodeId: event.node.id,
      invocationId: event.node.invocationId,
      liveSeq: event.seq,
      type: 'node.progress',
      data: event.payload,
    })
  }
}

async function verifyReplayArtifacts(
  record: WorkflowRunRecord,
  store: WorkflowArtifactStore | undefined,
): Promise<void> {
  if (store === undefined) throw new Error('recorded replay requires the configured artifact store')
  const decoder = new TextDecoder()
  for (const node of record.template.spec.nodes.filter(item => isExternalUses(item.uses))) {
    const event = record.events.findLast(item => item.type === 'capability.completed' && item.node?.id === node.id)
    const rawRef = event?.payload.artifact
    if (!isArtifactRef(rawRef)) throw new Error(`recorded replay is missing replayable artifact for external node: ${node.id}`)
    if (rawRef.redacted) throw new Error(`recorded replay cannot use a redacted artifact for external node: ${node.id}`)
    const artifacts = await store.read([rawRef])
    const artifact = artifacts[0]
    if (artifact === undefined) throw new Error(`recorded replay artifact is unavailable for external node: ${node.id}`)
    if (artifact.redacted) throw new Error(`recorded replay cannot use a redacted artifact for external node: ${node.id}`)
    let captured: unknown
    try { captured = JSON.parse(decoder.decode(artifact.content)) } catch { throw new Error(`recorded replay artifact is not valid JSON for external node: ${node.id}`) }
    const committed = record.checkpoint.nodeOutputs[node.id]
    if (committed === undefined || stableJsonStringify(captured as JsonValue) !== stableJsonStringify(committed)) {
      throw new Error(`recorded replay artifact does not match committed output for external node: ${node.id}`)
    }
  }
}

function isArtifactRef(value: JsonValue | undefined): value is JsonObject & import('../journal/index.js').WorkflowArtifactRef {
  return isJsonObject(value)
    && typeof value.digest === 'string' && typeof value.size === 'number'
    && typeof value.mediaType === 'string' && typeof value.redacted === 'boolean'
}

function createCaptureGateway(
  policy: WorkflowCapturePolicy,
  store: WorkflowArtifactStore | undefined,
): import('../core/index.js').WorkflowDataCaptureGateway {
  const encoder = new TextEncoder()
  return {
    async capture(request) {
      const content = encoder.encode(stableJsonStringify(request.value))
      const dataHash = createHash('sha256').update(content).digest('hex')
      if (policy.mode === 'metadata' || store === undefined || content.byteLength > policy.maxArtifactBytes) return { dataHash }
      const artifact = await store.put(content, { mediaType: 'application/json', redacted: false })
      return { dataHash, artifact }
    },
  }
}

function isExternalUses(uses: string): boolean {
  return uses === 'tool.call@1' || uses === 'agent.run@1' || uses === 'human.approval@1'
    || uses === 'workflow.call@1' || uses === 'core.foreach@1'
}

function idempotentRunId(authorityRef: string, key: string): string {
  const digest = createHash('sha256').update(authorityRef).update('\0').update(key).digest('hex')
  return `dag-idem-${digest.slice(0, 40)}`
}

function launchRequestFingerprint(request: WorkflowLaunchRequest): string {
  const target = request.target.type === 'published'
    ? `published:${request.target.id}@${request.target.revision}`
    : `inline:${stableJsonStringify(request.target.template as unknown as import('../core/index.js').JsonValue)}`
  return createHash('sha256')
    .update(target)
    .update('\0')
    .update(stableJsonStringify(request.inputs))
    .update('\0')
    .update(request.deliveryRef ?? '')
    .update('\0')
    .update(request.executionMode ?? 'foreground')
    .digest('hex')
}

function assertIdempotentLaunch(
  record: WorkflowRunRecord,
  request: WorkflowLaunchRequest,
  plan: WorkflowExecutionPlanSnapshot,
  inputs: JsonObject,
): void {
  const matches = record.execution.authorityRef === request.authorityRef
    && record.launch.idempotencyKey === request.idempotencyKey
    && record.launch.deliveryRef === request.deliveryRef
    && (record.launch.executionMode ?? 'foreground') === (request.executionMode ?? 'foreground')
    && record.semanticHash === plan.root.semanticHash
    && stableJsonStringify(record.inputs) === stableJsonStringify(inputs)
  if (!matches) throw new Error(`idempotency key is already bound to a different immutable launch: ${request.idempotencyKey}`)
}

function isRunAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'RUN_ALREADY_EXISTS'
}

function isTerminal(status: WorkflowRunRecord['checkpoint']['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

async function waitForPersistedResult(store: WorkflowRunStore, runId: string): Promise<WorkflowRunResult> {
  for (;;) {
    const record = await store.loadRun(runId)
    if (record === undefined) throw new Error(`workflow run disappeared while awaiting idempotent result: ${runId}`)
    if (isTerminal(record.checkpoint.status) || record.checkpoint.status === 'paused') return resultOf(record)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

function dependenciesOf(template: WorkflowTemplate): { readonly id: string; readonly revision: number }[] {
  return template.spec.nodes.flatMap(node => {
    if (node.uses !== 'workflow.call@1' && node.uses !== 'core.foreach@1') return []
    return typeof node.with.templateId === 'string' && typeof node.with.revision === 'number'
      ? [{ id: node.with.templateId, revision: node.with.revision }]
      : []
  })
}

function planForEntry(
  plan: WorkflowExecutionPlanSnapshot,
  root: WorkflowExecutionPlanEntry & { readonly revision: number },
  nodes: WorkflowNodeRegistry,
): WorkflowExecutionPlanSnapshot {
  const available = new Map(plan.dependencies.map(entry => [`${entry.id}@${entry.revision}`, entry]))
  const selected = new Map<string, WorkflowExecutionPlanEntry & { readonly revision: number }>()
  const visit = (template: WorkflowTemplate): void => {
    for (const dependency of dependenciesOf(template)) {
      const key = `${dependency.id}@${dependency.revision}`
      if (selected.has(key)) continue
      const entry = available.get(key)
      if (entry === undefined) throw new Error(`workflow dependency is missing from parent execution plan: ${key}`)
      selected.set(key, entry)
      visit(entry.template)
    }
  }
  visit(root.template)
  const dependencies = [...selected.values()].sort((left, right) => `${left.id}@${left.revision}`.localeCompare(`${right.id}@${right.revision}`))
  const definitionSet = nodes.definitionSet([root, ...dependencies].flatMap(entry => entry.template.spec.nodes.map(node => node.uses)))
  return snapshotJsonValue({
    root,
    dependencies,
    engineVersion: plan.engineVersion,
    nodeDefinitionSetHash: definitionSet.hash,
    replayable: definitionSet.replayable,
  }) as unknown as WorkflowExecutionPlanSnapshot
}

function historicalHandle(record: WorkflowRunRecord): WorkflowRunHandle {
  const result = Promise.resolve(resultOf(record))
  return {
    runId: record.runId,
    result,
    async *live() {},
    async cancel() {},
  }
}

function resultOf(record: WorkflowRunRecord): WorkflowRunResult {
  const checkpoint = record.checkpoint
  const common = {
    runId: record.runId,
    nodeStates: checkpoint.nodeStates,
    edgeStates: checkpoint.edgeStates,
    events: record.events,
  }
  if (checkpoint.status === 'completed' && checkpoint.resultOutputs !== undefined) {
    return { ...common, status: 'completed', outputs: checkpoint.resultOutputs }
  }
  return {
    ...common,
    status: checkpoint.status === 'cancelled' ? 'cancelled' : checkpoint.status === 'paused' ? 'paused' : 'failed',
    error: checkpoint.error ?? checkpoint.status,
    ...(Object.values(checkpoint.nodeStates).includes('needs_attention')
      ? { needsAttention: Object.entries(checkpoint.nodeStates).filter(([, status]) => status === 'needs_attention').map(([id]) => id).sort() }
      : {}),
  }
}
