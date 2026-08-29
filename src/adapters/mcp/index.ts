import { snapshotJsonObject, snapshotJsonValue, type JsonObject, type JsonSchema, type JsonValue, type WorkflowTemplate } from '../../core/index.js'
import type { WorkflowRuntimeApi } from '../../runtime/index.js'

export interface WorkflowMcpCallContext { readonly authorityRef: string; readonly authority?: unknown; readonly signal?: AbortSignal }
export interface WorkflowMcpToolDescriptor {
  readonly name: string
  readonly description: string
  readonly kind: 'control' | 'workflow'
  readonly inputSchema: JsonSchema
  readonly outputSchema?: JsonSchema
  readonly workflow?: { readonly id: string; readonly revision: number }
}

export class WorkflowMcpServer {
  constructor(private readonly runtime: WorkflowRuntimeApi) {}

  async listTools(): Promise<readonly WorkflowMcpToolDescriptor[]> {
    const control = [
      ['workflow_nodes_list', 'List registered workflow node definitions and schemas.'],
      ['workflow_templates_list', 'List workflow drafts and published revisions.'],
      ['workflow_validate', 'Validate one host-neutral WorkflowTemplate.'],
      ['workflow_draft_create', 'Create a workflow draft.'],
      ['workflow_draft_update', 'CAS-update a workflow draft.'],
      ['workflow_publish', 'Publish an immutable workflow revision.'],
      ['workflow_run', 'Launch a fixed published revision or explicit inline development template.'],
      ['workflow_trace', 'Read one page of authoritative workflow events.'],
      ['workflow_replay', 'Inspect, recorded-replay, or live-rerun a workflow.'],
      ['workflow_resume', 'Resume a paused or recoverable workflow.'],
    ].map(([name, description]) => ({ name: name!, description: description!, kind: 'control' as const, inputSchema: { type: 'object' as const } }))
    const published = (await this.runtime.listTemplates()).filter(template => template.publishedRevision !== undefined)
    const projected = await Promise.all(published.map(async summary => {
      const revision = await this.runtime.getPublished(summary.id, summary.publishedRevision!)
      return {
        name: workflowToolName(summary.id, summary.publishedRevision!),
        description: `Run published workflow ${summary.name} (${summary.id}@${summary.publishedRevision}).`,
        kind: 'workflow' as const,
        workflow: { id: summary.id, revision: summary.publishedRevision! },
        inputSchema: revision.template.spec.inputSchema,
        outputSchema: revision.template.spec.outputSchema,
      }
    }))
    return [...control, ...projected]
  }

  async callTool(name: string, args: JsonObject, context: WorkflowMcpCallContext): Promise<JsonValue> {
    const projected = (await this.listTools()).find(tool => tool.kind === 'workflow' && tool.name === name)
    if (projected?.workflow !== undefined) {
      const handle = await this.runtime.launch({
        target: { type: 'published', ...projected.workflow }, inputs: snapshotJsonObject(args),
        authorityRef: context.authorityRef,
        ...(context.authority === undefined ? {} : { authority: context.authority }),
        origin: { type: 'mcp', source: name },
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      })
      const result = await handle.result
      if (result.status !== 'completed') {
        throw new Error(`projected workflow ${projected.workflow.id}@${projected.workflow.revision} ${result.status}: ${result.error} (run ${result.runId})`)
      }
      return snapshotJsonValue(result.outputs)
    }
    switch (name) {
      case 'workflow_nodes_list': return snapshotJsonValue(await this.runtime.listNodes() as unknown as JsonValue)
      case 'workflow_templates_list': return snapshotJsonValue(await this.runtime.listTemplates() as unknown as JsonValue)
      case 'workflow_validate': return snapshotJsonValue({ diagnostics: await this.runtime.validate(template(args.template)) })
      case 'workflow_draft_create': return snapshotJsonValue(await this.runtime.createDraft(template(args.template)) as unknown as JsonValue)
      case 'workflow_draft_update': return snapshotJsonValue(await this.runtime.updateDraft(text(args.id), integer(args.expectedRevision), template(args.template)) as unknown as JsonValue)
      case 'workflow_publish': return snapshotJsonValue(await this.runtime.publish(text(args.id), integer(args.expectedRevision)) as unknown as JsonValue)
      case 'workflow_run': {
        const target = args.template === undefined
          ? { type: 'published' as const, id: text(args.id), revision: integer(args.revision) }
          : { type: 'inline' as const, template: template(args.template) }
        const handle = await this.runtime.launch({
          target,
          inputs: snapshotJsonObject(args.inputs as JsonObject),
          authorityRef: context.authorityRef,
          ...(context.authority === undefined ? {} : { authority: context.authority }),
          origin: { type: 'mcp' },
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        })
        return snapshotJsonValue(await handle.result as unknown as JsonValue)
      }
      case 'workflow_trace': return snapshotJsonValue(await this.runtime.readEvents(text(args.runId), {
        ...(args.afterSeq === undefined ? {} : { afterSeq: integer(args.afterSeq) }),
        ...(args.limit === undefined ? {} : { limit: integer(args.limit) }),
      }) as unknown as JsonValue)
      case 'workflow_replay': {
        const handle = await this.runtime.replay({
          runId: text(args.runId), mode: replayMode(args.mode), authorityRef: context.authorityRef,
          ...(context.authority === undefined ? {} : { authority: context.authority }),
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        })
        return snapshotJsonValue(await handle.result as unknown as JsonValue)
      }
      case 'workflow_resume': {
        const handle = await this.runtime.resume({
          runId: text(args.runId), authorityRef: context.authorityRef,
          ...(context.authority === undefined ? {} : { authority: context.authority }),
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        })
        return snapshotJsonValue(await handle.result as unknown as JsonValue)
      }
      default: throw new Error(`unknown workflow MCP tool: ${name}`)
    }
  }
}

export function createMcpServer(runtime: WorkflowRuntimeApi): WorkflowMcpServer { return new WorkflowMcpServer(runtime) }

export function workflowToolName(id: string, revision: number): string {
  return `workflow_${id.replaceAll('-', '_')}_r${revision}`
}

function text(value: JsonValue | undefined): string { if (typeof value !== 'string' || value.length === 0) throw new Error('expected non-empty string'); return value }
function integer(value: JsonValue | undefined): number { if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('expected integer'); return value }
function template(value: JsonValue | undefined): WorkflowTemplate { return snapshotJsonObject(value as JsonObject) as unknown as WorkflowTemplate }
function replayMode(value: JsonValue | undefined): 'inspect' | 'recorded' | 'live' { if (value === 'inspect' || value === 'recorded' || value === 'live') return value; throw new Error('invalid replay mode') }
