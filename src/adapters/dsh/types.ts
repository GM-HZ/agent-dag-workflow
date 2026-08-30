import type {
  JsonObject,
  JsonValue,
  WorkflowEvent,
  WorkflowRunResult,
  WorkflowTemplate,
} from '../../core/index.js'
import type { WorkflowLaunchTarget } from '../../runtime/index.js'

export interface DshSessionLike {
  readonly id?: string
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
  list(): readonly string[]
  getProvider(name: string): {
    readonly capabilities: {
      readonly outputSchema: boolean
      readonly depthLimit: boolean
      readonly toolFilter: boolean
      readonly persona: boolean
    }
  } | undefined
  start(target: string, request: {
    readonly label?: string
    readonly prompt: readonly { readonly type: 'text'; readonly text: string }[]
    readonly parent: DshAgentLike
    readonly signal: AbortSignal
    readonly outputSchema?: Readonly<Record<string, unknown>>
    readonly maxDepth?: number
    readonly tools?: readonly string[]
    readonly skills?: readonly string[]
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

export interface DshToolRunContextLike {
  readonly agent?: DshAgentLike
  readonly signal: AbortSignal
}

export interface DshWorkflowToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Readonly<Record<string, unknown>>
  readonly output: {
    readonly schema: Readonly<Record<string, unknown>>
    render(args: unknown, value: JsonValue): readonly { readonly type: 'text'; readonly text: string }[]
  }
  readonly isConcurrencySafe?: (args: unknown) => boolean
  execute(args: unknown, context: DshToolRunContextLike): Promise<JsonValue>
}

export interface DshToolRegistryLike extends DshToolRuntimeLike {
  register(definition: DshWorkflowToolDefinition): () => void
  schemas(scope?: unknown): readonly {
    readonly name: string
    readonly description: string
    readonly parameters: Readonly<Record<string, unknown>>
  }[]
}

export interface DshSkillRuntimeLike {
  register(skill: {
    readonly name: string
    readonly description: string
    readonly source: string
    readonly content: string
    readonly invocation?: { readonly modelInvocable: boolean; readonly userInvocable: boolean }
  }): () => void
}

export type DshDagWorkflowStartRequest = {
  readonly inputs: JsonObject
  readonly parent: object
  readonly signal?: AbortSignal
  /** Request/transport lifetime; aborting it detaches without cancelling the durable Run. */
  readonly interruptionSignal?: AbortSignal
  readonly onEvent?: (event: WorkflowEvent) => void
} & (
  | { readonly template: WorkflowTemplate; readonly target?: never }
  | { readonly target: WorkflowLaunchTarget; readonly template?: never }
)

export interface DshDagWorkflowEngine {
  start(request: DshDagWorkflowStartRequest): Promise<DshWorkflowRun>
  resume(request: DshDagWorkflowResumeRequest): Promise<DshWorkflowRun>
  cancel(request: DshDagWorkflowCancelRequest): Promise<WorkflowRunResult>
  owns(runId: string, parent: object): Promise<boolean>
}

export interface DshDagWorkflowCancelRequest {
  readonly runId: string
  readonly parent: object
  readonly reason?: string
  readonly signal?: AbortSignal
  readonly onEvent?: (event: WorkflowEvent) => void
}

export interface DshDagWorkflowResumeRequest {
  readonly runId: string
  readonly parent: object
  readonly signal?: AbortSignal
  /** Host/runner shutdown signal; unlike signal it must not cancel the durable Run. */
  readonly interruptionSignal?: AbortSignal
  readonly onEvent?: (event: WorkflowEvent) => void
  readonly unknownNodeResolutions?: Readonly<Record<string, 'retry' | 'fail'>>
}

export interface DshWorkflowRun {
  readonly id: string
  readonly result: Promise<WorkflowRunResult>
  cancel(reason?: string): Promise<void>
  dispose(): Promise<void>
}

export interface DshWorkflowPluginConfig {
  readonly catalog?: 'memory' | 'external'
  readonly runStore?: 'memory' | 'external'
  /** Optional restart coordinator. Both callbacks must use Host-owned session/Agent state. */
  readonly recovery?: {
    readonly reference: (parent: DshAgentLike) => string
    readonly resolve: (authorityRef: string, context: {
      readonly runId: string
      readonly signal: AbortSignal
    }) => Promise<DshAgentLike | undefined>
  }
}

export type DshDagWorkflowEvent = WorkflowEvent
