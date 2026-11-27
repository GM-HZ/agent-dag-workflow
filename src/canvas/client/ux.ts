import type {
  CanvasJsonObject,
  CanvasNodeDefinition,
  CanvasTrace,
  CanvasWorkflowDiagnostic,
  CanvasWorkflowDraft,
  CanvasWorkflowNode,
  CanvasWorkflowRequirement,
  CanvasWorkflowTemplate,
} from '../types.js'
import { canvasText, type CanvasLocale, type CanvasMessage } from './messages.js'
import type { PendingDraftField } from './draft-fields.js'

export type WorkflowDocumentState = 'pristine' | 'unsaved' | 'dirty' | 'saved' | 'validated' | 'validated-dirty' | 'published'
export type WorkflowConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected'
export type WorkflowErrorKind = 'connection' | 'conflict' | 'permission' | 'validation' | 'not-found' | 'execution' | 'unknown'

export interface WorkflowErrorPresentation {
  readonly kind: WorkflowErrorKind
  readonly title: string
  readonly message: string
  readonly remedy: string
  readonly retryable: boolean
  readonly detail: string
}

export interface WorkflowTraceEventPresentation {
  readonly seq: number
  readonly title: string
  readonly detail: string
  readonly tone: 'neutral' | 'active' | 'success' | 'warning' | 'danger'
  readonly nodeId?: string
  readonly infrastructure: boolean
}

export interface WorkflowNodeRequirementPresentation {
  readonly kind: string
  readonly uses: string
  readonly declared: boolean
}

export interface WorkflowRecoverySnapshot {
  readonly version: 1
  readonly template: CanvasWorkflowTemplate
  readonly draft?: CanvasWorkflowDraft
  readonly inputsText: string
  readonly pendingFields?: readonly PendingDraftField[]
  readonly savedAt: number
}

const documentLabels: Record<WorkflowDocumentState, CanvasMessage> = {
  pristine: 'New workflow',
  unsaved: 'Unsaved',
  dirty: 'Unsaved changes',
  saved: 'Draft saved',
  validated: 'Validation passed',
  'validated-dirty': 'Validation passed · unsaved',
  published: 'Published',
}

const connectionLabels: Record<WorkflowConnectionState, CanvasMessage> = {
  connecting: 'Connecting to DSH',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  disconnected: 'Disconnected from DSH',
}

export function documentStateLabel(state: WorkflowDocumentState, locale: CanvasLocale = 'zh'): string { return canvasText(locale)(documentLabels[state]) }
export function connectionStateLabel(state: WorkflowConnectionState, locale: CanvasLocale = 'zh'): string { return canvasText(locale)(connectionLabels[state]) }
export function hasUnsavedChanges(state: WorkflowDocumentState): boolean {
  return state === 'unsaved' || state === 'dirty' || state === 'validated-dirty'
}

export function classifyWorkflowError(cause: unknown, locale: CanvasLocale = 'zh'): WorkflowErrorPresentation {
  const t = canvasText(locale)
  const detail = errorDetail(cause)
  const normalized = detail.toLocaleLowerCase()
  if (/(failed to fetch|networkerror|econnreset|econnrefused|socket|disconnected|load failed)/i.test(detail)) {
    return {
      kind: 'connection', title: t('Cannot connect to DSH'),
      message: t('DSH may be restarting or the connection may have dropped. Your Canvas changes have been kept.'),
      remedy: t('Try again when DSH is available. Canvas will sync automatically when the connection returns.'), retryable: true, detail,
    }
  }
  if (/(revision|catalog).*(conflict|mismatch)|expectedrevision|cas/i.test(normalized)) {
    return {
      kind: 'conflict', title: t('The draft changed elsewhere'),
      message: t('This Canvas is based on an older draft revision. Saving could overwrite other changes.'),
      remedy: t('Copy the current JSON for backup, then reload the latest draft and compare the changes.'), retryable: false, detail,
    }
  }
  if (/(access denied|permission|unauthori[sz]ed|forbidden|not allowed)/i.test(detail)) {
    return {
      kind: 'permission', title: t('This session does not have permission'),
      message: t('The current top-level agent session is not authorized for this action.'),
      remedy: t('Return to an authorized top-level session or check the workflow dependencies and DSH policy.'), retryable: false, detail,
    }
  }
  if (/(gateway_missing|requires a workflow(?:tool|agent|approval)gateway|host gateway)/i.test(detail)) {
    return {
      kind: 'validation', title: t('The host does not provide a required capability'),
      message: t('The template declares an external node whose gateway is unavailable in this host or agent.'),
      remedy: t('Configure the required tool or agent gateway for this entry point.'), retryable: false, detail,
    }
  }
  if (/(not found|does not exist|unknown node type|unknown tool)/i.test(detail)) {
    return {
      kind: 'not-found', title: t('Referenced resource unavailable'),
      message: t('The draft, run, node, or tool referenced by this workflow is unavailable here.'),
      remedy: t('Refresh the node catalog and check the exact names and versions in the template.'), retryable: false, detail,
    }
  }
  if (/(invalid|schema|diagnostic|undeclared dependency|expectation failed|input.*required|must have required property|must match)/i.test(detail)) {
    return {
      kind: 'validation', title: t('Validation failed'),
      message: t('The inputs, node outputs, or workflow structure do not match the declared contracts.'),
      remedy: t('Open Issues and correct the affected node to match its dependencies and output schema.'), retryable: false, detail,
    }
  }
  if (/(tool[_ ]failed|agent[_ ]failed|node .* failed|workflow .* failed|cancelled|timed? ?out)/i.test(detail)) {
    return {
      kind: 'execution', title: t('Workflow execution failed'),
      message: t('The run stopped. The trace records the failed node and the original error.'),
      remedy: t('Select the failed node to inspect its inputs, output contract, and error before editing or retrying.'), retryable: false, detail,
    }
  }
  return {
    kind: 'unknown', title: t('Action incomplete'), message: t('DSH returned an unrecognized error.'),
    remedy: t('Save a copy of the current Canvas before retrying. If the error persists, export the logs and include the technical details below.'), retryable: false, detail,
  }
}

export function diagnosticTitle(diagnostic: CanvasWorkflowDiagnostic, locale: CanvasLocale = 'zh'): string {
  const t = canvasText(locale)
  const known: Record<string, string> = {
    WORKFLOW_REQUIREMENT_UNDECLARED: t('Undeclared dependency'),
    DUPLICATE_WORKFLOW_REQUIREMENT: t('Duplicate dependency declaration'),
    UNKNOWN_NODE_TYPE: t('Node type unavailable'),
    UNKNOWN_OUTPUT_PORT: t('Output port does not exist'),
    UNKNOWN_WORKFLOW_INPUT: t('Workflow input does not exist'),
    CANVAS_RUN_INPUT_JSON_INVALID: t('Run input must be a valid JSON object.'),
    WORKFLOW_INPUT_INVALID: t('Run input does not match the workflow schema'),
    WORKFLOW_INPUT_TOO_LARGE: t('Run input exceeds the size limit'),
    WORKFLOW_TOOL_UNAVAILABLE: t('Tool unavailable in this session'),
    WORKFLOW_TOOL_VISIBILITY_UNKNOWN: t('Tool availability could not be verified'),
    TOOL_GATEWAY_MISSING: t('Tool gateway unavailable'),
    AGENT_GATEWAY_MISSING: t('Agent gateway unavailable'),
    APPROVAL_GATEWAY_MISSING: t('Approval gateway unavailable'),
    DSH_SUBAGENT_TOOL_FILTER_UNSUPPORTED: t('This DSH version cannot restrict child agent tools'),
    AGENT_TARGET_UNAVAILABLE: t('Agent target unavailable'),
    UNKNOWN_BINDING_NODE: t('Binding references an unknown node'),
    WORKFLOW_SCHEMA_INVALID: t('Invalid workflow schema'),
    WORKFLOW_OUTPUT_BINDING_INVALID: t('Invalid workflow output binding'),
    WORKFLOW_OUTPUT_SOURCE_NOT_END: t('Workflow outputs must come from an end node'),
    SUBWORKFLOW_REVISION_NOT_FOUND: t('Subworkflow revision not found'),
    SUBWORKFLOW_DEPENDENCY_CYCLE: t('Subworkflow dependency cycle'),
  }
  return known[diagnostic.code] ?? (diagnostic.severity === 'error' ? t('Issue to fix') : t('Review suggested'))
}

export function traceEventPresentation(event: CanvasJsonObject, locale: CanvasLocale = 'zh'): WorkflowTraceEventPresentation {
  const t = canvasText(locale)
  const seq = typeof event.seq === 'number' ? event.seq : 0
  const type = typeof event.type === 'string' ? event.type : 'unknown'
  const nodeId = typeof event.nodeId === 'string' ? event.nodeId : undefined
  const edgeId = typeof event.edgeId === 'string' ? event.edgeId : undefined
  const error = typeof event.error === 'string' ? event.error : typeof event.reason === 'string' ? event.reason : undefined
  const labels: Record<string, readonly [string, WorkflowTraceEventPresentation['tone']]> = {
    'run.started': [t('Run started'), 'active'], 'run.resumed': [t('Run resumed'), 'active'],
    'run.completed': [t('Run complete'), 'success'], 'run.failed': [t('Run failed'), 'danger'],
    'run.cancelled': [t('Run canceled'), 'warning'], 'run.paused': [t('Run paused'), 'warning'],
    'node.ready': [t('Node ready'), 'neutral'], 'node.started': [t('Node started'), 'active'],
    'node.waiting': [t('Awaiting human input'), 'warning'], 'node.progress': [t('Node progress saved'), 'active'],
    'node.completed': [t('Node completed'), 'success'], 'node.skipped': [t('Node skipped'), 'neutral'],
    'node.cancelled': [t('Node canceled'), 'warning'], 'node.needs-attention': [t('Node needs attention'), 'warning'],
    'node.retry-scheduled': [t('Node retry scheduled'), 'warning'],
    'node.failed': [t('Node failed'), 'danger'], 'edge.taken': [t('Edge taken'), 'active'],
    'edge.skipped': [t('Edge skipped'), 'neutral'], 'checkpoint.committed': [t('Checkpoint saved'), 'neutral'],
    'capability.requested': [t('External capability requested'), 'active'], 'capability.completed': [t('External capability completed'), 'success'],
    'capability.replayed': [t('Recorded result reused'), 'neutral'], 'capability.failed': [t('External capability failed'), 'danger'],
  }
  const [title, tone] = labels[type] ?? [type, 'neutral']
  const detail = error ?? nodeId ?? edgeId ?? (typeof event.runId === 'string' ? event.runId : t('Workflow'))
  const duration = typeof event.durationMs === 'number' ? t('{duration} ms', { duration: event.durationMs }) : undefined
  return {
    seq, title, tone,
    detail: duration === undefined ? detail : `${detail} · ${duration}`,
    ...(nodeId === undefined ? {} : { nodeId }),
    infrastructure: type === 'checkpoint.committed' || type.startsWith('edge.'),
  }
}

export function nodeRequirementPresentation(
  node: CanvasWorkflowNode,
  definition: CanvasNodeDefinition | undefined,
  declared: readonly CanvasWorkflowRequirement[],
): readonly WorkflowNodeRequirementPresentation[] {
  const requested: CanvasWorkflowRequirement[] = [...(definition?.defaultRequirements ?? [])]
  for (const capability of definition?.capabilities ?? []) requested.push({ kind: 'capability', uses: capability })
  const fixedTool = node.uses === 'tool.call@1' && typeof node.with.uses === 'string' ? node.with.uses : undefined
  if (fixedTool !== undefined) requested.push({ kind: 'tool', uses: fixedTool })
  if (node.uses === 'agent.run@1') {
    for (const uses of stringArray(node.with.tools)) requested.push({ kind: 'tool', uses })
    for (const uses of stringArray(node.with.skills)) requested.push({ kind: 'skill', uses })
  }
  const allowlist = new Set(declared.map(item => `${item.kind}:${item.uses}`))
  const unique = new Map<string, CanvasWorkflowRequirement>()
  for (const requirement of requested) unique.set(`${requirement.kind}:${requirement.uses}`, requirement)
  return [...unique.values()].map(requirement => ({
    ...requirement,
    declared: allowlist.has(`${requirement.kind}:${requirement.uses}`),
  }))
}

export function visibleTraceEvents(trace: CanvasTrace, includeInfrastructure = false, locale: CanvasLocale = 'zh'): readonly WorkflowTraceEventPresentation[] {
  return trace.events.map(event => traceEventPresentation(event, locale)).filter(event => includeInfrastructure || !event.infrastructure)
}

export function runStatusLabel(status: CanvasTrace['status'] | undefined, language: CanvasLocale): string {
  const t = canvasText(language)
  if (status === undefined) return t('No runs yet')
  return { running: t('Running'), completed: t('Run complete'), failed: t('Run failed'), cancelled: t('Canceled'), paused: t('Paused') }[status]
}

export function recoveryStorageKey(sessionId: string): string {
  return `agent-dag-workflow:recovery:${sessionId}`
}

export function serializeRecoverySnapshot(snapshot: WorkflowRecoverySnapshot): string {
  return JSON.stringify(snapshot)
}

export function parseRecoverySnapshot(source: string | null): WorkflowRecoverySnapshot | undefined {
  if (source === null) return undefined
  try {
    const value = JSON.parse(source) as unknown
    if (!isRecord(value) || value.version !== 1 || typeof value.inputsText !== 'string'
      || typeof value.savedAt !== 'number' || !isTemplate(value.template)) return undefined
    const draft = isDraft(value.draft) ? value.draft : undefined
    const pendingFields = Array.isArray(value.pendingFields) ? value.pendingFields.filter((item): item is PendingDraftField =>
      isRecord(item) && typeof item.id === 'string' && typeof item.text === 'string' && (item.nodeId === undefined || typeof item.nodeId === 'string')) : []
    return { version: 1, template: value.template, inputsText: value.inputsText, savedAt: value.savedAt,
      ...(pendingFields.length === 0 ? {} : { pendingFields }), ...(draft === undefined ? {} : { draft }) }
  } catch { return undefined }
}

function isDraft(value: unknown): value is CanvasWorkflowDraft {
  return isRecord(value) && typeof value.id === 'string' && typeof value.revision === 'number'
    && typeof value.contentHash === 'string' && typeof value.semanticHash === 'string'
    && typeof value.createdAt === 'number' && typeof value.updatedAt === 'number' && isTemplate(value.template)
}

function stringArray(value: CanvasJsonObject[string] | undefined): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

export function starterTemplate(seed = Date.now(), locale: CanvasLocale = 'zh'): CanvasWorkflowTemplate {
  const t = canvasText(locale)
  return {
    apiVersion: 'workflow.gm-hz.dev/v1', kind: 'WorkflowTemplate',
    metadata: { id: `hello-workflow-${seed}`, name: t('My first workflow'), description: t('Accept a message and return it unchanged through an auditable DAG.') },
    spec: {
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['message'], examples: [starterInputs(locale)],
        properties: { message: { type: 'string', description: t('Message to pass to the workflow') } },
      },
      outputSchema: {
        type: 'object', additionalProperties: false, required: ['message'],
        properties: { message: { type: 'string' } },
      },
      nodes: [
        { id: 'start', uses: 'core.start@1', title: t('Start'), with: {}, inputs: {} },
        { id: 'end', uses: 'core.end@1', title: t('Return result'), with: {}, inputs: { message: { input: { path: ['message'] } } } },
      ],
      edges: [{ id: 'start-end', source: 'start', target: 'end' }],
      outputs: { message: { output: { nodeId: 'end', path: ['message'] } } },
    },
    layout: { canvas: { positions: { start: { x: 180, y: 220 }, end: { x: 540, y: 220 } } } },
  }
}

export function starterInputs(locale: CanvasLocale): CanvasJsonObject {
  return { message: canvasText(locale)('Hello, DSH Workflow') }
}

export function definitionGroup(definition: CanvasNodeDefinition): 'nodes' | 'tools' {
  return definition.kind === 'tool' ? 'tools' : 'nodes'
}

const builtInNodeCopy: Record<string, readonly [CanvasMessage, CanvasMessage]> = {
  'core.start@1': ['Start', 'Validate and expose workflow inputs to the DAG.'],
  'core.end@1': ['End', 'Assemble the final workflow output object.'],
  'core.condition@1': ['Condition', 'Choose the true or false branch using a fixed operator.'],
  'core.foreach@1': ['For each', 'Run a fixed published revision for each item and save progress for every item.'],
  'core.script@1': ['Deterministic JSON transform', 'Transform JSON in a restricted runtime. Use agent tools for external calls.'],
  'workflow.call@1': ['Subworkflow', 'Run a fixed published workflow revision as a recoverable child call.'],
  'agent.run@1': ['Run agent', 'Run a foreground child agent within the current DSH agent’s permissions.'],
  'human.approval@1': ['Human approval', 'Request an explicit decision through DSH. The default decision is deny.'],
}

export function definitionDisplayTitle(definition: CanvasNodeDefinition, locale: CanvasLocale = 'zh'): string {
  const message = definition.kind === 'tool' ? undefined : builtInNodeCopy[definition.uses]?.[0]
  return message === undefined ? definition.title : canvasText(locale)(message)
}

export function definitionDisplayDescription(definition: CanvasNodeDefinition, locale: CanvasLocale = 'zh'): string {
  const message = definition.kind === 'tool' ? undefined : builtInNodeCopy[definition.uses]?.[1]
  return message === undefined ? definition.description : canvasText(locale)(message)
}

function errorDetail(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  if (typeof cause === 'string') return cause
  try { return JSON.stringify(cause) ?? String(cause) } catch { return String(cause) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isTemplate(value: unknown): value is CanvasWorkflowTemplate {
  return isRecord(value) && value.apiVersion === 'workflow.gm-hz.dev/v1' && value.kind === 'WorkflowTemplate'
    && isRecord(value.metadata) && typeof value.metadata.id === 'string' && typeof value.metadata.name === 'string'
    && isRecord(value.spec) && Array.isArray(value.spec.nodes) && Array.isArray(value.spec.edges)
}
