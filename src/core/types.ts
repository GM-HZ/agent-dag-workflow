export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[]
export interface JsonObject { [key: string]: JsonValue }
export type JsonSchema = Record<string, unknown>

export type WorkflowBinding =
  | { readonly literal: JsonValue }
  | { readonly input: { readonly path: readonly (string | number)[] } }
  | { readonly output: { readonly nodeId: string; readonly path: readonly (string | number)[] } }

/** A dependency declaration is an allowlist entry, never a permission grant. */
export interface WorkflowRequirement {
  readonly kind: string
  readonly uses: string
}

export interface WorkflowNodeExpectation {
  /** Validates the complete node output object after the NodeDefinition schema. */
  readonly schema: JsonSchema
  /** Optional node-local cap; the workflow-wide output cap still applies. */
  readonly maxBytes?: number
}

export interface WorkflowNodeTemplate {
  readonly id: string
  readonly uses: string
  readonly title?: string
  readonly with: JsonObject
  readonly inputs: Readonly<Record<string, WorkflowBinding>>
  readonly expects?: WorkflowNodeExpectation
  readonly policy?: {
    readonly timeoutMs?: number
    readonly retry?: { readonly maxAttempts: number }
  }
}

export interface WorkflowEdgeTemplate {
  readonly id: string
  readonly source: string
  readonly target: string
  readonly sourcePort?: string
}

export interface WorkflowPolicies {
  readonly maxConcurrentNodes?: number
  readonly maxNodeRuns?: number
  readonly maxDurationMs?: number
  readonly maxOutputBytes?: number
  readonly subworkflowMaxDepth?: number
}

export interface WorkflowTemplate {
  readonly apiVersion: 'workflow.gm-hz.dev/v1alpha1'
  readonly kind: 'WorkflowTemplate'
  readonly metadata: {
    readonly id: string
    readonly name: string
    readonly description?: string
  }
  readonly spec: {
    readonly inputSchema: JsonSchema
    readonly outputSchema: JsonSchema
    readonly requires?: readonly WorkflowRequirement[]
    readonly nodes: readonly WorkflowNodeTemplate[]
    readonly edges: readonly WorkflowEdgeTemplate[]
    readonly outputs: Readonly<Record<string, WorkflowBinding>>
    readonly policies?: WorkflowPolicies
  }
  readonly layout?: JsonObject
}

export interface WorkflowDiagnostic {
  readonly code: string
  readonly severity: 'error' | 'warning'
  readonly message: string
  readonly nodeId?: string
  readonly path?: readonly (string | number)[]
}

export type NodeRole = 'start' | 'end' | 'regular'
export type NodeRetryMode = 'never' | 'safe' | 'idempotent'

export interface WorkflowRunOrigin {
  readonly type: 'sdk' | 'cli' | 'mcp' | 'host' | 'trigger' | 'replay' | string
  readonly source?: string
  readonly sourceRef?: string
}

export interface WorkflowTraceContext {
  readonly traceId: string
  readonly parentSpanId?: string
}

export interface WorkflowExecutionContext {
  readonly authorityRef: string
  readonly authority?: unknown
  readonly origin: WorkflowRunOrigin
  readonly traceContext?: WorkflowTraceContext
}

export interface WorkflowAuthorityResolver {
  resolve(authorityRef: string, signal: AbortSignal): Promise<unknown | undefined>
}

export interface WorkflowNodeExecutionResult {
  readonly outputs: JsonObject
  readonly selectedPorts?: readonly string[]
}

export interface WorkflowToolRequest {
  readonly runId: string
  readonly nodeId: string
  readonly invocationId: string
  readonly uses: string
  readonly inputs: JsonObject
  readonly config: JsonObject
  readonly authority: unknown
  readonly signal: AbortSignal
}

export interface WorkflowToolGateway {
  list?(authority: unknown): Promise<readonly WorkflowToolDescriptor[]>
  execute(request: WorkflowToolRequest): Promise<JsonValue>
}

export interface WorkflowToolDescriptor {
  readonly uses: string
  readonly title: string
  readonly description: string
  readonly inputSchema: JsonSchema
  readonly outputSchema?: JsonSchema
  readonly idempotency: NodeRetryMode
}

export interface WorkflowAgentRequest {
  readonly runId: string
  readonly nodeId: string
  readonly invocationId: string
  readonly prompt: string
  readonly inputs: JsonObject
  readonly outputSchema?: JsonSchema
  readonly tools?: readonly string[]
  readonly skills?: readonly string[]
  readonly authority: unknown
  readonly signal: AbortSignal
}

export interface WorkflowAgentResult {
  readonly runId: string
  readonly content: readonly JsonValue[]
  readonly structured?: JsonValue
}

export interface WorkflowAgentGateway {
  execute(request: WorkflowAgentRequest): Promise<WorkflowAgentResult>
}

export type WorkflowApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

export interface WorkflowApprovalRequest {
  readonly runId: string
  readonly nodeId: string
  readonly invocationId: string
  readonly action: string
  readonly reason: string
  readonly details: JsonObject
  readonly authority: unknown
  readonly signal: AbortSignal
}

export interface WorkflowApprovalGateway {
  request(request: WorkflowApprovalRequest): Promise<WorkflowApprovalOutcome>
}

export interface WorkflowSubworkflowRequest {
  readonly parentRunId: string
  readonly nodeId: string
  readonly invocationId: string
  readonly templateId: string
  readonly revision: number
  readonly inputs: JsonObject
  readonly depth: number
  readonly depthLimit: number
  readonly authority: unknown
  readonly signal: AbortSignal
}

export interface WorkflowSubworkflowResult {
  readonly runId: string
  readonly outputs: JsonObject
}

export interface WorkflowSubworkflowGateway {
  /** Implementations must make invocationId idempotent across process restarts. */
  execute(request: WorkflowSubworkflowRequest): Promise<WorkflowSubworkflowResult>
}

export interface WorkflowNodeServices {
  readonly tools?: WorkflowToolGateway
  readonly agents?: WorkflowAgentGateway
  readonly approvals?: WorkflowApprovalGateway
  readonly subworkflows?: WorkflowSubworkflowGateway
}

export type WorkflowCapabilityDisposer = () => void

/** Host-owned capability bindings. Normal external business operations belong in Host Tools. */
export interface WorkflowCapabilitySource {
  resolve<T = unknown>(capability: string): T | undefined
}

/** A per-node view that can only resolve capabilities declared by its NodeDefinition. */
export interface WorkflowCapabilityResolver {
  readonly declared: readonly string[]
  has(capability: string): boolean
  optional<T = unknown>(capability: string): T | undefined
  require<T = unknown>(capability: string): T
}

export interface WorkflowEngineServices extends WorkflowNodeServices {
  /** Additive extension seam for custom Nodes; built-in typed gateways remain supported. */
  readonly capabilities?: WorkflowCapabilitySource
}

export interface WorkflowNodeExecutionContext {
  readonly runId: string
  readonly nodeId: string
  readonly invocationId: string
  readonly workflowInputs: JsonObject
  readonly inputs: JsonObject
  readonly config: JsonObject
  readonly signal: AbortSignal
  /** Generic, fail-closed service projection for custom workflow Nodes. */
  readonly capabilities: WorkflowCapabilityResolver
  /** Typed built-in gateway views retained for Tool/Agent/Approval/subworkflow Nodes. */
  readonly services: WorkflowNodeServices
  /** Exact allowlist entries matched for this node at compile time. */
  readonly requirements: readonly WorkflowRequirement[]
  readonly depth: number
  readonly subworkflowMaxDepth: number
  readonly progress?: JsonValue
  checkpointProgress(progress: JsonValue): Promise<void>
  readonly authority: unknown
}

export interface WorkflowNodeDefinition {
  readonly type: string
  readonly version: number
  readonly title: string
  readonly description: string
  readonly role?: NodeRole
  readonly configSchema: JsonSchema
  /** Safe authoring seed used by Canvas/Agent builders; it never overrides template config. */
  readonly defaultConfig?: JsonObject
  readonly inputSchema: JsonSchema
  readonly outputSchema: JsonSchema
  readonly outputPorts: readonly string[]
  readonly requiredOutputPorts?: readonly string[]
  readonly capabilities: readonly string[]
  /** Resource kinds that authoring clients should expect this definition to declare. */
  readonly dependencyKinds?: readonly string[]
  readonly retry: NodeRetryMode
  readonly execution?: 'activity' | 'human-wait'
  /** Stable build/adapter manifest digest; required for replayable production plans. */
  readonly implementationDigest?: string
  /** Optional definition-owned semantic validation performed during workflow compilation. */
  validateConfig?(config: JsonObject): readonly string[]
  /** Resolve fixed external resources from validated config. Dynamic names are forbidden. */
  dependencies?(config: JsonObject): readonly WorkflowRequirement[]
  execute(context: WorkflowNodeExecutionContext): Promise<WorkflowNodeExecutionResult>
}

export interface WorkflowScriptExecutionRequest {
  readonly source: string
  readonly inputs: JsonObject
  readonly signal: AbortSignal
  readonly maxOperations: number
}

/**
 * Script runtimes are deliberately pure data transforms. Runtimes that need I/O,
 * credentials, host modules, or ambient authority must register a normal workflow
 * node or Host Tool instead of using this interface.
 */
export interface WorkflowScriptRuntimeDefinition {
  readonly language: string
  readonly version: number
  readonly title: string
  readonly description: string
  readonly deterministic: true
  validate(source: string): readonly string[]
  execute(request: WorkflowScriptExecutionRequest): Promise<JsonObject>
}

export type WorkflowNodeStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  | 'needs_attention'

export type WorkflowEdgeStatus = 'unknown' | 'taken' | 'skipped'

export type WorkflowEventType =
  | 'run.accepted' | 'run.queued' | 'run.started' | 'run.resumed' | 'run.completed' | 'run.failed' | 'run.cancelled' | 'run.paused'
  | 'node.ready' | 'node.started' | 'node.waiting' | 'node.progress' | 'node.output-validated' | 'node.output-committed'
  | 'node.completed' | 'node.skipped' | 'node.cancelled' | 'node.needs-attention' | 'node.failed'
  | 'capability.requested' | 'capability.completed' | 'capability.replayed' | 'capability.failed'
  | 'edge.taken' | 'edge.skipped' | 'checkpoint.committed'

export interface WorkflowEventEnvelope {
  readonly schemaVersion: 1
  readonly eventId: string
  readonly runId: string
  readonly seq: number
  readonly type: WorkflowEventType
  readonly occurredAt: number
  readonly workflow: {
    readonly id: string
    readonly revision?: number
    readonly semanticHash: string
    readonly engineVersion: string
    readonly nodeDefinitionSetHash: string
  }
  readonly node?: { readonly id: string; readonly uses: string; readonly attempt: number; readonly invocationId: string }
  readonly correlation: {
    readonly traceId: string
    readonly spanId: string
    readonly parentSpanId?: string
    readonly parentRunId?: string
    readonly causationEventId?: string
  }
  readonly origin: WorkflowRunOrigin
  readonly payload: JsonObject
}

export interface WorkflowArtifactPointer {
  readonly digest: string
  readonly size: number
  readonly mediaType: string
  readonly redacted: boolean
}

export interface WorkflowDataCapture {
  readonly dataHash: string
  readonly artifact?: WorkflowArtifactPointer
}

export interface WorkflowDataCaptureGateway {
  capture(request: {
    readonly runId: string
    readonly nodeId?: string
    readonly phase: 'workflow.input' | 'capability.output' | 'node.output'
    readonly value: JsonValue
  }): Promise<WorkflowDataCapture>
}

export type WorkflowEvent = WorkflowEventEnvelope & (
  | { readonly seq: number; readonly type: 'run.started'; readonly runId: string }
  | { readonly seq: number; readonly type: 'run.accepted'; readonly runId: string; readonly dataHash?: string; readonly artifact?: WorkflowArtifactPointer }
  | { readonly seq: number; readonly type: 'run.queued'; readonly runId: string }
  | { readonly seq: number; readonly type: 'run.resumed'; readonly runId: string }
  | { readonly seq: number; readonly type: 'run.completed'; readonly runId: string }
  | { readonly seq: number; readonly type: 'run.failed'; readonly runId: string; readonly error: string }
  | { readonly seq: number; readonly type: 'run.cancelled'; readonly runId: string; readonly reason: string }
  | { readonly seq: number; readonly type: 'run.paused'; readonly runId: string; readonly reason: string }
  | { readonly seq: number; readonly type: 'node.ready' | 'node.started' | 'node.waiting' | 'node.completed' | 'node.skipped' | 'node.cancelled' | 'node.needs-attention'; readonly runId: string; readonly nodeId: string }
  | { readonly seq: number; readonly type: 'node.progress'; readonly runId: string; readonly nodeId: string; readonly progress: JsonValue }
  | { readonly seq: number; readonly type: 'node.output-validated'; readonly runId: string; readonly nodeId: string }
  | { readonly seq: number; readonly type: 'node.output-committed'; readonly runId: string; readonly nodeId: string; readonly dataHash?: string; readonly artifact?: WorkflowArtifactPointer }
  | { readonly seq: number; readonly type: 'node.failed'; readonly runId: string; readonly nodeId: string; readonly error: string }
  | { readonly seq: number; readonly type: 'capability.requested' | 'capability.replayed'; readonly runId: string; readonly nodeId: string; readonly invocationId: string }
  | { readonly seq: number; readonly type: 'capability.completed'; readonly runId: string; readonly nodeId: string; readonly invocationId: string; readonly dataHash?: string; readonly artifact?: WorkflowArtifactPointer }
  | { readonly seq: number; readonly type: 'capability.failed'; readonly runId: string; readonly nodeId: string; readonly invocationId: string; readonly error: string }
  | { readonly seq: number; readonly type: 'edge.taken' | 'edge.skipped'; readonly runId: string; readonly edgeId: string }
  | { readonly seq: number; readonly type: 'checkpoint.committed'; readonly runId: string; readonly checkpointSeq: number }
)

export type WorkflowEventInput = WorkflowEvent extends infer Event
  ? Event extends WorkflowEvent
    ? Omit<Event, keyof WorkflowEventEnvelope | 'seq' | 'runId'> & Pick<Event, 'type'>
    : never
  : never

export interface WorkflowRunSuccess {
  readonly status: 'completed'
  readonly runId: string
  readonly outputs: JsonObject
  readonly nodeStates: Readonly<Record<string, WorkflowNodeStatus>>
  readonly edgeStates: Readonly<Record<string, WorkflowEdgeStatus>>
  readonly events: readonly WorkflowEvent[]
}

export interface WorkflowRunFailure {
  readonly status: 'failed' | 'cancelled' | 'paused'
  readonly runId: string
  readonly error: string
  readonly nodeStates: Readonly<Record<string, WorkflowNodeStatus>>
  readonly edgeStates: Readonly<Record<string, WorkflowEdgeStatus>>
  readonly events: readonly WorkflowEvent[]
  readonly needsAttention?: readonly string[]
}

export type WorkflowRunResult = WorkflowRunSuccess | WorkflowRunFailure

export interface WorkflowRun {
  readonly id: string
  readonly result: Promise<WorkflowRunResult>
  cancel(reason?: string): Promise<void>
  dispose(): Promise<void>
}

export interface WorkflowExecutionPlanEntry {
  readonly id: string
  readonly revision?: number
  readonly semanticHash: string
  readonly template: WorkflowTemplate
}

export interface WorkflowExecutionPlanSnapshot {
  readonly root: WorkflowExecutionPlanEntry
  readonly dependencies: readonly (WorkflowExecutionPlanEntry & { readonly revision: number })[]
  readonly engineVersion: string
  readonly nodeDefinitionSetHash: string
  readonly replayable: boolean
}

export interface WorkflowStartRequest {
  readonly runId?: string
  readonly template: WorkflowTemplate
  readonly inputs: JsonObject
  readonly execution: WorkflowExecutionContext
  readonly plan?: WorkflowExecutionPlanSnapshot
  readonly idempotencyKey?: string
  readonly deliveryRef?: string
  /** Internal recorded-replay source. External nodes are satisfied from these committed outputs. */
  readonly recordedNodeOutputs?: Readonly<Record<string, JsonObject>>
  readonly signal?: AbortSignal
  readonly onEvent?: (event: WorkflowEvent) => void
}

export interface WorkflowResumeRequest {
  readonly runId: string
  readonly execution: WorkflowExecutionContext
  readonly signal?: AbortSignal
  readonly onEvent?: (event: WorkflowEvent) => void
  readonly unknownNodeResolutions?: Readonly<Record<string, 'retry' | 'fail'>>
}

export interface WorkflowInvocationRequest extends WorkflowStartRequest {
  readonly invocationId: string
  readonly depth: number
  readonly subworkflowDepthLimit: number
}

export type PersistedWorkflowRunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'paused'

export interface WorkflowRunCheckpoint {
  readonly version: 1
  readonly runId: string
  readonly semanticHash: string
  readonly seq: number
  readonly status: PersistedWorkflowRunStatus
  readonly nodeStates: Readonly<Record<string, WorkflowNodeStatus>>
  readonly edgeStates: Readonly<Record<string, WorkflowEdgeStatus>>
  readonly nodeOutputs: Readonly<Record<string, JsonObject>>
  readonly nodeProgress: Readonly<Record<string, JsonValue>>
  readonly ready: readonly string[]
  readonly nodeRuns: number
  readonly nodeAttempts: Readonly<Record<string, number>>
  readonly depth: number
  readonly subworkflowDepthLimit: number
  readonly invocationId?: string
  readonly updatedAt: number
  readonly resultOutputs?: JsonObject
  readonly error?: string
}

export interface WorkflowRunRecord {
  readonly runId: string
  readonly template: WorkflowTemplate
  readonly semanticHash: string
  readonly plan: WorkflowExecutionPlanSnapshot
  readonly inputs: JsonObject
  readonly execution: Omit<WorkflowExecutionContext, 'authority'>
  readonly launch: { readonly idempotencyKey?: string; readonly deliveryRef?: string; readonly executionMode?: 'foreground' | 'background' }
  readonly createdAt: number
  readonly checkpoint: WorkflowRunCheckpoint
  readonly events: readonly WorkflowEvent[]
}

export interface WorkflowRunMetadata {
  readonly runId: string
  readonly templateId: string
  readonly semanticHash: string
  readonly plan: WorkflowExecutionPlanSnapshot
  readonly execution: Omit<WorkflowExecutionContext, 'authority'>
  readonly launch: { readonly idempotencyKey?: string; readonly deliveryRef?: string; readonly executionMode?: 'foreground' | 'background' }
  readonly createdAt: number
}

export interface WorkflowRunStore {
  createRun(record: WorkflowRunRecord): Promise<void>
  commit(runId: string, expectedSeq: number, checkpoint: WorkflowRunCheckpoint, events: readonly WorkflowEvent[]): Promise<void>
  loadRun(runId: string): Promise<WorkflowRunRecord | undefined>
  getRunMetadata(runId: string): Promise<WorkflowRunMetadata | undefined>
  getCheckpoint(runId: string): Promise<WorkflowRunCheckpoint | undefined>
  readEvents(runId: string, query?: { readonly afterSeq?: number; readonly limit?: number }): Promise<readonly WorkflowEvent[]>
  listRecoverableRuns(): Promise<readonly WorkflowRunRecord[]>
}
