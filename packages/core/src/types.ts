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

export interface WorkflowNodeServices {
  readonly tools?: WorkflowToolGateway
  readonly secrets?: WorkflowSecretGateway
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
  execute(context: WorkflowNodeExecutionContext): Promise<WorkflowNodeExecutionResult>
}

export type WorkflowNodeStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'skipped'

export type WorkflowEdgeStatus = 'unknown' | 'taken' | 'skipped'

export type WorkflowEvent =
  | { readonly seq: number; readonly type: 'run.started'; readonly runId: string }
  | { readonly seq: number; readonly type: 'run.completed'; readonly runId: string }
  | { readonly seq: number; readonly type: 'run.failed'; readonly runId: string; readonly error: string }
  | { readonly seq: number; readonly type: 'run.cancelled'; readonly runId: string; readonly reason: string }
  | { readonly seq: number; readonly type: 'node.ready' | 'node.started' | 'node.completed' | 'node.skipped'; readonly runId: string; readonly nodeId: string }
  | { readonly seq: number; readonly type: 'node.failed'; readonly runId: string; readonly nodeId: string; readonly error: string }
  | { readonly seq: number; readonly type: 'edge.taken' | 'edge.skipped'; readonly runId: string; readonly edgeId: string }

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
  readonly status: 'failed' | 'cancelled'
  readonly runId: string
  readonly error: string
  readonly nodeStates: Readonly<Record<string, WorkflowNodeStatus>>
  readonly edgeStates: Readonly<Record<string, WorkflowEdgeStatus>>
  readonly events: readonly WorkflowEvent[]
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
