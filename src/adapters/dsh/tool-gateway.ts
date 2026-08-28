import { WorkflowExecutionError } from '../../core/errors.js'
import type { JsonObject, JsonValue, WorkflowToolGateway, WorkflowToolRequest } from '../../core/types.js'

export interface DshToolExecutionInput {
  readonly callId: string
  readonly name: string
  readonly arguments: JsonObject
  readonly signal: AbortSignal
  readonly agent: unknown
}

export type DshToolExecutionResult =
  | { readonly isError: false; readonly value: JsonValue }
  | { readonly isError: true; readonly error: unknown }

export type DshToolExecute = (input: DshToolExecutionInput) => Promise<DshToolExecutionResult>

/**
 * Adapts the public result shape of `ctx.tools.execute()` without importing
 * Harness packages into the workflow kernel. A Host plugin captures the
 * owning Agent and branded CallId when it supplies `execute`.
 */
export function createDshToolGateway(execute: DshToolExecute): WorkflowToolGateway {
  return {
    async execute(request: WorkflowToolRequest): Promise<JsonValue> {
      const result = await execute({
        callId: request.invocationId,
        name: request.uses,
        arguments: request.inputs,
        signal: request.signal,
        agent: request.authority,
      })
      if (result.isError) {
        throw new WorkflowExecutionError('DSH_TOOL_FAILED', renderToolError(result.error), { nodeId: request.nodeId })
      }
      return result.value
    },
  }
}

function renderToolError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') return error.message
  return String(error)
}
