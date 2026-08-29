import { normalizeWorkflowAccessError, type WorkflowAccessErrorShape } from '../../access/index.js'

export const WORKFLOW_CLI_PROTOCOL_VERSION = 'agent-workflow.cli/v1' as const

export interface WorkflowCliSuccess<T> {
  readonly protocolVersion: typeof WORKFLOW_CLI_PROTOCOL_VERSION
  readonly ok: true
  readonly data: T
  readonly meta: { readonly command: string; readonly durationMs: number }
}

export interface WorkflowCliFailure {
  readonly protocolVersion: typeof WORKFLOW_CLI_PROTOCOL_VERSION
  readonly ok: false
  readonly error: WorkflowAccessErrorShape
  readonly meta: { readonly command: string; readonly durationMs: number }
}

export type WorkflowCliEnvelope<T> = WorkflowCliSuccess<T> | WorkflowCliFailure

export function workflowCliSuccess<T>(command: string, durationMs: number, data: T): WorkflowCliSuccess<T> {
  return { protocolVersion: WORKFLOW_CLI_PROTOCOL_VERSION, ok: true, data, meta: { command, durationMs } }
}

export function workflowCliFailure(command: string, durationMs: number, error: unknown): WorkflowCliFailure {
  const normalized = normalizeWorkflowAccessError(error)
  return {
    protocolVersion: WORKFLOW_CLI_PROTOCOL_VERSION,
    ok: false,
    error: {
      code: normalized.code,
      message: normalized.message,
      ...(normalized.diagnostics === undefined ? {} : { diagnostics: normalized.diagnostics }),
      ...(normalized.details === undefined ? {} : { details: normalized.details }),
    },
    meta: { command, durationMs },
  }
}

export function workflowCliExitCode(error: unknown): number {
  const code = normalizeWorkflowAccessError(error).code
  if (code === 'WORKFLOW_REQUEST_INVALID' || code === 'WORKFLOW_REVISION_REQUIRED') return 2
  if (code === 'WORKFLOW_VALIDATION_FAILED' || code === 'WORKFLOW_ALREADY_EXISTS' || code === 'WORKFLOW_REVISION_CONFLICT' || code === 'WORKFLOW_NOT_FOUND') return 3
  if (code === 'WORKFLOW_AUTHORITY_DENIED') return 4
  if (code === 'WORKFLOW_RUN_FAILED' || code === 'WORKFLOW_RUN_CANCELLED' || code === 'WORKFLOW_OUTPUT_INVALID' || code === 'WORKFLOW_NEEDS_ATTENTION') return 5
  return 6
}
