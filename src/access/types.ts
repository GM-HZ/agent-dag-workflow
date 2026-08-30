import type {
  JsonObject,
  JsonSchema,
  JsonValue,
  WorkflowDiagnostic,
  WorkflowEvent,
  WorkflowRunOrigin,
  WorkflowRunResult,
  WorkflowTemplate,
} from '../core/index.js'
import type { WorkflowTemplateDiff } from '../catalog/index.js'

export interface AgentAccessContext {
  readonly authorityRef: string
  readonly authority?: unknown
  readonly origin: WorkflowRunOrigin
  readonly signal?: AbortSignal
}

export type WorkflowAccessOperation =
  | 'search' | 'describe' | 'run' | 'run.get' | 'trace' | 'replay' | 'resume' | 'cancel'
  | 'nodes.list' | 'validate' | 'draft.get' | 'draft.put' | 'diff' | 'publish'

export interface WorkflowAccessAuthorizationRequest {
  readonly operation: WorkflowAccessOperation
  readonly context: AgentAccessContext
  readonly workflowId?: string
  readonly workflowRef?: string
  readonly runId?: string
  readonly resourceAuthorityRef?: string
}

export type WorkflowAccessAuthorizer = (request: WorkflowAccessAuthorizationRequest) => boolean | Promise<boolean>

export interface WorkflowAgentAccessOptions {
  /** Defaults to same-authority access for persisted Runs and allows catalog operations. */
  readonly authorize?: WorkflowAccessAuthorizer
}

export interface WorkflowSearchRequest {
  readonly query?: string
  readonly limit?: number
  readonly after?: string
}

export interface WorkflowSearchItem {
  readonly ref: string
  readonly id: string
  readonly revision: number
  readonly name: string
  readonly summary?: string
  readonly semanticHash: string
  readonly publishedAt: number
}

export interface WorkflowSearchResult {
  readonly items: readonly WorkflowSearchItem[]
  readonly nextAfter?: string
}

export type WorkflowDescribeView = 'summary' | 'schema' | 'template'

export interface WorkflowDescribeRequest {
  readonly ref: string
  readonly view?: WorkflowDescribeView
}

export interface WorkflowDescription {
  readonly ref: string
  readonly id: string
  readonly revision: number
  readonly name: string
  readonly summary?: string
  readonly semanticHash: string
  readonly publishedAt: number
  readonly inputSchema?: JsonSchema
  readonly outputSchema?: JsonSchema
  readonly requires?: readonly { readonly kind: string; readonly uses: string }[]
  readonly template?: WorkflowTemplate
}

export interface WorkflowAgentRunRequest {
  readonly ref: string
  readonly inputs: JsonObject
  readonly mode?: 'foreground' | 'background'
  readonly idempotencyKey?: string
}

export type WorkflowAgentRunResult =
  | { readonly runId: string; readonly status: 'accepted' }
  | {
      readonly runId: string
      readonly status: 'completed' | 'failed' | 'cancelled' | 'paused'
      readonly outputs?: JsonObject
      readonly error?: string
      readonly needsAttention?: readonly string[]
    }

export interface WorkflowRunProjection {
  readonly runId: string
  readonly ref: string
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled' | 'paused'
  readonly semanticHash: string
  readonly origin: WorkflowRunOrigin
  readonly createdAt: number
  readonly updatedAt: number
  readonly checkpointSeq: number
  readonly nodeStates: Readonly<Record<string, string>>
  readonly outputs?: JsonObject
  readonly error?: string
  readonly needsAttention?: readonly string[]
}

export interface WorkflowTraceRequest {
  readonly runId: string
  readonly view?: 'summary' | 'events'
  readonly afterSeq?: number
  readonly limit?: number
}

export interface WorkflowTraceProjection {
  readonly run: WorkflowRunProjection
  readonly events?: readonly WorkflowEvent[]
  readonly nextAfterSeq?: number
}

export interface WorkflowNodeSearchRequest {
  readonly query?: string
  readonly limit?: number
}

export interface WorkflowNodeSearchResult {
  readonly items: readonly {
    readonly uses: string
    readonly title: string
    readonly description: string
    readonly configSchema: JsonSchema
    readonly inputSchema: JsonSchema
    readonly outputSchema: JsonSchema
    readonly outputPorts: readonly string[]
    readonly effects: 'deterministic' | 'external'
    readonly retry: import('../core/index.js').NodeRetryMode
    readonly dependencyKinds?: readonly string[]
  }[]
}

export interface WorkflowValidationResult { readonly diagnostics: readonly WorkflowDiagnostic[] }
export interface WorkflowDraftProjection {
  readonly id: string
  readonly revision: number
  readonly name: string
  readonly contentHash: string
  readonly semanticHash: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly template?: WorkflowTemplate
}
export interface WorkflowPublishedProjection {
  readonly ref: string
  readonly id: string
  readonly revision: number
  readonly sourceDraftRevision: number
  readonly name: string
  readonly semanticHash: string
  readonly publishedAt: number
}

export interface WorkflowAccessErrorShape {
  readonly code: string
  readonly message: string
  readonly diagnostics?: readonly WorkflowDiagnostic[]
  readonly details?: JsonValue
}

export interface WorkflowAgentAccessApi {
  search(request: WorkflowSearchRequest, context: AgentAccessContext): Promise<WorkflowSearchResult>
  describe(request: WorkflowDescribeRequest, context: AgentAccessContext): Promise<WorkflowDescription>
  run(request: WorkflowAgentRunRequest, context: AgentAccessContext): Promise<WorkflowAgentRunResult>
  getRun(runId: string, context: AgentAccessContext): Promise<WorkflowRunProjection>
  trace(request: WorkflowTraceRequest, context: AgentAccessContext): Promise<WorkflowTraceProjection>
  replay(runId: string, mode: 'inspect' | 'recorded' | 'live', context: AgentAccessContext): Promise<WorkflowRunResult>
  resume(runId: string, context: AgentAccessContext, unknownNodeResolutions?: Readonly<Record<string, 'retry' | 'fail'>>): Promise<WorkflowRunResult>
  cancel(runId: string, context: AgentAccessContext, reason?: string): Promise<WorkflowRunResult>
  listNodes(request: WorkflowNodeSearchRequest, context: AgentAccessContext): Promise<WorkflowNodeSearchResult>
  validate(template: WorkflowTemplate, context: AgentAccessContext): Promise<WorkflowValidationResult>
  getDraft(id: string, context: AgentAccessContext, includeTemplate?: boolean): Promise<WorkflowDraftProjection>
  putDraft(template: WorkflowTemplate, context: AgentAccessContext, expectedRevision?: number): Promise<WorkflowDraftProjection>
  diff(id: string, candidate: WorkflowTemplate, context: AgentAccessContext): Promise<WorkflowTemplateDiff>
  publish(id: string, expectedDraftRevision: number, context: AgentAccessContext): Promise<WorkflowPublishedProjection>
}
