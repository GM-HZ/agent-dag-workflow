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
  readonly apiVersion: 'workflow.gm-hz.dev/v1alpha1'
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
  | 'nodes:list' | 'templates:list'
  | 'draft:create' | 'draft:read' | 'draft:update' | 'draft:validate' | 'draft:diff' | 'draft:publish'
  | 'run:start' | 'run:resume' | 'run:trace'
  | 'bindings:list' | 'ingress:list' | 'delivery:list'

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
  readonly bindings?: { list(): Promise<readonly CanvasWorkflowTriggerBinding[]> }
  readonly ingress?: { list(query?: { readonly limit?: number }): Promise<readonly CanvasWorkflowIngressRecord[]> }
  readonly delivery?: { listAttention(query?: { readonly limit?: number }): Promise<readonly CanvasWorkflowDeliveryRecord[]> }
}

export interface CanvasWorkflowTriggerBinding {
  readonly apiVersion: 'workflow.gm-hz.dev/v1alpha1'
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
  readonly bindings: readonly CanvasWorkflowTriggerBinding[]
  readonly ingress: readonly CanvasWorkflowIngressRecord[]
  readonly deliveryAttention: readonly CanvasWorkflowDeliveryRecord[]
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
export interface CanvasTemplateRequest { readonly template: CanvasWorkflowTemplate }
export interface CanvasDraftDiffRequest { readonly id: string; readonly candidate: CanvasWorkflowTemplate }
export interface CanvasDraftPublishRequest { readonly id: string; readonly expectedRevision: number }
export interface CanvasRunRequest { readonly id: string; readonly revision: number; readonly inputs: CanvasJsonObject }
export interface CanvasDraftRunRequest { readonly template: CanvasWorkflowTemplate; readonly inputs: CanvasJsonObject }
export interface CanvasResumeRequest {
  readonly runId: string
  readonly unknownNodeResolutions?: Readonly<Record<string, 'retry' | 'fail'>>
}
export interface CanvasTraceRequest { readonly runId: string }

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
  readonly semanticHash: string
  readonly createdAt: number
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled' | 'paused'
  readonly checkpointSeq: number
  readonly nodeStates: Readonly<Record<string, string>>
  readonly edgeStates: Readonly<Record<string, string>>
  readonly nodeOutputs: Readonly<Record<string, CanvasJsonObject>>
  readonly nodeProgress: Readonly<Record<string, CanvasJsonValue>>
  readonly events: readonly CanvasJsonObject[]
  readonly error?: string
}
