import { snapshotJsonObject, snapshotJsonValue, type JsonObject, type WorkflowTemplate } from '../core/index.js'
import type { WorkflowRuntimeApi } from '../runtime/index.js'
import { WorkflowAccessError, normalizeWorkflowAccessError } from './errors.js'
import type {
  AgentAccessContext,
  WorkflowAgentAccessApi,
  WorkflowAgentRunRequest,
  WorkflowAgentRunResult,
  WorkflowDescription,
  WorkflowDescribeRequest,
  WorkflowDraftProjection,
  WorkflowNodeSearchRequest,
  WorkflowNodeSearchResult,
  WorkflowPublishedProjection,
  WorkflowRunProjection,
  WorkflowSearchRequest,
  WorkflowSearchResult,
  WorkflowTraceProjection,
  WorkflowTraceRequest,
  WorkflowValidationResult,
} from './types.js'

export class WorkflowAgentAccess implements WorkflowAgentAccessApi {
  constructor(private readonly runtime: WorkflowRuntimeApi) {}

  async search(request: WorkflowSearchRequest, _context: AgentAccessContext): Promise<WorkflowSearchResult> {
    try {
      const result = await this.runtime.searchTemplates(request)
      return snapshotJsonValue({
        items: result.items.map(item => ({
          ref: item.ref,
          id: item.id,
          revision: item.revision,
          name: item.name,
          ...(item.description === undefined ? {} : { summary: item.description }),
          semanticHash: item.semanticHash,
          publishedAt: item.publishedAt,
        })),
        ...(result.nextAfter === undefined ? {} : { nextAfter: result.nextAfter }),
      }) as unknown as WorkflowSearchResult
    } catch (error: unknown) { throw normalizeWorkflowAccessError(error) }
  }

  async describe(request: WorkflowDescribeRequest, _context: AgentAccessContext): Promise<WorkflowDescription> {
    try {
      const target = parsePublishedWorkflowRef(request.ref)
      const published = await this.runtime.getPublished(target.id, target.revision)
      const view = request.view ?? 'summary'
      if (view !== 'summary' && view !== 'schema' && view !== 'template') {
        throw new WorkflowAccessError('WORKFLOW_REQUEST_INVALID', `unsupported workflow description view: ${String(view)}`)
      }
      return snapshotJsonValue({
        ref: `${published.id}@${published.revision}`,
        id: published.id,
        revision: published.revision,
        name: published.template.metadata.name,
        ...(published.template.metadata.description === undefined ? {} : { summary: published.template.metadata.description }),
        semanticHash: published.semanticHash,
        publishedAt: published.publishedAt,
        ...(view === 'summary' ? {} : {
          inputSchema: published.template.spec.inputSchema,
          outputSchema: published.template.spec.outputSchema,
          requires: published.template.spec.requires ?? [],
        }),
        ...(view === 'template' ? { template: published.template } : {}),
      }) as unknown as WorkflowDescription
    } catch (error: unknown) { throw normalizeWorkflowAccessError(error) }
  }

  async run(request: WorkflowAgentRunRequest, context: AgentAccessContext): Promise<WorkflowAgentRunResult> {
    try {
      const target = parsePublishedWorkflowRef(request.ref)
      const mode = request.mode ?? 'foreground'
      if (mode !== 'foreground' && mode !== 'background') throw new WorkflowAccessError('WORKFLOW_REQUEST_INVALID', `unsupported workflow run mode: ${String(mode)}`)
      const handle = await this.runtime.launch({
        target: { type: 'published', ...target },
        inputs: snapshotJsonObject(request.inputs),
        authorityRef: context.authorityRef,
        ...(context.authority === undefined ? {} : { authority: context.authority }),
        origin: context.origin,
        executionMode: mode,
        ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      })
      if (mode === 'background') return { runId: handle.runId, status: 'accepted' }
      const result = await handle.result
      return snapshotJsonValue({
        runId: result.runId,
        status: result.status,
        ...(result.status === 'completed' ? { outputs: result.outputs } : { error: result.error }),
        ...('needsAttention' in result && result.needsAttention !== undefined ? { needsAttention: result.needsAttention } : {}),
      }) as unknown as WorkflowAgentRunResult
    } catch (error: unknown) { throw normalizeWorkflowAccessError(error) }
  }

  async getRun(runId: string, _context: AgentAccessContext): Promise<WorkflowRunProjection> {
    try {
      const run = await this.runtime.getRun(assertNonEmpty(runId, 'runId'))
      if (run === undefined) throw new WorkflowAccessError('WORKFLOW_RUN_NOT_FOUND', `workflow run not found: ${runId}`)
      return projectRun(run)
    } catch (error: unknown) { throw normalizeWorkflowAccessError(error) }
  }

  async trace(request: WorkflowTraceRequest, context: AgentAccessContext): Promise<WorkflowTraceProjection> {
    try {
      const run = await this.getRun(request.runId, context)
      const view = request.view ?? 'summary'
      if (view === 'summary') return { run }
      if (view !== 'events') throw new WorkflowAccessError('WORKFLOW_REQUEST_INVALID', `unsupported workflow trace view: ${String(view)}`)
      const afterSeq = request.afterSeq ?? 0
      const limit = Math.min(1000, Math.max(1, request.limit ?? 100))
      const page = await this.runtime.readEvents(request.runId, { afterSeq, limit })
      return snapshotJsonValue({ run, events: page.events, ...(page.nextAfterSeq === undefined ? {} : { nextAfterSeq: page.nextAfterSeq }) }) as unknown as WorkflowTraceProjection
    } catch (error: unknown) { throw normalizeWorkflowAccessError(error) }
  }

  async replay(runId: string, mode: 'inspect' | 'recorded' | 'live', context: AgentAccessContext) {
    try {
      if (mode !== 'inspect' && mode !== 'recorded' && mode !== 'live') throw new WorkflowAccessError('WORKFLOW_REQUEST_INVALID', `unsupported replay mode: ${String(mode)}`)
      const handle = await this.runtime.replay({
        runId: assertNonEmpty(runId, 'runId'),
        mode,
        authorityRef: context.authorityRef,
        ...(context.authority === undefined ? {} : { authority: context.authority }),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      })
      return snapshotJsonValue(await handle.result as unknown as import('../core/index.js').JsonValue) as unknown as import('../core/index.js').WorkflowRunResult
    } catch (error: unknown) { throw normalizeWorkflowAccessError(error) }
  }

  async resume(runId: string, context: AgentAccessContext, unknownNodeResolutions?: Readonly<Record<string, 'retry' | 'fail'>>) {
    try {
      const handle = await this.runtime.resume({
        runId: assertNonEmpty(runId, 'runId'),
        authorityRef: context.authorityRef,
        ...(context.authority === undefined ? {} : { authority: context.authority }),
        ...(unknownNodeResolutions === undefined ? {} : { unknownNodeResolutions }),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      })
      return snapshotJsonValue(await handle.result as unknown as import('../core/index.js').JsonValue) as unknown as import('../core/index.js').WorkflowRunResult
    } catch (error: unknown) { throw normalizeWorkflowAccessError(error) }
  }

  async listNodes(request: WorkflowNodeSearchRequest, _context: AgentAccessContext): Promise<WorkflowNodeSearchResult> {
    try {
      const query = request.query?.trim().toLocaleLowerCase() ?? ''
      if (query.length > 256) throw new WorkflowAccessError('WORKFLOW_REQUEST_INVALID', 'node search query must be at most 256 characters')
      const limit = Math.min(100, Math.max(1, request.limit ?? 20))
      const items = (await this.runtime.listNodes()).filter(item => query.length === 0 || `${item.uses}\n${item.title}\n${item.description}`.toLocaleLowerCase().includes(query)).slice(0, limit)
      return snapshotJsonValue({ items }) as unknown as WorkflowNodeSearchResult
    } catch (error: unknown) { throw normalizeWorkflowAccessError(error) }
  }

  async validate(template: WorkflowTemplate, _context: AgentAccessContext): Promise<WorkflowValidationResult> {
    try { return snapshotJsonValue({ diagnostics: await this.runtime.validate(template) }) as unknown as WorkflowValidationResult }
    catch (error: unknown) { throw normalizeWorkflowAccessError(error) }
  }

  async getDraft(id: string, _context: AgentAccessContext, includeTemplate = true): Promise<WorkflowDraftProjection> {
    try { return projectDraft(await this.runtime.readDraft(assertWorkflowId(id)), includeTemplate) }
    catch (error: unknown) { throw normalizeWorkflowAccessError(error) }
  }

  async putDraft(template: WorkflowTemplate, _context: AgentAccessContext, expectedRevision?: number): Promise<WorkflowDraftProjection> {
    try {
      const draft = expectedRevision === undefined
        ? await this.runtime.createDraft(template)
        : await this.runtime.updateDraft(template.metadata.id, assertPositiveInteger(expectedRevision, 'expectedRevision'), template)
      return projectDraft(draft, false)
    } catch (error: unknown) { throw normalizeWorkflowAccessError(error) }
  }

  async diff(id: string, candidate: WorkflowTemplate, _context: AgentAccessContext) {
    try { return snapshotJsonValue(await this.runtime.diffDraft(assertWorkflowId(id), candidate) as unknown as import('../core/index.js').JsonValue) as unknown as import('../catalog/index.js').WorkflowTemplateDiff }
    catch (error: unknown) { throw normalizeWorkflowAccessError(error) }
  }

  async publish(id: string, expectedDraftRevision: number, _context: AgentAccessContext): Promise<WorkflowPublishedProjection> {
    try {
      const published = await this.runtime.publish(assertWorkflowId(id), assertPositiveInteger(expectedDraftRevision, 'expectedDraftRevision'))
      return snapshotJsonValue({
        ref: `${published.id}@${published.revision}`,
        id: published.id,
        revision: published.revision,
        sourceDraftRevision: published.sourceDraftRevision,
        name: published.template.metadata.name,
        semanticHash: published.semanticHash,
        publishedAt: published.publishedAt,
      }) as unknown as WorkflowPublishedProjection
    } catch (error: unknown) { throw normalizeWorkflowAccessError(error) }
  }
}

export function parsePublishedWorkflowRef(ref: string): { readonly id: string; readonly revision: number } {
  const match = /^(?<id>[a-z][a-z0-9-]*)@(?<revision>[1-9][0-9]*)$/.exec(ref)
  if (match?.groups === undefined) throw new WorkflowAccessError('WORKFLOW_REVISION_REQUIRED', 'workflow ref must be an exact published id@revision')
  return { id: match.groups.id!, revision: Number(match.groups.revision) }
}

function projectRun(run: Awaited<ReturnType<WorkflowRuntimeApi['getRun']>> & {}): WorkflowRunProjection {
  const revision = run.plan.root.revision
  if (revision === undefined) throw new WorkflowAccessError('WORKFLOW_REVISION_REQUIRED', `run ${run.runId} does not reference a published workflow revision`)
  return snapshotJsonValue({
    runId: run.runId,
    ref: `${run.templateId}@${revision}`,
    status: run.status,
    semanticHash: run.semanticHash,
    origin: run.origin,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    checkpointSeq: run.checkpointSeq,
    nodeStates: run.nodeStates,
    ...(run.outputs === undefined ? {} : { outputs: run.outputs }),
    ...(run.error === undefined ? {} : { error: run.error }),
    ...(run.needsAttention === undefined ? {} : { needsAttention: run.needsAttention }),
  }) as unknown as WorkflowRunProjection
}

function projectDraft(draft: Awaited<ReturnType<WorkflowRuntimeApi['readDraft']>>, includeTemplate: boolean): WorkflowDraftProjection {
  return snapshotJsonValue({
    id: draft.id,
    revision: draft.revision,
    name: draft.template.metadata.name,
    contentHash: draft.contentHash,
    semanticHash: draft.semanticHash,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    ...(includeTemplate ? { template: draft.template } : {}),
  }) as unknown as WorkflowDraftProjection
}

function assertWorkflowId(value: string): string {
  if (!/^[a-z][a-z0-9-]*$/.test(value)) throw new WorkflowAccessError('WORKFLOW_REQUEST_INVALID', 'workflow id must be lowercase kebab-case')
  return value
}

function assertNonEmpty(value: string, name: string): string {
  if (value.length === 0 || value.length > 1024) throw new WorkflowAccessError('WORKFLOW_REQUEST_INVALID', `${name} must be 1-1024 characters`)
  return value
}

function assertPositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new WorkflowAccessError('WORKFLOW_REQUEST_INVALID', `${name} must be a positive safe integer`)
  return value
}
