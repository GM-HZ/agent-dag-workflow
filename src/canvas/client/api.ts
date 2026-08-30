import type {
  CanvasCatalogSummary,
  CanvasCancelRequest,
  CanvasListRequest,
  CanvasOperationsSnapshot,
  CanvasDraftCreateRequest,
  CanvasDraftDiffRequest,
  CanvasDraftPublishRequest,
  CanvasDraftReadRequest,
  CanvasDraftRunRequest,
  CanvasDraftUpdateRequest,
  CanvasNodeDefinition,
  CanvasPublishedRevision,
  CanvasResumeRequest,
  CanvasRunRequest,
  CanvasRunResult,
  CanvasTemplateDiff,
  CanvasTemplateRequest,
  CanvasTrace,
  CanvasTraceRequest,
  CanvasWorkflowDiagnostic,
  CanvasWorkflowDraft,
} from '../types.js'
import { classifyWorkflowError, type WorkflowErrorPresentation } from './ux.js'

export interface RemoteFailure { readonly code: string; readonly message: string }
export type RemoteResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: RemoteFailure }

export interface WorkflowCanvasRequestOptions {
  /** Only use retries for idempotent reads. Canvas mutations deliberately default to zero retries. */
  readonly retries?: number
  readonly onRetry?: (attempt: number, error: WorkflowCanvasRequestError) => void
}

export class WorkflowCanvasRequestError extends Error {
  readonly presentation: WorkflowErrorPresentation
  constructor(readonly operation: string, cause: unknown) {
    const presentation = classifyWorkflowError(cause)
    super(presentation.detail, { cause })
    this.name = 'WorkflowCanvasRequestError'
    this.presentation = presentation
  }
}

export interface WorkflowCanvasRemoteNamespace {
  nodes(sessionId: string): Promise<RemoteResult<readonly CanvasNodeDefinition[]>>
  templates(sessionId: string): Promise<RemoteResult<readonly CanvasCatalogSummary[]>>
  operations(sessionId: string, request: CanvasListRequest): Promise<RemoteResult<CanvasOperationsSnapshot>>
  createDraft(sessionId: string, request: CanvasDraftCreateRequest): Promise<RemoteResult<CanvasWorkflowDraft>>
  readDraft(sessionId: string, request: CanvasDraftReadRequest): Promise<RemoteResult<CanvasWorkflowDraft>>
  updateDraft(sessionId: string, request: CanvasDraftUpdateRequest): Promise<RemoteResult<CanvasWorkflowDraft>>
  validate(sessionId: string, request: CanvasTemplateRequest): Promise<RemoteResult<{ readonly diagnostics: readonly CanvasWorkflowDiagnostic[] }>>
  diff(sessionId: string, request: CanvasDraftDiffRequest): Promise<RemoteResult<CanvasTemplateDiff>>
  publish(sessionId: string, request: CanvasDraftPublishRequest): Promise<RemoteResult<CanvasPublishedRevision>>
  run(sessionId: string, request: CanvasRunRequest, signal?: AbortSignal): Promise<RemoteResult<CanvasRunResult>>
  runDraft(sessionId: string, request: CanvasDraftRunRequest, signal?: AbortSignal): Promise<RemoteResult<CanvasRunResult>>
  resume(sessionId: string, request: CanvasResumeRequest, signal?: AbortSignal): Promise<RemoteResult<CanvasRunResult>>
  cancel(sessionId: string, request: CanvasCancelRequest, signal?: AbortSignal): Promise<RemoteResult<CanvasRunResult>>
  trace(sessionId: string, request: CanvasTraceRequest): Promise<RemoteResult<CanvasTrace>>
}

export interface WorkflowCanvasClientApi {
  readonly remote: WorkflowCanvasRemoteNamespace
  unwrap<T>(operation: string, result: RemoteResult<T>): T
  request<T>(operation: string, invoke: () => Promise<RemoteResult<T>>, options?: WorkflowCanvasRequestOptions): Promise<T>
}

export function createWorkflowCanvasApi(remote: WorkflowCanvasRemoteNamespace): WorkflowCanvasClientApi {
  return {
    remote,
    unwrap<T>(operation: string, result: RemoteResult<T>): T {
      if (result.ok) return result.value
      throw new WorkflowCanvasRequestError(operation, `${result.error.code}: ${result.error.message}`)
    },
    async request<T>(operation: string, invoke: () => Promise<RemoteResult<T>>, options: WorkflowCanvasRequestOptions = {}): Promise<T> {
      const retries = options.retries ?? 0
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await invoke()
          if (result.ok) return result.value
          throw new WorkflowCanvasRequestError(operation, `${result.error.code}: ${result.error.message}`)
        } catch (cause: unknown) {
          const error = cause instanceof WorkflowCanvasRequestError ? cause : new WorkflowCanvasRequestError(operation, cause)
          if (!error.presentation.retryable || attempt >= retries) throw error
          options.onRetry?.(attempt + 1, error)
          await delay(200 * (attempt + 1))
        }
      }
    },
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}
