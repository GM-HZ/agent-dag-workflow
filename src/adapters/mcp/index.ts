import { snapshotJsonObject, snapshotJsonValue, type JsonObject, type JsonValue, type WorkflowTemplate } from '../../core/index.js'
import type { WorkflowRuntimeApi } from '../../runtime/index.js'

export interface WorkflowMcpCallContext { readonly authorityRef: string; readonly authority?: unknown; readonly signal?: AbortSignal }

export class WorkflowMcpServer {
  constructor(private readonly runtime: WorkflowRuntimeApi) {}

  listTools(): readonly { readonly name: string; readonly description: string }[] {
    return [
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
    ].map(([name, description]) => ({ name: name!, description: description! }))
  }

  async callTool(name: string, args: JsonObject, context: WorkflowMcpCallContext): Promise<JsonValue> {
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

function text(value: JsonValue | undefined): string { if (typeof value !== 'string' || value.length === 0) throw new Error('expected non-empty string'); return value }
function integer(value: JsonValue | undefined): number { if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('expected integer'); return value }
function template(value: JsonValue | undefined): WorkflowTemplate { return snapshotJsonObject(value as JsonObject) as unknown as WorkflowTemplate }
function replayMode(value: JsonValue | undefined): 'inspect' | 'recorded' | 'live' { if (value === 'inspect' || value === 'recorded' || value === 'live') return value; throw new Error('invalid replay mode') }
