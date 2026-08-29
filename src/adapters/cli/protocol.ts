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
  readonly error: WorkflowAccessErrorShape & { readonly hints?: readonly string[] }
  readonly meta: { readonly command: string; readonly durationMs: number }
}

export type WorkflowCliEnvelope<T> = WorkflowCliSuccess<T> | WorkflowCliFailure

export function workflowCliSuccess<T>(command: string, durationMs: number, data: T): WorkflowCliSuccess<T> {
  return { protocolVersion: WORKFLOW_CLI_PROTOCOL_VERSION, ok: true, data, meta: { command, durationMs } }
}

export function workflowCliFailure(command: string, durationMs: number, error: unknown): WorkflowCliFailure {
  const normalized = normalizeWorkflowAccessError(error)
  const hints = workflowCliErrorHints(normalized)
  return {
    protocolVersion: WORKFLOW_CLI_PROTOCOL_VERSION,
    ok: false,
    error: {
      code: normalized.code,
      message: normalized.message,
      ...(normalized.diagnostics === undefined ? {} : { diagnostics: normalized.diagnostics }),
      ...(normalized.details === undefined ? {} : { details: normalized.details }),
      ...(hints.length === 0 ? {} : { hints }),
    },
    meta: { command, durationMs },
  }
}

export function workflowCliErrorHints(error: WorkflowAccessErrorShape): readonly string[] {
  if (error.code === 'WORKFLOW_HOST_LOAD_FAILED') return [
    'Check that --host points to an existing ESM module and that all of its imports are installed.',
    'The module must export default or a named host object.',
  ]
  if (error.code === 'WORKFLOW_HOST_INVALID') return [
    'Export defineWorkflowCliHost({ services: { tools: { execute() {} } } }) from the Host module.',
    'Only implement gateways used by the Workflow; a Provider layer is not required.',
  ]
  if (error.code === 'WORKFLOW_REVISION_REQUIRED') return [
    'Use search and describe to select an exact published id@revision; never guess the revision.',
    'For a local template, run draft put and publish before run.',
  ]
  if (error.code === 'WORKFLOW_NOT_FOUND' || error.code === 'WORKFLOW_RUN_NOT_FOUND') return [
    error.code === 'WORKFLOW_RUN_NOT_FOUND' ? 'Check the runId and use the same --db and Authority that created the Run.' : 'Run agent-workflow search against the same --db before selecting a published ref.',
  ]
  if (error.code === 'WORKFLOW_INPUT_INVALID') return ['Run agent-workflow describe <id@revision> --view schema and correct only the inputs.']
  if (error.code === 'WORKFLOW_OUTPUT_INVALID') return [
    'Read agent-workflow trace <runId> --events before changing the Workflow.',
    'Treat the Host or Agent output as untrusted and make it satisfy the declared expects/outputSchema.',
  ]
  if (error.code === 'WORKFLOW_AUTHORITY_DENIED') return [
    'Use the same --host/--authority that owns the Run or request the missing Host permission.',
    'Do not expand spec.requires to bypass an Authority denial.',
  ]
  if (error.code === 'WORKFLOW_REVISION_CONFLICT') return ['Read the latest draft, diff the candidate, then retry with its current revision.']
  if (error.code === 'WORKFLOW_NEEDS_ATTENTION') return ['Inspect the Trace and explicitly resolve unknown non-idempotent calls with resume; do not retry blindly.']
  if (error.code === 'WORKFLOW_RUN_FAILED') return [
    'Read agent-workflow trace <runId> --events to locate the failed node.',
    ...(engineCode(error) === 'TOOL_GATEWAY_MISSING' || engineCode(error) === 'AGENT_GATEWAY_MISSING'
      ? ['Pass --host <module.mjs> with the required generic Tool/Agent gateway.'] : []),
  ]
  return []
}

export function workflowCliRunHints(result: { readonly runId: string; readonly status: string; readonly error?: string }): readonly string[] {
  if (result.status === 'paused') return [
    `Run agent-workflow trace ${result.runId} --events before resolving the paused Run.`,
    `Run agent-workflow resume ${result.runId} only after reviewing required decisions.`,
  ]
  if (result.status !== 'failed' && result.status !== 'cancelled') return []
  return [
    `Run agent-workflow trace ${result.runId} --events to inspect the authoritative Journal.`,
    ...(/(?:TOOL|AGENT)_GATEWAY_MISSING|Workflow(?:Tool|Agent)Gateway/u.test(result.error ?? '')
      ? ['Pass --host <module.mjs> with the gateway required by the failed node.'] : []),
  ]
}

export function workflowCliExitCode(error: unknown): number {
  const code = normalizeWorkflowAccessError(error).code
  if (code === 'WORKFLOW_REQUEST_INVALID' || code === 'WORKFLOW_REVISION_REQUIRED' || code === 'WORKFLOW_HOST_INVALID' || code === 'WORKFLOW_HOST_LOAD_FAILED') return 2
  if (code === 'WORKFLOW_VALIDATION_FAILED' || code === 'WORKFLOW_ALREADY_EXISTS' || code === 'WORKFLOW_REVISION_CONFLICT' || code === 'WORKFLOW_NOT_FOUND') return 3
  if (code === 'WORKFLOW_AUTHORITY_DENIED') return 4
  if (code === 'WORKFLOW_RUN_FAILED' || code === 'WORKFLOW_RUN_CANCELLED' || code === 'WORKFLOW_OUTPUT_INVALID' || code === 'WORKFLOW_NEEDS_ATTENTION') return 5
  return 6
}

function engineCode(error: WorkflowAccessErrorShape): string | undefined {
  if (error.details === null || typeof error.details !== 'object' || Array.isArray(error.details)) return undefined
  const code = (error.details as { readonly engineCode?: unknown }).engineCode
  return typeof code === 'string' ? code : undefined
}
