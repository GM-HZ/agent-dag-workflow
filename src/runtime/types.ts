import type {
  JsonObject,
  WorkflowEvent,
  WorkflowExecutionPlanSnapshot,
  WorkflowRunOrigin,
  WorkflowRunResult,
  WorkflowTemplate,
} from '../core/index.js'
import type { PublishedWorkflowRevision, WorkflowDraft } from '../catalog/index.js'

export interface WorkflowNodeDescriptor {
  readonly uses: string
  readonly title: string
  readonly description: string
  readonly configSchema: import('../core/index.js').JsonSchema
  readonly inputSchema: import('../core/index.js').JsonSchema
  readonly outputSchema: import('../core/index.js').JsonSchema
  readonly outputPorts: readonly string[]
  readonly dependencyKinds?: readonly string[]
}

export type WorkflowLaunchTarget =
  | { readonly type: 'published'; readonly id: string; readonly revision: number }
  | { readonly type: 'inline'; readonly template: WorkflowTemplate }

export interface WorkflowLaunchRequest {
  readonly target: WorkflowLaunchTarget
  readonly inputs: JsonObject
  readonly authorityRef: string
  readonly authority?: unknown
  readonly origin: WorkflowRunOrigin
  readonly traceContext?: { readonly traceId: string; readonly parentSpanId?: string }
  readonly idempotencyKey?: string
  readonly deliveryRef?: string
  readonly signal?: AbortSignal
  readonly onEvent?: (event: WorkflowEvent) => void
}

export interface WorkflowRuntimeResumeRequest {
  readonly runId: string
  readonly authorityRef: string
  readonly authority?: unknown
  readonly signal?: AbortSignal
  readonly unknownNodeResolutions?: Readonly<Record<string, 'retry' | 'fail'>>
  readonly onEvent?: (event: WorkflowEvent) => void
}

export interface WorkflowLiveEvent {
  readonly schemaVersion: 1
  readonly runId: string
  readonly nodeId: string
  readonly invocationId: string
  readonly liveSeq: number
  readonly type: 'node.output.delta' | 'node.progress' | 'node.message.delta'
  readonly channel?: string
  readonly data: import('../core/index.js').JsonValue
}

export interface WorkflowRunHandle {
  readonly runId: string
  readonly result: Promise<WorkflowRunResult>
  live(options?: { readonly signal?: AbortSignal }): AsyncIterable<WorkflowLiveEvent>
  cancel(reason?: string): Promise<void>
}

export interface WorkflowRunSummary {
  readonly runId: string
  readonly templateId: string
  readonly status: import('../core/index.js').PersistedWorkflowRunStatus
  readonly semanticHash: string
  readonly plan: WorkflowExecutionPlanSnapshot
  readonly authorityRef: string
  readonly origin: WorkflowRunOrigin
  readonly createdAt: number
  readonly updatedAt: number
  readonly checkpointSeq: number
}

export interface WorkflowEventPage {
  readonly events: readonly WorkflowEvent[]
  readonly nextAfterSeq?: number
}

export type WorkflowReplayMode = 'inspect' | 'recorded' | 'live'

export interface WorkflowReplayRequest {
  readonly runId: string
  readonly mode: WorkflowReplayMode
  readonly authorityRef?: string
  readonly authority?: unknown
  readonly signal?: AbortSignal
}

export interface WorkflowRuntimeApi {
  listNodes(): Promise<readonly WorkflowNodeDescriptor[]>
  listTemplates(): Promise<readonly import('../catalog/index.js').WorkflowCatalogSummary[]>
  validate(template: WorkflowTemplate): Promise<readonly import('../core/index.js').WorkflowDiagnostic[]>
  createDraft(template: WorkflowTemplate): Promise<WorkflowDraft>
  updateDraft(id: string, expectedRevision: number, template: WorkflowTemplate): Promise<WorkflowDraft>
  publish(id: string, expectedDraftRevision: number): Promise<PublishedWorkflowRevision>
  launch(request: WorkflowLaunchRequest): Promise<WorkflowRunHandle>
  resume(request: WorkflowRuntimeResumeRequest): Promise<WorkflowRunHandle>
  getRun(runId: string): Promise<WorkflowRunSummary | undefined>
  readEvents(runId: string, query?: { readonly afterSeq?: number; readonly limit?: number }): Promise<WorkflowEventPage>
  replay(request: WorkflowReplayRequest): Promise<WorkflowRunHandle>
}
