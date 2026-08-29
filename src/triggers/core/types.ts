import type { JsonObject, JsonSchema, JsonValue } from '../../core/index.js'

export interface WorkflowTriggerEnvelope {
  readonly schemaVersion: 1
  readonly triggerId: string
  readonly source: string
  readonly sourceEventId: string
  readonly receivedAt: number
  readonly occurredAt?: number
  readonly payload: JsonObject
  readonly metadata?: JsonObject
}

export type WorkflowInputMappingValue =
  | { readonly literal: JsonValue }
  | { readonly payload: { readonly path: readonly (string | number)[] } }
  | { readonly metadata: { readonly path: readonly (string | number)[] } }

export interface WorkflowTriggerBinding {
  readonly apiVersion: 'workflow.gm-hz.dev/v1alpha1'
  readonly kind: 'WorkflowBinding'
  readonly metadata: { readonly id: string; readonly revision: number }
  readonly spec: {
    readonly workflow: { readonly id: string; readonly revision: number }
    readonly trigger: { readonly uses: string; readonly with: JsonObject }
    readonly inputMapping: Readonly<Record<string, WorkflowInputMappingValue>>
    readonly authorityRef: string
    readonly enabled?: boolean
    readonly deliveryRef?: string
  }
}

export type WorkflowTriggerBindingCandidate = Omit<WorkflowTriggerBinding, 'metadata'> & {
  readonly metadata: { readonly id: string }
}

export interface WorkflowBindingRepository {
  publish(candidate: WorkflowTriggerBindingCandidate, expectedRevision: number, publishedAt: number): Promise<WorkflowTriggerBinding>
  get(id: string, revision?: number): Promise<WorkflowTriggerBinding | undefined>
  list(query?: { readonly limit?: number }): Promise<readonly WorkflowTriggerBinding[]>
}

export interface WorkflowBindingTargetCatalog {
  getPublished(id: string, revision?: number): Promise<{ readonly template: { readonly spec: { readonly inputSchema: JsonSchema } } }>
}

export interface WorkflowTriggerDefinition {
  readonly uses: string
  readonly configSchema: JsonSchema
}

export type WorkflowIngressStatus = 'received' | 'rejected' | 'deduplicated' | 'launched'

export interface WorkflowIngressRecord {
  readonly triggerId: string
  readonly dedupeKey: string
  readonly binding: { readonly id: string; readonly revision: number }
  readonly source: string
  readonly sourceEventId: string
  readonly status: WorkflowIngressStatus
  readonly reasonCode?: string
  readonly runId?: string
  readonly receivedAt: number
  readonly envelope: WorkflowTriggerEnvelope
  readonly duplicateCount?: number
  readonly lastDuplicateAt?: number
  readonly duplicateTriggerIds?: readonly string[]
}

export interface WorkflowIngressStore {
  acceptOrGet(record: WorkflowIngressRecord): Promise<{ readonly record: WorkflowIngressRecord; readonly accepted: boolean }>
  markLaunched(triggerId: string, runId: string): Promise<void>
  markRejected(triggerId: string, reasonCode: string): Promise<void>
  get(triggerId: string): Promise<WorkflowIngressRecord | undefined>
  listPending(): Promise<readonly WorkflowIngressRecord[]>
  list(query?: { readonly limit?: number }): Promise<readonly WorkflowIngressRecord[]>
}
