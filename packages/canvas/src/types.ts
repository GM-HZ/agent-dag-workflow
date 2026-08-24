import type { DshAgentLike } from '@gm-hz/dsh-dag-workflow-host'

export type CanvasJsonPrimitive = string | number | boolean | null
export type CanvasJsonValue = CanvasJsonPrimitive | CanvasJsonObject | readonly CanvasJsonValue[]
export interface CanvasJsonObject { [key: string]: CanvasJsonValue }

export type CanvasWorkflowBinding =
  | { readonly literal: CanvasJsonValue }
  | { readonly input: string }
  | { readonly output: { readonly node: string; readonly path: readonly (string | number)[] } }
  | { readonly secret: { readonly ref: string } }

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
  readonly apiVersion: 'dsh.workflow/v1alpha1'
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

export interface WorkflowCanvasAuthorizationRequest {
  /** Session identity resolved from the Host-owned live Agent registry. */
  readonly sessionId: string
  readonly agent: DshAgentLike
  readonly action: WorkflowCanvasAction
  readonly resourceId?: string
}

export interface WorkflowCanvasPrincipal { readonly subject: string; readonly agent: DshAgentLike }

export interface WorkflowCanvasConfig {
  /** Required for multi-user deployments; layered after the Host resolves a live top-level Agent. */
  readonly authorize?: (
    request: WorkflowCanvasAuthorizationRequest,
  ) => Promise<WorkflowCanvasPrincipal | undefined> | WorkflowCanvasPrincipal | undefined
}

export interface CanvasNodeDefinition {
  /** Unique palette identity; Tool entries share dsh.tool@1 but have distinct catalog ids. */
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
