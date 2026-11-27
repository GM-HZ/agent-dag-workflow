/// <reference types="vite/client" />
import { createRoot } from 'react-dom/client'
import orderTemplateSource from '../../../examples/script-transform.workflow.json?raw'
import orderInputSource from '../../../examples/inputs/script-transform.json?raw'
import orderOutputSource from '../../../examples/expected/script-transform.json?raw'
import { WorkflowStudio } from '../../../src/canvas/client/studio.js'
import type { WorkflowCanvasClientApi } from '../../../src/canvas/client/api.js'
import type { CanvasJsonObject, CanvasNodeDefinition, CanvasRunDetails, CanvasRunHistoryItem, CanvasRunHistoryPage, CanvasRunHistoryRequest, CanvasRunStartRequest, CanvasResumeRequest, CanvasPublishedRevision, CanvasTemplateRequest, CanvasTrace, CanvasTraceRequest, CanvasWorkflowDiagnostic, CanvasWorkflowTemplate } from '../../../src/canvas/types.js'

const smoke = {
  calls: { createDraft: 0, updateDraft: 0, publish: 0, validate: 0, runDraft: 0, trace: 0, listRuns: 0, exportCase: 0, exportEvidence: 0 },
  savedName: '',
  publishedName: '',
  delaySave: false,
  delayPublish: false,
  delayCancel: false,
  releaseSave: undefined as (() => void) | undefined,
  releasePublish: undefined as (() => void) | undefined,
  releaseCancel: undefined as (() => void) | undefined,
  failTrace: false,
  loseAdmissionOnce: false,
  traceEventOnly: 0,
  journalQueries: [] as CanvasTraceRequest[],
  decisions: {} as Readonly<Record<string, 'retry' | 'fail'>>,
  reopen: () => {},
  openHome: () => {},
  failRunning: (_runId: string) => {},
  seedHistoryViews: () => {},
  seedHomeViews: () => {},
}
;(window as unknown as { __canvasSmoke: typeof smoke }).__canvasSmoke = smoke

const definitions: CanvasNodeDefinition[] = [
  node('core.start@1', 'Start', 'start', ['success']),
  node('agent.run@1', 'Agent delegate', 'regular', ['success']),
  node('core.condition@1', 'Quality gate', 'regular', ['true', 'false']),
  { ...node('core.script@1', 'Deterministic JSON transform', 'regular', ['success']), configSchema: { properties: { maxOperations: { type: 'integer' } } } },
  node('human.approval@1', 'Human approval', 'regular', ['approved', 'rejected']),
  node('core.end@1', 'End', 'end', []),
]

const template: CanvasWorkflowTemplate = {
  apiVersion: 'workflow.gm-hz.dev/v1', kind: 'WorkflowTemplate',
  metadata: { id: 'research-signal', name: 'Research quality signal', description: 'Visual fixture' },
  spec: {
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, outputs: {},
    nodes: [
      { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
      { id: 'research', uses: 'agent.run@1', title: 'Collect evidence', with: { prompt: 'Collect evidence for the requested topic.' }, inputs: {} },
      { id: 'quality', uses: 'core.condition@1', title: 'Evidence ≥ 3?', with: { op: 'gte' }, inputs: {} },
      { id: 'approve', uses: 'human.approval@1', title: 'Editorial sign-off', with: { action: 'publish' }, inputs: {} },
      { id: 'end', uses: 'core.end@1', with: {}, inputs: {} },
    ],
    edges: [
      { id: 's-r', source: 'start', target: 'research' },
      { id: 'r-q', source: 'research', target: 'quality' },
      { id: 'q-a', source: 'quality', target: 'approve', sourcePort: 'true' },
      { id: 'q-e', source: 'quality', target: 'end', sourcePort: 'false' },
      { id: 'a-e', source: 'approve', target: 'end', sourcePort: 'approved' },
    ],
  },
  layout: { canvas: { positions: {
    start: { x: 40, y: 220 }, research: { x: 330, y: 100 }, quality: { x: 630, y: 210 }, approve: { x: 930, y: 80 }, end: { x: 930, y: 350 },
  } } },
}

const ok = <T,>(value: T) => Promise.resolve({ ok: true as const, value })
const completedTrace = {
  runId: 'visual-run-1', templateId: template.metadata.id, semanticHash: 'visual-fixture', createdAt: Date.now(),
  status: 'completed' as const, checkpointSeq: 5,
  nodeStates: { start: 'succeeded', research: 'succeeded', quality: 'succeeded', approve: 'skipped', end: 'succeeded' },
  edgeStates: { 's-r': 'taken', 'r-q': 'taken', 'q-a': 'skipped', 'q-e': 'taken', 'a-e': 'skipped' },
  nodeOutputs: {}, nodeProgress: {},
  events: [
    { seq: 1, type: 'run.started', runId: 'visual-run-1' },
    { seq: 2, type: 'node.completed', runId: 'visual-run-1', nodeId: 'research' },
    { seq: 3, type: 'edge.taken', runId: 'visual-run-1', edgeId: 'q-e' },
    { seq: 4, type: 'node.completed', runId: 'visual-run-1', nodeId: 'end' },
    { seq: 5, type: 'run.completed', runId: 'visual-run-1' },
  ],
}
let savedDraft: import('../../../src/canvas/types.js').CanvasWorkflowDraft | undefined
const published: CanvasPublishedRevision = {
  id: template.metadata.id, revision: 1, sourceDraftRevision: 1, publishedAt: Date.now(),
  semanticHash: 'published-fixture', contentHash: 'published-fixture',
  template: {
    ...template,
    metadata: { ...template.metadata, name: 'Archived research revision' },
    spec: {
      ...template.spec,
      inputSchema: { type: 'object', required: ['archivedTopic'], properties: {
        archivedTopic: { type: 'string', title: 'Archived topic' },
        note: { type: 'string', title: 'Optional note' },
        flag: { type: 'boolean', title: 'Include flag' },
        fallback: { type: ['string', 'null'], title: 'Nullable fallback' },
        unselected: { type: 'string', title: 'Unselected value', default: 'schema default' },
      } },
      nodes: [...template.spec.nodes, { id: 'archived-check', uses: 'agent.run@1', title: 'Archived release check', with: {}, inputs: {} }],
      edges: [...template.spec.edges, { id: 'r-archive', source: 'research', target: 'archived-check' }],
    },
  },
}
const runs = new Map<string, { readonly summary: CanvasRunHistoryItem; readonly trace: CanvasTrace; readonly details: CanvasRunDetails }>()
const accepted = new Map<string, string>()
const orderTemplate = JSON.parse(orderTemplateSource) as CanvasWorkflowTemplate
const orderInputs = JSON.parse(orderInputSource) as CanvasJsonObject
const orderOutputs = JSON.parse(orderOutputSource) as CanvasJsonObject

function putRun(trace: CanvasTrace, details: CanvasRunDetails): void {
  runs.set(trace.runId, { trace, details, summary: {
    runId: trace.runId, templateId: details.template.metadata.id, templateName: details.template.metadata.name, status: trace.status,
    createdAt: trace.createdAt, updatedAt: trace.updatedAt ?? trace.createdAt, checkpointSeq: trace.checkpointSeq,
    needsAttention: (trace.needsAttention?.length ?? 0) > 0, origin: { type: 'host', source: 'canvas' },
    ...(details.revision === undefined ? {} : { revision: details.revision }),
    ...(trace.active === undefined ? {} : { active: trace.active }),
  } })
}

smoke.failRunning = runId => {
  const record = runs.get(runId)
  if (record === undefined) return
  const { trace, details } = record
  const seq = trace.checkpointSeq + 1
  const error = 'DSH_TOOL_FAILED: prior draft failed'
  putRun({ ...trace, checkpointSeq: seq, status: 'failed', active: false, error, nodeStates: { research: 'failed' },
    events: [...trace.events, { seq, type: 'node.failed', nodeId: 'research', runId, error }] }, details)
}

smoke.seedHomeViews = () => {
  for (const [index, status, active, needsAttention] of [
    ['active', 'running', true, []], ['interrupted', 'running', false, []], ['decision', 'paused', false, ['research']],
  ] as const) {
    const runId = `visual-home-${index}`
    const trace: CanvasTrace = { ...completedTrace, runId, status, active, needsAttention,
      events: [{ seq: 1, type: 'run.started', runId }], checkpointSeq: 1 }
    putRun(trace, { runId, template, inputs: {} })
  }
}

smoke.seedHistoryViews = () => {
  const { trace, details } = runs.get('visual-run-1')!
  for (const runId of ['visual-interrupted', 'visual-recorded-replay']) {
    const interrupted = runId === 'visual-interrupted'
    const events = (interrupted ? trace.events.slice(0, 1) : trace.events).map(event => ({ ...event, runId }))
    putRun({ ...trace, runId, status: interrupted ? 'running' : 'completed', active: false, checkpointSeq: events.length, events,
      ...(interrupted ? { nodeStates: { start: 'succeeded', research: 'running' } } : { origin: { type: 'replay', source: 'recorded', sourceRef: trace.runId } }),
    }, { ...details, runId })
  }
}

const api = {
  remote: {
    context: (sessionId: string) => ok({ sessionId, authorityRef: 'fixture:canvas', storage: { kind: 'sqlite', path: '/fixture/workflows.db' } }),
    starterOrders: () => ok({ template: orderTemplate, inputs: orderInputs }),
    nodes: () => ok(definitions),
    templates: () => ok(savedDraft === undefined ? [] : [{
      id: savedDraft.id, name: savedDraft.template.metadata.name, draftRevision: savedDraft.revision, updatedAt: savedDraft.updatedAt, publishedRevision: 1,
    }]),
    operations: () => ok({ bindings: [{ metadata: { id: 'daily-orders', revision: 1 },
      spec: { workflow: { id: orderTemplate.metadata.id, revision: 1 }, trigger: { uses: 'cron@1' }, enabled: true },
      schedule: { expression: '0 9 * * *', timezone: 'Asia/Shanghai', nextRunAt: Date.now() + 3600_000, lastTickAt: Date.now() - 60_000,
        lastDecision: { status: 'rejected' as const, manual: false, scheduledAt: Date.now() - 60_000, reasonCode: 'INGRESS_WORKFLOW_INPUT_INVALID' } },
    }], ingress: [], deliveryAttention: [] }),
    runSchedule: () => {
      const runId = 'visual-schedule-trial'
      const trace: CanvasTrace = { ...completedTrace, runId, revision: 1, templateId: orderTemplate.metadata.id,
        origin: { type: 'trigger', source: 'cron-trial', sourceRef: 'daily-orders@1' }, outputs: orderOutputs,
        events: [{ seq: 1, type: 'run.completed', runId }], checkpointSeq: 1 }
      putRun(trace, { runId, template: orderTemplate, revision: 1, inputs: orderInputs })
      return ok({ status: 'launched' as const, runId })
    },
    listRuns: (_sessionId: string, request: CanvasRunHistoryRequest) => {
      smoke.calls.listRuns++
      const matches = [...runs.values()].reverse().map(run => run.summary)
        .filter(run => (request.templateId === undefined || request.templateId === run.templateId)
          && (request.status === undefined || request.status === run.status)
          && (request.revision === undefined || request.revision === run.revision)
          && (request.origin === undefined || request.origin === run.origin.type)
          && (request.query === undefined || `${run.runId} ${run.templateName} ${run.templateId}`.toLowerCase().includes(request.query.toLowerCase()))
          && (request.from === undefined || request.from <= run.updatedAt)
          && (request.through === undefined || request.through >= run.updatedAt))
      const start = request.after === undefined ? 0 : matches.findIndex(run => run.runId === request.after?.runId) + 1
      const items = matches.slice(start, start + 2)
      const last = items.at(-1)
      return ok<CanvasRunHistoryPage>({ items, ...(last !== undefined && start + items.length < matches.length
        ? { nextAfter: { updatedAt: last.updatedAt, runId: last.runId } } : {}) })
    },
    createDraft: (_sessionId: string, request: { readonly template: CanvasWorkflowTemplate }) => {
      smoke.calls.createDraft++
      smoke.savedName = request.template.metadata.name
      savedDraft = {
        id: request.template.metadata.id, revision: 1, template: request.template,
        contentHash: 'visual-content', semanticHash: 'visual-semantic', createdAt: Date.now(), updatedAt: Date.now(),
      }
      return ok(savedDraft)
    },
    readDraft: () => ok(savedDraft),
    revisions: () => ok({ items: [{ revision: 1, publishedAt: published.publishedAt, contentHash: published.contentHash,
      semanticHash: published.semanticHash, sourceDraftRevision: published.sourceDraftRevision }] }),
    readPublished: () => ok(published),
    updateDraft: async (_sessionId: string, request: { readonly id: string; readonly expectedRevision: number; readonly template: CanvasWorkflowTemplate }) => {
      smoke.calls.updateDraft++
      if (savedDraft?.revision !== request.expectedRevision) throw new Error('visual fixture expected the latest saved revision')
      smoke.savedName = request.template.metadata.name
      if (smoke.delaySave) await new Promise<void>(resolve => { smoke.releaseSave = resolve })
      savedDraft = {
        id: request.id, revision: request.expectedRevision + 1, template: request.template,
        contentHash: 'visual-content-updated', semanticHash: 'visual-semantic-updated',
        createdAt: savedDraft?.createdAt ?? Date.now(), updatedAt: Date.now(),
      }
      return ok(savedDraft)
    },
    publish: async (_sessionId: string, request: { readonly id: string; readonly expectedRevision: number }) => {
      smoke.calls.publish++
      const snapshot = savedDraft
      if (snapshot === undefined || request.expectedRevision !== snapshot.revision) throw new Error('visual fixture attempted a stale publish')
      smoke.publishedName = snapshot.template.metadata.name
      if (smoke.delayPublish) await new Promise<void>(resolve => { smoke.releasePublish = resolve })
      return ok({ ...published, template: snapshot.template })
    },
    validate: (_sessionId: string, request: CanvasTemplateRequest) => {
      smoke.calls.validate++
      const diagnostics: CanvasWorkflowDiagnostic[] = []
      if (request.inputs?.blockTool === true) diagnostics.push({
        code: 'WORKFLOW_TOOL_UNAVAILABLE', severity: 'error', message: 'The tool is unavailable.', nodeId: 'research',
      })
      if (request.template.metadata.name === 'Archived research revision' && typeof request.inputs?.archivedTopic !== 'string') diagnostics.push({
        code: 'WORKFLOW_INPUT_INVALID', severity: 'error', message: 'Archived topic is required.', path: ['inputs', 'archivedTopic'],
      })
      return ok({ diagnostics })
    },
    startRun: (_sessionId: string, { target, inputs, requestId }: CanvasRunStartRequest) => {
      const existing = accepted.get(requestId)
      if (existing !== undefined) return ok({ runId: existing, status: 'accepted' })
      const candidate = target.type === 'draft' ? target.template : published.template
      const revision = target.type === 'published' ? target.revision : undefined
      const runId = `visual-run-${++smoke.calls.runDraft}`
      accepted.set(requestId, runId)
      const failed = inputs.fail === true || inputs.archivedTopic === 'archive failure'
      const failedNode = revision === undefined ? 'research' : 'archived-check'
      const error = 'DSH_TOOL_FAILED: visual fixture failure'
      const starter = candidate.metadata.id.startsWith('hello-workflow-')
      const orderStarter = candidate.metadata.id.startsWith('orders-starter-')
      const outputs: CanvasJsonObject = orderStarter ? orderOutputs : starter ? { message: inputs.message ?? null } : { quality: 'verified' }
      const events = completedTrace.events.map(event => ({ ...event, runId }))
      if (runId === 'visual-run-1') {
        events.pop()
        for (let seq = 5; seq <= 104; seq++) events.push({ seq, type: 'checkpoint.committed', runId })
        events.push({ seq: 105, type: 'run.completed', runId })
      }
      const failureEvents: CanvasJsonObject[] = [{ seq: 1, type: 'node.failed', nodeId: failedNode, runId, error }]
      if (runId === 'visual-run-2') {
        for (let seq = 2; seq <= 102; seq++) failureEvents.push({ seq, type: 'checkpoint.committed', runId })
        failureEvents.push({ seq: 103, type: 'run.failed', runId, error })
      }
      let runTrace: CanvasTrace = failed ? {
        ...completedTrace, runId, status: 'failed', error, checkpointSeq: failureEvents.length,
        nodeStates: { start: 'succeeded', [failedNode]: 'failed' },
        events: failureEvents,
      } : {
        ...completedTrace,
        runId,
        templateId: candidate.metadata.id,
        outputs,
        events,
        checkpointSeq: events.length,
        ...(starter ? { nodeStates: { start: 'succeeded', end: 'succeeded' } } : {}),
      }
      if (inputs.slow === true || inputs.paused === true) runTrace = {
        ...completedTrace, runId, templateId: candidate.metadata.id, checkpointSeq: 1, events: events.slice(0, 1),
        status: inputs.slow === true ? 'running' : 'paused', active: inputs.slow === true,
        nodeStates: { start: 'succeeded', research: inputs.slow === true ? 'running' : 'needs_attention' },
        ...(inputs.paused === true ? { needsAttention: ['research', 'approve'] } : {}),
      }
      putRun({ ...runTrace, ...(revision === undefined ? {} : { revision }) }, {
        runId, template: candidate, inputs, ...(revision === undefined ? {} : { revision }),
      })
      if (smoke.loseAdmissionOnce) {
        smoke.loseAdmissionOnce = false
        throw new Error('network connection disconnected after admission')
      }
      return ok({ runId, status: 'accepted' })
    },
    runDetails: (_sessionId: string, { runId }: { readonly runId: string }) => ok(runs.get(runId)!.details),
    exportCase: (_sessionId: string, { runId, redactFields }: { readonly runId: string; readonly redactFields?: readonly string[] }) => {
      smoke.calls.exportCase++
      const { details, trace } = runs.get(runId)!
      return ok({ format: 'agent-dag-workflow.case/v1', name: details.template.metadata.name, source: { runId },
        inputs: redactTopFields(details.inputs, redactFields), expected: { status: trace.status } })
    },
    exportEvidence: (_sessionId: string, { runId, redactFields, includeArtifacts }: {
      readonly runId: string; readonly redactFields?: readonly string[]; readonly includeArtifacts?: boolean
    }) => {
      smoke.calls.exportEvidence++
      const { details, trace } = runs.get(runId)!
      return ok({ format: 'agent-dag-workflow.evidence/v1', runId, inputs: redactTopFields(details.inputs, redactFields),
        journal: trace.events, ...(includeArtifacts ? { artifacts: [{ name: 'visual fixture', content: 'recorded' }] } : {}) })
    },
    resumeRun: (_sessionId: string, { runId, unknownNodeResolutions }: CanvasResumeRequest) => {
      const { trace, details } = runs.get(runId)!
      smoke.decisions = unknownNodeResolutions ?? {}
      const { needsAttention: _previous, ...next } = trace
      putRun({ ...next, status: 'completed', active: false, checkpointSeq: trace.checkpointSeq + 1,
        outputs: { recovered: true }, events: [...trace.events, { seq: trace.checkpointSeq + 1, type: 'run.completed', runId }] }, details)
      return ok({ runId, status: 'accepted' })
    },
    cancel: async (_sessionId: string, { runId }: { readonly runId: string }) => {
      if (smoke.delayCancel) await new Promise<void>(resolve => { smoke.releaseCancel = resolve })
      const { trace, details } = runs.get(runId)!
      putRun({ ...trace, status: 'cancelled', active: false, checkpointSeq: trace.checkpointSeq + 1,
        events: [...trace.events, { seq: trace.checkpointSeq + 1, type: 'run.cancelled', runId }] }, details)
      return ok({ runId, status: 'cancelled' })
    },
    trace: (_sessionId: string, request: CanvasTraceRequest) => {
      smoke.calls.trace++
      smoke.journalQueries.push(request)
      if (smoke.failTrace) throw new Error('network connection disconnected')
      const trace = runs.get(request.runId)?.trace
      if (trace === undefined) throw new Error(`workflow canvas access denied for run ${request.runId}`)
      const after = request.afterSeq ?? 0
      const through = request.throughSeq ?? trace.checkpointSeq
      const before = request.beforeSeq ?? Infinity
      const failures = new Set(['node.failed', 'node.retry-scheduled', 'node.needs-attention', 'capability.failed', 'run.failed', 'run.paused'])
      const remaining = trace.events.filter(event => typeof event.seq === 'number' && event.seq > after && event.seq <= through && event.seq < before
        && (request.nodeId === undefined || event.nodeId === request.nodeId) && (request.failuresOnly !== true || failures.has(String(event.type))))
      const limit = request.limit ?? 200
      const events = request.window === 'recent' ? remaining.slice(-limit) : remaining.slice(0, limit)
      const snapshot = request.eventsOnly ? { ...trace, nodeStates: {}, edgeStates: {}, nodeOutputs: {}, nodeProgress: {} } : trace
      if (request.eventsOnly) smoke.traceEventOnly++
      return ok({ ...snapshot, events, ...(remaining.length <= events.length ? {} : request.window === 'recent'
        ? { nextBeforeSeq: events[0]?.seq } : { nextAfterSeq: events.at(-1)?.seq }) })
    },
  },
  unwrap: <T,>(_operation: string, result: { readonly ok: true; readonly value: T }) => result.value,
  request: async <T,>(_operation: string, invoke: () => Promise<{ readonly ok: true; readonly value: T }>) => (await invoke()).value,
} as unknown as WorkflowCanvasClientApi

const root = createRoot(document.getElementById('root')!)
let generation = 0
smoke.reopen = () => root.render(<WorkflowStudio key={generation++} api={api} sessionId="visual-session" initialTemplate={template} />)
smoke.openHome = () => root.render(<WorkflowStudio key={generation++} api={api} sessionId="visual-session" onClose={() =>
  root.render(<button onClick={smoke.openHome}>Reopen personal workflows</button>)} />)
smoke.reopen()

function node(uses: string, title: string, role: CanvasNodeDefinition['role'], outputPorts: string[]): CanvasNodeDefinition {
  return { catalogId: uses, kind: 'node', uses, title, role, outputPorts, description: title, configSchema: {}, inputSchema: {}, outputSchema: {}, requiredOutputPorts: [], capabilities: [], dependencyKinds: [], defaultRequirements: [], effects: /^(?:agent\.|human\.)/.test(uses) ? 'external' : 'deterministic', retry: 'safe' }
}

function redactTopFields(value: CanvasJsonObject, fields: readonly string[] = []): CanvasJsonObject {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fields.includes(key) ? '[redacted]' : item]))
}
