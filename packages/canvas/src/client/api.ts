import type {
  CanvasCatalogSummary,
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

interface RemoteFailure { readonly code: string; readonly message: string }
type RemoteResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: RemoteFailure }

export interface WorkflowCanvasRemoteNamespace {
  nodes(sessionId: string): Promise<RemoteResult<readonly CanvasNodeDefinition[]>>
  templates(sessionId: string): Promise<RemoteResult<readonly CanvasCatalogSummary[]>>
  createDraft(sessionId: string, request: CanvasDraftCreateRequest): Promise<RemoteResult<CanvasWorkflowDraft>>
  readDraft(sessionId: string, request: CanvasDraftReadRequest): Promise<RemoteResult<CanvasWorkflowDraft>>
  updateDraft(sessionId: string, request: CanvasDraftUpdateRequest): Promise<RemoteResult<CanvasWorkflowDraft>>
  validate(sessionId: string, request: CanvasTemplateRequest): Promise<RemoteResult<{ readonly diagnostics: readonly CanvasWorkflowDiagnostic[] }>>
  diff(sessionId: string, request: CanvasDraftDiffRequest): Promise<RemoteResult<CanvasTemplateDiff>>
  publish(sessionId: string, request: CanvasDraftPublishRequest): Promise<RemoteResult<CanvasPublishedRevision>>
  run(sessionId: string, request: CanvasRunRequest, signal?: AbortSignal): Promise<RemoteResult<CanvasRunResult>>
  runDraft(sessionId: string, request: CanvasDraftRunRequest, signal?: AbortSignal): Promise<RemoteResult<CanvasRunResult>>
  resume(sessionId: string, request: CanvasResumeRequest, signal?: AbortSignal): Promise<RemoteResult<CanvasRunResult>>
  trace(sessionId: string, request: CanvasTraceRequest): Promise<RemoteResult<CanvasTrace>>
}

export interface WorkflowCanvasClientApi {
  readonly remote: WorkflowCanvasRemoteNamespace
  unwrap<T>(operation: string, result: RemoteResult<T>): T
}

export function createWorkflowCanvasApi(remote: WorkflowCanvasRemoteNamespace): WorkflowCanvasClientApi {
  return {
    remote,
    unwrap<T>(operation: string, result: RemoteResult<T>): T {
      if (result.ok) return result.value
      throw new Error(`${operation} failed: ${result.error.code}: ${result.error.message}`)
    },
  }
}
