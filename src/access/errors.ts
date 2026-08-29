import { WorkflowCatalogError } from '../catalog/index.js'
import { WorkflowCompileError, WorkflowExecutionError, snapshotJsonValue, type JsonValue, type WorkflowDiagnostic } from '../core/index.js'
import type { WorkflowAccessErrorShape } from './types.js'

export class WorkflowAccessError extends Error implements WorkflowAccessErrorShape {
  readonly code: string
  readonly diagnostics?: readonly WorkflowDiagnostic[]
  readonly details?: JsonValue

  constructor(code: string, message: string, options: { readonly diagnostics?: readonly WorkflowDiagnostic[]; readonly details?: JsonValue; readonly cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'WorkflowAccessError'
    this.code = code
    if (options.diagnostics !== undefined) this.diagnostics = options.diagnostics
    if (options.details !== undefined) this.details = snapshotJsonValue(options.details)
  }
}

export function normalizeWorkflowAccessError(error: unknown): WorkflowAccessError {
  if (error instanceof WorkflowAccessError) return error
  if (error instanceof WorkflowCatalogError) {
    const code = catalogErrorCode(error.code)
    return new WorkflowAccessError(code, error.message, {
      ...(error.diagnostics === undefined ? {} : { diagnostics: error.diagnostics }),
      cause: error,
    })
  }
  if (error instanceof WorkflowCompileError) {
    return new WorkflowAccessError('WORKFLOW_VALIDATION_FAILED', error.message, { diagnostics: error.diagnostics, cause: error })
  }
  if (error instanceof WorkflowExecutionError) {
    return new WorkflowAccessError(executionErrorCode(error.code), error.message, {
      details: { engineCode: error.code, ...(error.nodeId === undefined ? {} : { nodeId: error.nodeId }) },
      cause: error,
    })
  }
  const message = renderError(error)
  if (/workflow run (?:not found|disappeared)/i.test(message)) return new WorkflowAccessError('WORKFLOW_RUN_NOT_FOUND', message, { cause: error })
  if (/authority|permission|capabilit/i.test(message)) return new WorkflowAccessError('WORKFLOW_AUTHORITY_DENIED', message, { cause: error })
  if (/background workflow launch requires/i.test(message)) return new WorkflowAccessError('WORKFLOW_BACKGROUND_UNAVAILABLE', message, { cause: error })
  if (/idempotency key/i.test(message)) return new WorkflowAccessError('WORKFLOW_IDEMPOTENCY_CONFLICT', message, { cause: error })
  return new WorkflowAccessError('WORKFLOW_INTERNAL_ERROR', message, { cause: error })
}

export function workflowAccessErrorShape(error: unknown): WorkflowAccessErrorShape {
  const normalized = normalizeWorkflowAccessError(error)
  return {
    code: normalized.code,
    message: normalized.message,
    ...(normalized.diagnostics === undefined ? {} : { diagnostics: normalized.diagnostics }),
    ...(normalized.details === undefined ? {} : { details: normalized.details }),
  }
}

function catalogErrorCode(code: string): string {
  switch (code) {
    case 'CATALOG_NOT_FOUND': return 'WORKFLOW_NOT_FOUND'
    case 'CATALOG_REVISION_CONFLICT': return 'WORKFLOW_REVISION_CONFLICT'
    case 'CATALOG_ALREADY_EXISTS': return 'WORKFLOW_ALREADY_EXISTS'
    case 'CATALOG_PUBLISH_INVALID': return 'WORKFLOW_VALIDATION_FAILED'
    case 'CATALOG_ID_MISMATCH':
    case 'CATALOG_INVALID_ENVELOPE': return 'WORKFLOW_REQUEST_INVALID'
    default: return 'WORKFLOW_CATALOG_ERROR'
  }
}

function executionErrorCode(code: string): string {
  if (code === 'WORKFLOW_INPUT_INVALID') return code
  if (code === 'NODE_OUTPUT_INVALID' || code === 'NODE_OUTPUT_EXPECTATION_FAILED' || code === 'RECORDED_OUTPUT_INVALID') return 'WORKFLOW_OUTPUT_INVALID'
  if (code === 'AUTHORITY_MISMATCH' || code.includes('CAPABILITY') || code.includes('AUTHORITY')) return 'WORKFLOW_AUTHORITY_DENIED'
  if (code === 'RUN_NOT_FOUND') return 'WORKFLOW_RUN_NOT_FOUND'
  if (code === 'WORKFLOW_CANCELLED') return 'WORKFLOW_RUN_CANCELLED'
  return 'WORKFLOW_RUN_FAILED'
}

function renderError(error: unknown): string {
  if (error instanceof Error) return error.message
  try { return String(error) } catch { return '[unrenderable error]' }
}
