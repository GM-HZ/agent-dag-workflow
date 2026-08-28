import type { WorkflowDiagnostic } from './types.js'

export class WorkflowCompileError extends Error {
  readonly diagnostics: readonly WorkflowDiagnostic[]

  constructor(diagnostics: readonly WorkflowDiagnostic[]) {
    super(diagnostics.map(diagnostic => `${diagnostic.code}: ${diagnostic.message}`).join('\n'))
    this.name = 'WorkflowCompileError'
    this.diagnostics = diagnostics
  }
}

export class WorkflowExecutionError extends Error {
  readonly code: string
  readonly nodeId?: string

  constructor(code: string, message: string, options?: { readonly nodeId?: string; readonly cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'WorkflowExecutionError'
    this.code = code
    if (options?.nodeId !== undefined) this.nodeId = options.nodeId
  }
}

/** A nested durable activity cannot continue until an operator resolves its child run. */
export class WorkflowPauseError extends Error {
  readonly childRunId?: string

  constructor(message: string, childRunId?: string) {
    super(message)
    this.name = 'WorkflowPauseError'
    if (childRunId !== undefined) this.childRunId = childRunId
  }
}
