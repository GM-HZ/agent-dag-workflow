import type {
  JsonObject,
  JsonValue,
  WorkflowEvent,
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
}

export interface DshWorkflowPluginConfig {
  readonly recordSessionEvents?: boolean
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
  readonly status: 'completed' | 'failed' | 'skipped'
  readonly error?: string
}

export interface DagWorkflowRunEndData {
  readonly runId: string
  readonly status: 'completed' | 'failed' | 'cancelled'
  readonly error?: string
}

export type DshDagWorkflowEvent = WorkflowEvent
