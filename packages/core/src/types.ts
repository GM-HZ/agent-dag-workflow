export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[]
export interface JsonObject { [key: string]: JsonValue }
export type JsonSchema = Record<string, unknown>

export type WorkflowBinding =
  | { readonly literal: JsonValue }
  | { readonly input: string }
  | { readonly output: { readonly node: string; readonly path: readonly (string | number)[] } }
  | { readonly secret: { readonly ref: string } }

export interface WorkflowNodeTemplate {
  readonly id: string
  readonly uses: string
  readonly title?: string
  readonly with: JsonObject
  readonly inputs: Readonly<Record<string, WorkflowBinding>>
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
  readonly apiVersion: 'dsh.workflow/v1alpha1'
  readonly kind: 'WorkflowTemplate'
  readonly metadata: {
    readonly id: string
    readonly name: string
    readonly description?: string
  }
  readonly spec: {
    readonly inputSchema: JsonSchema
    readonly outputSchema: JsonSchema
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

export interface WorkflowNodeExecutionResult {
  readonly outputs: JsonObject
  readonly selectedPorts?: readonly string[]
}

export interface WorkflowToolRequest {
  readonly runId: string
  readonly nodeId: string
  readonly name: string
  readonly input: JsonObject
  readonly signal: AbortSignal
  readonly owner?: unknown
}

export interface WorkflowToolGateway {
  execute(request: WorkflowToolRequest): Promise<JsonValue>
}

export interface WorkflowSecretGateway {
  resolve(ref: string, context: { readonly runId: string; readonly nodeId: string; readonly signal: AbortSignal }): Promise<JsonValue>
}

export interface WorkflowAgentRequest {
  readonly runId: string
  readonly nodeId: string
  readonly provider: string
  readonly prompt: string
  readonly label?: string
  readonly outputSchema?: JsonSchema
  readonly maxDepth?: number
  readonly signal: AbortSignal
  readonly owner?: unknown
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
  readonly token: string
  readonly action: string
  readonly reason: string
  readonly details: JsonObject
  readonly signal: AbortSignal
  readonly owner?: unknown
}

export interface WorkflowApprovalGateway {
  request(request: WorkflowApprovalRequest): Promise<WorkflowApprovalOutcome>
}

export interface WorkflowNodeServices {
  readonly tools?: WorkflowToolGateway
  readonly secrets?: WorkflowSecretGateway
  readonly agents?: WorkflowAgentGateway
  readonly approvals?: WorkflowApprovalGateway
}

export interface WorkflowNodeExecutionContext {
  readonly runId: string
  readonly nodeId: string
  readonly workflowInputs: JsonObject
  readonly inputs: JsonObject
  readonly config: JsonObject
  readonly signal: AbortSignal
  readonly services: WorkflowNodeServices
  readonly owner?: unknown
}

export interface WorkflowNodeDefinition {
  readonly type: string
  readonly version: number
  readonly title: string
  readonly description: string
  readonly role?: NodeRole
  readonly configSchema: JsonSchema
  readonly inputSchema: JsonSchema
  readonly outputSchema: JsonSchema
  readonly outputPorts: readonly string[]
  readonly requiredOutputPorts?: readonly string[]
  readonly capabilities: readonly string[]
  readonly retry: NodeRetryMode
  readonly execution?: 'activity' | 'human-wait'
  execute(context: WorkflowNodeExecutionContext): Promise<WorkflowNodeExecutionResult>
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

export type WorkflowEvent =
  | { readonly seq: number; readonly type: 'run.started'; readonly runId: string }
  | { readonly seq: number; readonly type: 'run.resumed'; readonly runId: string }
  | { readonly seq: number; readonly type: 'run.completed'; readonly runId: string }
  | { readonly seq: number; readonly type: 'run.failed'; readonly runId: string; readonly error: string }
  | { readonly seq: number; readonly type: 'run.cancelled'; readonly runId: string; readonly reason: string }
  | { readonly seq: number; readonly type: 'run.paused'; readonly runId: string; readonly reason: string }
  | { readonly seq: number; readonly type: 'node.ready' | 'node.started' | 'node.waiting' | 'node.completed' | 'node.skipped' | 'node.cancelled' | 'node.needs-attention'; readonly runId: string; readonly nodeId: string }
  | { readonly seq: number; readonly type: 'node.failed'; readonly runId: string; readonly nodeId: string; readonly error: string }
  | { readonly seq: number; readonly type: 'edge.taken' | 'edge.skipped'; readonly runId: string; readonly edgeId: string }
  | { readonly seq: number; readonly type: 'checkpoint.committed'; readonly runId: string; readonly checkpointSeq: number }

export type WorkflowEventInput = WorkflowEvent extends infer Event
  ? Event extends WorkflowEvent
    ? Omit<Event, 'seq' | 'runId'>
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
  cancel(reason?: string): void
  dispose(): Promise<void>
}

export interface WorkflowStartRequest {
  readonly template: WorkflowTemplate
  readonly inputs: JsonObject
  readonly owner?: unknown
  readonly signal?: AbortSignal
  readonly onEvent?: (event: WorkflowEvent) => void
}

export interface WorkflowResumeRequest {
  readonly runId: string
  readonly owner?: unknown
  readonly signal?: AbortSignal
  readonly onEvent?: (event: WorkflowEvent) => void
  readonly unknownNodeResolutions?: Readonly<Record<string, 'retry' | 'fail'>>
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
  readonly ready: readonly string[]
  readonly nodeRuns: number
  readonly updatedAt: number
  readonly resultOutputs?: JsonObject
  readonly error?: string
}

export interface WorkflowRunRecord {
  readonly runId: string
  readonly template: WorkflowTemplate
  readonly semanticHash: string
  readonly inputs: JsonObject
  readonly createdAt: number
  readonly checkpoint: WorkflowRunCheckpoint
  readonly events: readonly WorkflowEvent[]
}

export interface WorkflowRunStore {
  createRun(record: WorkflowRunRecord): void
  commit(runId: string, expectedSeq: number, checkpoint: WorkflowRunCheckpoint, events: readonly WorkflowEvent[]): void
  loadRun(runId: string): WorkflowRunRecord | undefined
  listRecoverableRuns(): readonly WorkflowRunRecord[]
}
