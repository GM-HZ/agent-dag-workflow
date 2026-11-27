import type { WorkflowArtifactStore } from '../journal/index.js'

export type CanvasJsonPrimitive = string | number | boolean | null
export type CanvasJsonValue = CanvasJsonPrimitive | CanvasJsonObject | readonly CanvasJsonValue[]
export interface CanvasJsonObject { [key: string]: CanvasJsonValue }

export type CanvasWorkflowBinding =
  | { readonly literal: CanvasJsonValue }
  | { readonly input: { readonly path: readonly (string | number)[] } }
  | { readonly output: { readonly nodeId: string; readonly path: readonly (string | number)[] } }

export interface CanvasWorkflowNode {
  readonly id: string
  readonly uses: string
  readonly title?: string
  readonly with: CanvasJsonObject
  readonly inputs: Readonly<Record<string, CanvasWorkflowBinding>>
  readonly expects?: { readonly schema: CanvasJsonObject; readonly maxBytes?: number }
  readonly policy?: { readonly timeoutMs?: number; readonly retry?: { readonly maxAttempts: number } }
}

export interface CanvasWorkflowEdge {
  readonly id: string
  readonly source: string
  readonly target: string
  readonly sourcePort?: string
}

export interface CanvasWorkflowTemplate {
  readonly apiVersion: 'workflow.gm-hz.dev/v1'
  readonly kind: 'WorkflowTemplate'
  readonly metadata: { readonly id: string; readonly name: string; readonly description?: string }
  readonly spec: {
    readonly inputSchema: CanvasJsonObject
    readonly outputSchema: CanvasJsonObject
    readonly requires?: readonly CanvasWorkflowRequirement[]
    readonly nodes: readonly CanvasWorkflowNode[]
    readonly edges: readonly CanvasWorkflowEdge[]
    readonly outputs: Readonly<Record<string, CanvasWorkflowBinding>>
    readonly policies?: {
      readonly maxConcurrentNodes?: number
      readonly maxNodeRuns?: number
      readonly maxDurationMs?: number
      readonly maxOutputBytes?: number
      readonly subworkflowMaxDepth?: number
    }
  }
  readonly layout?: CanvasJsonObject
}

export interface CanvasWorkflowRequirement {
  readonly kind: string
  readonly uses: string
}

export type WorkflowCanvasAction =
  | 'nodes:list' | 'templates:list' | 'revisions:list' | 'revision:read'
  | 'draft:create' | 'draft:read' | 'draft:update' | 'draft:validate' | 'draft:diff' | 'draft:publish'
  | 'run:start' | 'run:resume' | 'run:cancel' | 'run:trace' | 'run:list' | 'run:export'
  | 'bindings:list' | 'ingress:list' | 'delivery:list'
  | 'context:read' | 'schedule:run'

/** Minimal host surface required by Canvas. It deliberately does not depend on DSH. */
export interface WorkflowCanvasSessionLike {
  readonly header?: { readonly origin?: unknown }
  append(type: string, data: unknown): unknown
}

/** A host may adapt any live Agent/session implementation to this structural contract. */
export interface WorkflowCanvasAgentLike {
  readonly session: WorkflowCanvasSessionLike
}

export interface WorkflowCanvasToolSchema {
  readonly name: string
  readonly description: string
  readonly parameters: CanvasJsonObject
}

export interface WorkflowCanvasToolCatalogLike {
  schemas(scope?: unknown): readonly WorkflowCanvasToolSchema[]
}

export interface WorkflowCanvasAuthorizationRequest {
  /** Session identity resolved from the Host-owned live Agent registry. */
  readonly sessionId: string
  readonly agent: WorkflowCanvasAgentLike
  readonly action: WorkflowCanvasAction
  readonly resourceId?: string
}

export interface WorkflowCanvasPrincipal { readonly subject: string; readonly agent: WorkflowCanvasAgentLike }

export interface WorkflowCanvasConfig {
  /** Required for multi-user deployments; layered after the Host resolves a live top-level Agent. */
  readonly authorize?: (
    request: WorkflowCanvasAuthorizationRequest,
  ) => Promise<WorkflowCanvasPrincipal | undefined> | WorkflowCanvasPrincipal | undefined
  /** Optional host-neutral operations adapters. Canvas remains usable without a trigger deployment. */
  readonly bindings?: {
    list(query: CanvasOperationsQuery & { readonly latestOnly: true }): Promise<readonly CanvasWorkflowTriggerBinding[]>
    get(id: string, revision: number): Promise<CanvasWorkflowTriggerBinding | undefined>
  }
  readonly ingress?: { list(query: CanvasOperationsQuery): Promise<readonly CanvasWorkflowIngressRecord[]> }
  readonly delivery?: { listAttention(query: CanvasOperationsQuery): Promise<readonly CanvasWorkflowDeliveryRecord[]> }
  readonly artifactStore?: WorkflowArtifactStore
  readonly storage?: CanvasWorkflowContext['storage']
  readonly schedules?: WorkflowCanvasScheduleHost
}

export interface WorkflowCanvasScheduleHost {
  inspect(id: string, revision: number, principal: WorkflowCanvasPrincipal): Promise<CanvasScheduleSummary | undefined>
  runNow(request: CanvasScheduleRunRequest, principal: WorkflowCanvasPrincipal): Promise<CanvasScheduleRunReceipt>
}

export interface CanvasScheduleRunRequest {
  readonly id: string
  readonly revision: number
  readonly requestId: string
  readonly requestedAt: number
}

export interface CanvasScheduleRunReceipt {
  readonly status: 'launched' | 'rejected' | 'skipped-overlap' | 'skipped-misfire'
  readonly runId?: string
  readonly reasonCode?: string
}

export interface CanvasScheduleSummary {
  readonly expression: string
  readonly timezone: string
  readonly nextRunAt?: number
  readonly lastTickAt?: number
  readonly lastDecision?: CanvasScheduleRunReceipt & { readonly scheduledAt: number; readonly manual: boolean }
  readonly lastRun?: { readonly runId: string; readonly status: CanvasTrace['status']; readonly error?: string }
  readonly unavailable?: boolean
}

export interface CanvasWorkflowContext {
  readonly sessionId: string
  readonly authorityRef?: string
  readonly storage?: { readonly kind: 'sqlite' | 'memory'; readonly path?: string }
}

export interface CanvasStarterWorkflow {
  readonly template: CanvasWorkflowTemplate
  readonly inputs: CanvasJsonObject
}

export interface CanvasRunExportRequest {
  readonly runId: string
  readonly redactFields?: readonly string[]
  readonly includeArtifacts?: boolean
}

/** Host-owned scope. Apply it before limiting results. */
export interface CanvasOperationsQuery {
  readonly authorityRef: string
  readonly limit: number
}

export interface CanvasWorkflowTriggerBinding {
  readonly apiVersion: 'workflow.gm-hz.dev/v1'
  readonly kind: 'WorkflowBinding'
  readonly metadata: { readonly id: string; readonly revision: number }
  readonly spec: {
    readonly workflow: { readonly id: string; readonly revision: number }
    readonly trigger: { readonly uses: string; readonly with: CanvasJsonObject }
    readonly inputMapping: Readonly<Record<string, CanvasJsonValue>>
    readonly authorityRef: string
    readonly enabled?: boolean
    readonly deliveryRef?: string
  }
}

export interface CanvasWorkflowTriggerEnvelope {
  readonly schemaVersion: 1
  readonly triggerId: string
  readonly source: string
  readonly sourceEventId: string
  readonly receivedAt: number
  readonly occurredAt?: number
  readonly payload: CanvasJsonObject
  readonly metadata?: CanvasJsonObject
}

export interface CanvasWorkflowIngressRecord {
  readonly triggerId: string
  readonly dedupeKey: string
  readonly binding: { readonly id: string; readonly revision: number }
  readonly source: string
  readonly sourceEventId: string
  readonly status: 'received' | 'rejected' | 'deduplicated' | 'launched'
  readonly reasonCode?: string
  readonly runId?: string
  readonly receivedAt: number
  readonly envelope: CanvasWorkflowTriggerEnvelope
  readonly duplicateCount?: number
  readonly lastDuplicateAt?: number
  readonly duplicateTriggerIds?: readonly string[]
}

export interface CanvasWorkflowDeliveryRecord {
  readonly invocationId: string
  readonly runId: string
  readonly deliveryRef: string
  readonly phase: 'accepted' | 'progress' | 'terminal'
  readonly payload: CanvasJsonObject
  readonly status: 'pending' | 'delivered' | 'unknown'
  readonly attempts: number
  readonly updatedAt: number
  readonly error?: string
}

export interface CanvasOperationsSnapshot {
  readonly bindings: readonly {
    readonly metadata: CanvasWorkflowTriggerBinding['metadata']
    readonly spec: {
      readonly workflow: CanvasWorkflowTriggerBinding['spec']['workflow']
      readonly trigger: { readonly uses: string }
      readonly enabled: boolean
    }
    readonly schedule?: CanvasScheduleSummary
  }[]
  readonly ingress: readonly Pick<CanvasWorkflowIngressRecord,
    'triggerId' | 'binding' | 'source' | 'sourceEventId' | 'status' | 'reasonCode' | 'runId' | 'receivedAt' | 'duplicateCount'>[]
  readonly deliveryAttention: readonly Pick<CanvasWorkflowDeliveryRecord,
    'invocationId' | 'runId' | 'phase' | 'status' | 'attempts' | 'updatedAt'>[]
}

export interface CanvasListRequest { readonly limit?: number }

export interface CanvasNodeDefinition {
  /** Unique palette identity; Tool entries share tool.call@1 but have distinct catalog ids. */
  readonly catalogId: string
  readonly kind: 'tool' | 'node'
  readonly uses: string
  readonly toolName?: string
  readonly title: string
  readonly description: string
  readonly role: 'start' | 'end' | 'regular'
  readonly configSchema: CanvasJsonObject
  readonly defaultConfig?: CanvasJsonObject
  readonly inputSchema: CanvasJsonObject
  readonly outputSchema: CanvasJsonObject
  readonly outputPorts: readonly string[]
  readonly requiredOutputPorts: readonly string[]
  readonly capabilities: readonly string[]
  readonly dependencyKinds: readonly string[]
  readonly defaultRequirements: readonly CanvasWorkflowRequirement[]
  readonly effects: 'deterministic' | 'external'
  readonly retry: 'never' | 'safe' | 'idempotent'
}

export interface CanvasWorkflowDiagnostic {
  readonly code: string
  readonly severity: 'error' | 'warning'
  readonly message: string
  readonly nodeId?: string
  readonly path?: readonly (string | number)[]
}

export interface CanvasWorkflowDraft {
  readonly id: string
  readonly revision: number
  readonly template: CanvasWorkflowTemplate
  readonly contentHash: string
  readonly semanticHash: string
  readonly createdAt: number
  readonly updatedAt: number
}

export interface CanvasPublishedRevision {
  readonly id: string
  readonly revision: number
  readonly sourceDraftRevision: number
  readonly template: CanvasWorkflowTemplate
  readonly contentHash: string
  readonly semanticHash: string
  readonly publishedAt: number
}

export interface CanvasCatalogSummary {
  readonly id: string
  readonly name: string
  readonly draftRevision: number
  readonly publishedRevision?: number
  readonly updatedAt: number
}

export interface CanvasTemplateDiff {
  readonly contentChanged: boolean
  readonly semanticChanged: boolean
  readonly layoutChanged: boolean
  readonly nodes: { readonly added: readonly string[]; readonly removed: readonly string[]; readonly changed: readonly string[] }
  readonly edges: { readonly added: readonly string[]; readonly removed: readonly string[]; readonly changed: readonly string[] }
}

export interface CanvasDraftCreateRequest { readonly template: CanvasWorkflowTemplate }
export interface CanvasDraftReadRequest { readonly id: string }
export interface CanvasDraftUpdateRequest {
  readonly id: string
  readonly expectedRevision: number
  readonly template: CanvasWorkflowTemplate
}
export interface CanvasTemplateRequest {
  readonly template: CanvasWorkflowTemplate
  /** Include run input and current session readiness in addition to design validation. */
  readonly inputs?: CanvasJsonObject
}
export interface CanvasDraftDiffRequest { readonly id: string; readonly candidate: CanvasWorkflowTemplate }
export interface CanvasDraftPublishRequest { readonly id: string; readonly expectedRevision: number }
export interface CanvasRunRequest { readonly id: string; readonly revision: number; readonly inputs: CanvasJsonObject }
export interface CanvasDraftRunRequest { readonly template: CanvasWorkflowTemplate; readonly inputs: CanvasJsonObject }
export interface CanvasRunStartRequest {
  readonly target: { readonly type: 'draft'; readonly template: CanvasWorkflowTemplate }
    | { readonly type: 'published'; readonly id: string; readonly revision: number }
  readonly inputs: CanvasJsonObject
  readonly requestId: string
}
export interface CanvasRunReceipt { readonly runId: string; readonly status: 'accepted' }
export interface CanvasRunDetails {
  readonly runId: string
  readonly template: CanvasWorkflowTemplate
  readonly inputs: CanvasJsonObject
  readonly revision?: number
  readonly nodeInputs?: Readonly<Record<string, CanvasJsonObject>>
  readonly origin?: { readonly type: string; readonly source?: string; readonly sourceRef?: string }
  readonly relatedRuns?: readonly { readonly nodeId: string; readonly runId: string; readonly kind: 'agent' | 'subworkflow' }[]
}
export interface CanvasPublishedReadRequest { readonly id: string; readonly revision: number }
export interface CanvasRevisionsRequest { readonly id: string; readonly limit?: number; readonly before?: number }
export interface CanvasRevisionSummary {
  readonly revision: number
  readonly publishedAt: number
  readonly contentHash: string
  readonly semanticHash: string
  readonly sourceDraftRevision: number
}
export interface CanvasRevisionsPage { readonly items: readonly CanvasRevisionSummary[]; readonly nextBefore?: number }
export interface CanvasResumeRequest {
  readonly runId: string
  readonly unknownNodeResolutions?: Readonly<Record<string, 'retry' | 'fail'>>
}
export interface CanvasCancelRequest { readonly runId: string; readonly reason?: string }
export interface CanvasTraceRequest {
  readonly runId: string
  readonly afterSeq?: number
  readonly limit?: number
  readonly throughSeq?: number
  /** For later pages of an export, omit repeated checkpoint state and outputs. */
  readonly eventsOnly?: boolean
  readonly window?: 'recent'
  readonly beforeSeq?: number
  readonly nodeId?: string
  readonly failuresOnly?: boolean
}

export interface CanvasRunHistoryCursor { readonly updatedAt: number; readonly runId: string }
export interface CanvasRunHistoryRequest {
  readonly templateId?: string
  readonly status?: CanvasTrace['status']
  readonly query?: string
  readonly revision?: number
  readonly origin?: string
  readonly from?: number
  readonly through?: number
  readonly limit?: number
  readonly after?: CanvasRunHistoryCursor
}
export interface CanvasRunHistoryItem {
  readonly runId: string
  readonly templateId: string
  readonly templateName: string
  readonly revision?: number
  readonly origin: { readonly type: string; readonly source?: string; readonly sourceRef?: string }
  readonly status: CanvasTrace['status']
  readonly createdAt: number
  readonly updatedAt: number
  readonly checkpointSeq: number
  readonly needsAttention: boolean
  readonly active?: boolean
}
export interface CanvasRunHistoryPage {
  readonly items: readonly CanvasRunHistoryItem[]
  readonly nextAfter?: CanvasRunHistoryCursor
}

export interface CanvasRunResult {
  readonly runId: string
  readonly status: 'completed' | 'failed' | 'cancelled' | 'paused'
  readonly outputs?: CanvasJsonObject
  readonly error?: string
  readonly needsAttention?: readonly string[]
}

export interface CanvasTrace {
  readonly runId: string
  readonly templateId: string
  readonly revision?: number
  readonly origin?: CanvasRunHistoryItem['origin']
  readonly semanticHash: string
  readonly createdAt: number
  readonly updatedAt?: number
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled' | 'paused'
  readonly active?: boolean
  readonly checkpointSeq: number
  readonly nodeStates: Readonly<Record<string, string>>
  readonly edgeStates: Readonly<Record<string, string>>
  readonly nodeOutputs: Readonly<Record<string, CanvasJsonObject>>
  readonly nodeProgress: Readonly<Record<string, CanvasJsonValue>>
  readonly events: readonly CanvasJsonObject[]
  readonly nextAfterSeq?: number
  readonly nextBeforeSeq?: number
  readonly outputs?: CanvasJsonObject
  readonly error?: string
  readonly needsAttention?: readonly string[]
}
