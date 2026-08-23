import type {
  JsonObject,
  JsonValue,
  WorkflowEvent,
  WorkflowResumeRequest,
  WorkflowRun,
  WorkflowStartRequest,
  WorkflowTemplate,
} from '@gm-hz/dsh-workflow-core'

export interface DshSessionLike {
  append(type: string, data: unknown): unknown
}

export interface DshAgentLike {
  readonly session: DshSessionLike
}

export interface DshSubagentRunLike {
  readonly id: string
  readonly result: Promise<{
    readonly output: readonly JsonValue[]
    readonly structured?: unknown
    readonly diagnostic?: string
    readonly stopReason: string
  }>
  dispose(): Promise<void>
}

export interface DshSubagentRuntimeLike {
  start(provider: string, request: {
    readonly label?: string
    readonly prompt: readonly { readonly type: 'text'; readonly text: string }[]
    readonly parent: DshAgentLike
    readonly signal: AbortSignal
    readonly outputSchema?: Readonly<Record<string, unknown>>
    readonly maxDepth?: number
  }): Promise<DshSubagentRunLike>
}

export type DshApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

export interface DshApprovalRuntimeLike {
  request(request: {
    readonly agent: DshAgentLike
    readonly toolName: string
    readonly callId: string
    readonly reason: string
    readonly signal: AbortSignal
  }): Promise<DshApprovalOutcome>
}

export interface DshToolRuntimeInput {
  readonly callId: string
  readonly name: string
  readonly arguments: JsonObject
  readonly signal: AbortSignal
  readonly agent: DshAgentLike
}

export type DshToolRuntimeResult =
  | { readonly isError: false; readonly value: JsonValue }
  | { readonly isError: true; readonly error: unknown }

export interface DshToolRuntimeLike {
  execute(input: DshToolRuntimeInput): Promise<DshToolRuntimeResult>
}

export interface DshDagWorkflowStartRequest extends Omit<WorkflowStartRequest, 'owner'> {
  readonly template: WorkflowTemplate
  readonly inputs: JsonObject
  readonly parent: object
}

export interface DshDagWorkflowEngine {
  start(request: DshDagWorkflowStartRequest): WorkflowRun
  resume(request: DshDagWorkflowResumeRequest): WorkflowRun
}

export interface DshDagWorkflowResumeRequest extends Omit<WorkflowResumeRequest, 'owner'> {
  readonly parent: object
}

export interface DshWorkflowPluginConfig {
  readonly recordSessionEvents?: boolean
  readonly catalog?: 'memory' | 'external'
  readonly runStore?: 'memory' | 'external'
}

export interface DagWorkflowRunStartData {
  readonly runId: string
  readonly templateId: string
  readonly semanticHash: string
}

export interface DagWorkflowNodeStartData {
  readonly runId: string
  readonly nodeId: string
}

export interface DagWorkflowNodeEndData {
  readonly runId: string
  readonly nodeId: string
  readonly status: 'completed' | 'failed' | 'skipped' | 'cancelled' | 'needs_attention'
  readonly error?: string
}

export interface DagWorkflowNodeWaitData {
  readonly runId: string
  readonly nodeId: string
}

export interface DagWorkflowRunEndData {
  readonly runId: string
  readonly status: 'completed' | 'failed' | 'cancelled' | 'paused'
  readonly error?: string
}

export interface DagWorkflowRunResumeData {
  readonly runId: string
}

export type DshDagWorkflowEvent = WorkflowEvent
