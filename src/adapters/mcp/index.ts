import {
  WorkflowAgentAccess,
  WorkflowAccessError,
  type AgentAccessContext,
  type WorkflowAgentAccessApi,
} from '../../access/index.js'
import { compileJsonValidator, isJsonObject, snapshotJsonObject, snapshotJsonValue, type JsonObject, type JsonSchema, type JsonValue, type WorkflowTemplate } from '../../core/index.js'
import type { WorkflowRuntimeApi } from '../../runtime/index.js'

export type WorkflowMcpProfile = 'invoke' | 'author'

export interface WorkflowMcpCallContext {
  readonly authorityRef: string
  readonly authority?: unknown
  readonly signal?: AbortSignal
}

export interface WorkflowMcpToolDescriptor {
  readonly name: string
  readonly description: string
  readonly kind: 'invoke' | 'author'
  readonly inputSchema: JsonSchema
  readonly outputSchema: JsonSchema
}

export interface WorkflowMcpGatewayOptions { readonly profile?: WorkflowMcpProfile }

export class WorkflowMcpGateway {
  readonly #profile: WorkflowMcpProfile

  constructor(private readonly access: WorkflowAgentAccessApi, options: WorkflowMcpGatewayOptions = {}) {
    this.#profile = options.profile ?? 'invoke'
  }

  listTools(): readonly WorkflowMcpToolDescriptor[] {
    return this.#profile === 'author' ? [...INVOKE_TOOLS, ...AUTHOR_TOOLS] : INVOKE_TOOLS
  }

  async callTool(name: string, rawArgs: JsonObject, context: WorkflowMcpCallContext): Promise<JsonValue> {
    const descriptor = this.listTools().find(tool => tool.name === name)
    if (descriptor === undefined) throw new WorkflowAccessError('WORKFLOW_REQUEST_INVALID', `unknown or unavailable workflow MCP tool: ${name}`)
    const args = snapshotJsonObject(rawArgs)
    const errors = MCP_INPUT_VALIDATORS.get(name)?.(args) ?? ['MCP input schema is unavailable']
    if (errors.length > 0) throw new WorkflowAccessError('WORKFLOW_REQUEST_INVALID', errors.join('; '))
    const accessContext: AgentAccessContext = {
      authorityRef: context.authorityRef,
      ...(context.authority === undefined ? {} : { authority: context.authority }),
      origin: { type: 'mcp', source: name },
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    }
    switch (name) {
      case 'workflow_search': return snapshotJsonValue(await this.access.search({
        ...(args.query === undefined ? {} : { query: text(args.query, 'query') }),
        ...(args.limit === undefined ? {} : { limit: integer(args.limit, 'limit', 1) }),
        ...(args.after === undefined ? {} : { after: text(args.after, 'after') }),
      }, accessContext) as unknown as JsonValue)
      case 'workflow_describe': return snapshotJsonValue(await this.access.describe({
        ref: text(args.ref, 'ref'),
        ...(args.view === undefined ? {} : { view: describeView(args.view) }),
      }, accessContext) as unknown as JsonValue)
      case 'workflow_run': return snapshotJsonValue(await this.access.run({
        ref: text(args.ref, 'ref'),
        inputs: object(args.inputs, 'inputs'),
        ...(args.mode === undefined ? {} : { mode: runMode(args.mode) }),
        ...(args.idempotencyKey === undefined ? {} : { idempotencyKey: text(args.idempotencyKey, 'idempotencyKey') }),
      }, accessContext) as unknown as JsonValue)
      case 'workflow_run_get': return snapshotJsonValue(await this.access.getRun(text(args.runId, 'runId'), accessContext) as unknown as JsonValue)
      case 'workflow_cancel': return snapshotJsonValue(await this.access.cancel(
        text(args.runId, 'runId'), accessContext, args.reason === undefined ? undefined : text(args.reason, 'reason'),
      ) as unknown as JsonValue)
      case 'workflow_trace': return snapshotJsonValue(await this.access.trace({
        runId: text(args.runId, 'runId'),
        ...(args.view === undefined ? {} : { view: traceView(args.view) }),
        ...(args.afterSeq === undefined ? {} : { afterSeq: integer(args.afterSeq, 'afterSeq', 0) }),
        ...(args.limit === undefined ? {} : { limit: integer(args.limit, 'limit', 1) }),
      }, accessContext) as unknown as JsonValue)
      case 'workflow_nodes_list': return snapshotJsonValue(await this.access.listNodes({
        ...(args.query === undefined ? {} : { query: text(args.query, 'query') }),
        ...(args.limit === undefined ? {} : { limit: integer(args.limit, 'limit', 1) }),
      }, accessContext) as unknown as JsonValue)
      case 'workflow_validate': return snapshotJsonValue(await this.access.validate(template(args.template, 'template'), accessContext) as unknown as JsonValue)
      case 'workflow_draft_get': return snapshotJsonValue(await this.access.getDraft(
        text(args.id, 'id'), accessContext, args.includeTemplate === undefined ? true : boolean(args.includeTemplate, 'includeTemplate'),
      ) as unknown as JsonValue)
      case 'workflow_draft_put': return snapshotJsonValue(await this.access.putDraft(
        template(args.template, 'template'), accessContext,
        args.expectedRevision === undefined ? undefined : integer(args.expectedRevision, 'expectedRevision', 1),
      ) as unknown as JsonValue)
      case 'workflow_diff': return snapshotJsonValue(await this.access.diff(
        text(args.id, 'id'), template(args.candidate, 'candidate'), accessContext,
      ) as unknown as JsonValue)
      case 'workflow_publish': return snapshotJsonValue(await this.access.publish(
        text(args.id, 'id'), integer(args.expectedDraftRevision, 'expectedDraftRevision', 1), accessContext,
      ) as unknown as JsonValue)
      default: throw new WorkflowAccessError('WORKFLOW_REQUEST_INVALID', `unimplemented workflow MCP tool: ${name}`)
    }
  }
}

export function createMcpGateway(runtime: WorkflowRuntimeApi, options: WorkflowMcpGatewayOptions = {}): WorkflowMcpGateway {
  return new WorkflowMcpGateway(new WorkflowAgentAccess(runtime), options)
}

const objectOutput: JsonSchema = Object.freeze({ type: 'object' })
const exactRef = Object.freeze({ type: 'string', pattern: '^[a-z][a-z0-9-]*@[1-9][0-9]*$', description: 'Exact published workflow id@revision.' })
const workflowId = Object.freeze({ type: 'string', pattern: '^[a-z][a-z0-9-]*$' })
const positiveInteger = Object.freeze({ type: 'integer', minimum: 1 })

const INVOKE_TOOLS: readonly WorkflowMcpToolDescriptor[] = Object.freeze([
  descriptor('workflow_search', 'Find published workflows. Returns compact metadata only; call workflow_describe for one selected schema.', 'invoke', {
    query: { type: 'string', maxLength: 256 }, limit: { type: 'integer', minimum: 1, maximum: 50 }, after: { type: 'string', maxLength: 256 },
  }),
  descriptor('workflow_describe', 'Describe one exact published workflow. Request schema or template only when needed.', 'invoke', {
    ref: exactRef, view: { type: 'string', enum: ['summary', 'schema', 'template'], default: 'summary' },
  }, ['ref']),
  descriptor('workflow_run', 'Run one exact published workflow revision. Runtime validates inputs against its authoritative schema.', 'invoke', {
    ref: exactRef,
    inputs: { type: 'object' },
    mode: { type: 'string', enum: ['foreground', 'background'], default: 'foreground' },
    idempotencyKey: { type: 'string', minLength: 1, maxLength: 512 },
  }, ['ref', 'inputs']),
  descriptor('workflow_run_get', 'Read a compact persisted workflow run projection without returning its template or execution plan.', 'invoke', {
    runId: { type: 'string', minLength: 1, maxLength: 1024 },
  }, ['runId']),
  descriptor('workflow_cancel', 'Durably cancel a run owned by the calling authority. This is an explicit business operation, not a transport disconnect.', 'invoke', {
    runId: { type: 'string', minLength: 1, maxLength: 1024 },
    reason: { type: 'string', minLength: 1, maxLength: 4096 },
  }, ['runId']),
  descriptor('workflow_trace', 'Read a compact run summary or one bounded page of authoritative Journal events.', 'invoke', {
    runId: { type: 'string', minLength: 1, maxLength: 1024 },
    view: { type: 'string', enum: ['summary', 'events'], default: 'summary' },
    afterSeq: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 1000 },
  }, ['runId']),
])

const AUTHOR_TOOLS: readonly WorkflowMcpToolDescriptor[] = Object.freeze([
  descriptor('workflow_nodes_list', 'Search registered workflow NodeDefinitions and their exact schemas.', 'author', {
    query: { type: 'string', maxLength: 256 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
  }),
  descriptor('workflow_validate', 'Validate one complete host-neutral WorkflowTemplate.', 'author', {
    template: { type: 'object' },
  }, ['template']),
  descriptor('workflow_draft_get', 'Read one draft and its CAS revision.', 'author', {
    id: workflowId, includeTemplate: { type: 'boolean', default: true },
  }, ['id']),
  descriptor('workflow_draft_put', 'Create a draft, or CAS-update it when expectedRevision is supplied.', 'author', {
    template: { type: 'object' }, expectedRevision: positiveInteger,
  }, ['template']),
  descriptor('workflow_diff', 'Compare a candidate template with the current draft.', 'author', {
    id: workflowId, candidate: { type: 'object' },
  }, ['id', 'candidate']),
  descriptor('workflow_publish', 'Publish an immutable revision using the exact current draft revision.', 'author', {
    id: workflowId, expectedDraftRevision: positiveInteger,
  }, ['id', 'expectedDraftRevision']),
])

const MCP_INPUT_VALIDATORS = new Map(
  [...INVOKE_TOOLS, ...AUTHOR_TOOLS].map(tool => [
    tool.name,
    compileJsonValidator(tool.inputSchema, `${tool.name} MCP input`),
  ] as const),
)

function descriptor(
  name: string,
  description: string,
  kind: 'invoke' | 'author',
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[] = [],
): WorkflowMcpToolDescriptor {
  return Object.freeze({
    name,
    description,
    kind,
    inputSchema: Object.freeze({
      type: 'object',
      additionalProperties: false,
      properties,
      ...(required.length === 0 ? {} : { required }),
    }),
    outputSchema: objectOutput,
  })
}

function text(value: JsonValue | undefined, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new WorkflowAccessError('WORKFLOW_REQUEST_INVALID', `${field} must be a non-empty string`)
  return value
}
function integer(value: JsonValue | undefined, field: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new WorkflowAccessError('WORKFLOW_REQUEST_INVALID', `${field} must be a safe integer >= ${minimum}`)
  return value
}
function boolean(value: JsonValue | undefined, field: string): boolean {
  if (typeof value !== 'boolean') throw new WorkflowAccessError('WORKFLOW_REQUEST_INVALID', `${field} must be a boolean`)
  return value
}
function object(value: JsonValue | undefined, field: string): JsonObject {
  if (!isJsonObject(value)) throw new WorkflowAccessError('WORKFLOW_REQUEST_INVALID', `${field} must be an object`)
  return snapshotJsonObject(value)
}
function template(value: JsonValue | undefined, field: string): WorkflowTemplate { return object(value, field) as unknown as WorkflowTemplate }
function describeView(value: JsonValue | undefined): 'summary' | 'schema' | 'template' {
  if (value === 'summary' || value === 'schema' || value === 'template') return value
  throw new WorkflowAccessError('WORKFLOW_REQUEST_INVALID', 'view must be summary, schema, or template')
}
function traceView(value: JsonValue | undefined): 'summary' | 'events' {
  if (value === 'summary' || value === 'events') return value
  throw new WorkflowAccessError('WORKFLOW_REQUEST_INVALID', 'view must be summary or events')
}
function runMode(value: JsonValue | undefined): 'foreground' | 'background' {
  if (value === 'foreground' || value === 'background') return value
  throw new WorkflowAccessError('WORKFLOW_REQUEST_INVALID', 'mode must be foreground or background')
}

export { createWorkflowMcpSdkServer, serveWorkflowMcpStdio } from './stdio.js'
export type { WorkflowMcpSdkServerOptions } from './stdio.js'
