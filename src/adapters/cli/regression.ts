import {
  DagWorkflowEngine, InMemoryWorkflowRunStore, isJsonObject, snapshotJsonObject, snapshotJsonValue, stableJsonStringify,
  WorkflowCompileError, WorkflowExecutionError, WORKFLOW_TEMPLATE_API_VERSION,
  type JsonObject, type JsonValue, type WorkflowDiagnostic, type WorkflowNodeRegistry, type WorkflowNodeStatus,
  type WorkflowRecordedFixture, type WorkflowRunResult, type WorkflowTemplate,
} from '../../core/index.js'
import { WORKFLOW_CASE_FORMAT, type WorkflowCase, type WorkflowCaseExpectation } from '../../journal/index.js'
export { caseFromRun } from '../../journal/index.js'
import type { AgentAccessContext } from '../../access/index.js'
import type { WorkflowRuntime } from '../../runtime/index.js'

type WorkflowCaseEvaluation = {
  readonly status: WorkflowRunResult['status'] | 'not-evaluated'
  readonly passed: boolean
  readonly checks: readonly string[]
  readonly nodes?: Readonly<Record<string, WorkflowNodeStatus>>
  readonly outputs?: JsonObject
  readonly selectedTools?: readonly string[]
  readonly failedNode?: string
  readonly errorCode?: string
  readonly error?: string
  readonly diagnostics?: readonly WorkflowDiagnostic[]
  readonly problem?: 'insufficient-fixtures' | 'evaluation-error'
}

export type WorkflowCaseClassification = 'passed' | 'expected-correction' | 'invalid-case' | 'baseline-drift'
  | 'candidate-regression' | 'insufficient-fixtures' | 'evaluation-error' | 'review-error' | 'review-rejected'

type WorkflowCaseReview = Awaited<ReturnType<typeof reviewWorkflowComparison>>
export interface WorkflowCaseComparison {
  readonly classification: WorkflowCaseClassification
  readonly phase?: 'baseline' | 'candidate' | 'review'
  readonly baseline: WorkflowCaseEvaluation
  readonly candidate: WorkflowCaseEvaluation
  readonly review?: WorkflowCaseReview
  readonly reviewRubric?: NonNullable<WorkflowCase['reviewRubric']>
  readonly error?: string
}

export function readWorkflowCase(value: unknown): WorkflowCase {
  const object = snapshotJsonObject(value)
  if (object.format !== WORKFLOW_CASE_FORMAT || !nonemptyString(object.name) || !isJsonObject(object.inputs)) {
    throw new Error('invalid workflow regression case envelope')
  }
  validateCaseExpectation(object.expected, 'expected')
  if (object.baselineExpected !== undefined) validateCaseExpectation(object.baselineExpected, 'baselineExpected')
  const rubric = object.reviewRubric
  if (rubric !== undefined && (!isJsonObject(rubric) || typeof rubric.id !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/u.test(rubric.id)
    || !Number.isSafeInteger(rubric.version) || Number(rubric.version) < 1 || !Array.isArray(rubric.criteria)
    || rubric.criteria.length < 1 || rubric.criteria.length > 20 || rubric.criteria.some(item => !nonemptyString(item) || item.length > 500)
    || Object.keys(rubric).some(key => !['id', 'version', 'criteria'].includes(key)))) throw new Error('invalid workflow regression reviewRubric')
  if (object.recorded !== undefined) {
    if (!isJsonObject(object.recorded)) throw new Error('recorded fixtures must be an object keyed by node ID')
    for (const [id, fixture] of Object.entries(object.recorded)) {
      if (!isJsonObject(fixture) || !nonemptyString(fixture.uses) || !isJsonObject(fixture.configuration)
        || (fixture.expectedInputs !== undefined && !isJsonObject(fixture.expectedInputs))) throw new Error(`invalid fixture for ${id}`)
      const failure = fixture.failure
      if (failure !== undefined) {
        if (!isJsonObject(failure) || !nonemptyString(failure.code) || typeof failure.message !== 'string'
          || fixture.outputs !== undefined || fixture.selectedPorts !== undefined) throw new Error(`invalid failure fixture for ${id}`)
      } else if (!isJsonObject(fixture.outputs) || !Array.isArray(fixture.selectedPorts)
        || fixture.selectedPorts.length === 0 || !optionalStrings(fixture.selectedPorts)
        || new Set(fixture.selectedPorts).size !== fixture.selectedPorts.length) throw new Error(`invalid output fixture for ${id}`)
    }
  }
  return object as unknown as WorkflowCase
}

export async function compareWorkflowCase(
  sample: WorkflowCase, baselineTemplate: WorkflowTemplate, candidateTemplate: WorkflowTemplate,
  options: {
    readonly registry: WorkflowNodeRegistry
    readonly signal?: AbortSignal
    readonly review?: (inputs: JsonObject) => Promise<WorkflowCaseReview>
  },
): Promise<WorkflowCaseComparison> {
  const baseline = await evaluateWorkflowCase(sample, baselineTemplate, options.registry, sample.baselineExpected ?? sample.expected, options.signal)
  const candidate = await evaluateWorkflowCase(sample, candidateTemplate, options.registry, sample.expected, options.signal)
  const comparison = { baseline, candidate, ...(sample.reviewRubric === undefined ? {} : { reviewRubric: sample.reviewRubric }) }
  if (!baseline.passed) return { ...comparison, classification: baseline.problem ?? 'baseline-drift', phase: 'baseline' }
  if (!candidate.passed) return { ...comparison, classification: candidate.problem ?? 'candidate-regression', phase: 'candidate' }

  const classification = sample.baselineExpected !== undefined && expectationChecks(sample.expected, baseline).length > 0
    ? 'expected-correction' : 'passed'
  if (options.review === undefined) return { ...comparison, classification }
  try {
    const review = await options.review(snapshotJsonObject({ name: sample.name, inputs: sample.inputs, ...comparison }))
    options.signal?.throwIfAborted()
    if (review.status !== 'completed') return { ...comparison, review, classification: 'review-error', phase: 'review' }
    if (!review.approved) return { ...comparison, review, classification: 'review-rejected', phase: 'review' }
    return { ...comparison, review, classification }
  } catch (error: unknown) {
    options.signal?.throwIfAborted()
    return { ...comparison, classification: 'review-error', phase: 'review', error: renderError(error) }
  }
}

async function evaluateWorkflowCase(
  sample: WorkflowCase, template: WorkflowTemplate, registry: WorkflowNodeRegistry, expected: WorkflowCaseExpectation, signal?: AbortSignal,
): Promise<WorkflowCaseEvaluation> {
  try {
    signal?.throwIfAborted()
    const targets = new Map(template.spec.nodes.map(node => [node.id, node]))
    const fixtures = new Map<string, WorkflowRecordedFixture>()
    const unboundFixtures = new Set<string>()
    for (const [id, { uses, configuration, ...recorded }] of Object.entries(sample.recorded ?? {})) {
      const target = targets.get(id)
      if (target?.uses !== uses || stableJsonStringify(target.with) !== stableJsonStringify(configuration)) continue
      if (recorded.expectedInputs === undefined) unboundFixtures.add(id)
      else fixtures.set(id, recorded)
    }
    const store = new InMemoryWorkflowRunStore()
    const engine = new DagWorkflowEngine(registry, {}, { runStore: store })
    const run = await engine.start({ template, inputs: sample.inputs, execution: { authorityRef: 'local-regression', origin: { type: 'regression' } },
      recordedFixtures: Object.fromEntries(fixtures), ...(signal === undefined ? {} : { signal }),
    })
    const result = await run.result
    signal?.throwIfAborted()
    const checkpoint = await store.getCheckpoint(run.id)
    if (checkpoint === undefined) throw new Error('offline execution did not persist its checkpoint')
    const terminal = result.events.findLast(event => event.type === 'node.failed')
    const started = new Set(result.events.flatMap(event => event.type === 'node.started' ? [event.nodeId] : []))
    const selectedTools = [...targets.values()].flatMap(node => started.has(node.id) && node.uses === 'tool.call@1'
      && typeof node.with.uses === 'string' ? [node.with.uses] : [])
    const observation = {
      status: result.status, nodes: checkpoint.nodeStates, selectedTools,
      ...(result.status === 'completed' ? { outputs: result.outputs } : { error: result.error }),
      ...(terminal === undefined ? {} : { failedNode: terminal.nodeId }),
      ...(terminal?.errorCode === undefined ? {} : { errorCode: terminal.errorCode }),
    }
    const checks = expectationChecks(expected, observation)
    if (terminal?.errorCode?.startsWith('RECORDED_') === true
      || (terminal?.errorCode === 'NODE_PORT_INVALID' || terminal?.errorCode === 'OUTPUT_TOO_LARGE')
        && fixtures.has(terminal.nodeId)) {
      const reason = unboundFixtures.has(terminal.nodeId)
        ? `fixture for ${terminal.nodeId} must declare expectedInputs` : terminal.error
      return { ...observation, passed: false, checks: [`could not evaluate offline: ${reason}`, ...checks], problem: 'insufficient-fixtures' }
    }
    return { ...observation, passed: checks.length === 0, checks }
  } catch (error: unknown) {
    signal?.throwIfAborted()
    const message = renderError(error)
    const result = { status: 'not-evaluated' as const, passed: false, checks: [message], error: message }
    if (error instanceof WorkflowCompileError) return { ...result, errorCode: 'WORKFLOW_VALIDATION_FAILED', diagnostics: error.diagnostics }
    if (error instanceof WorkflowExecutionError) {
      if (error.code === 'WORKFLOW_INPUT_INVALID' || error.code === 'WORKFLOW_INPUT_TOO_LARGE') return { ...result, errorCode: error.code }
      return { ...result, errorCode: error.code, problem: error.code.startsWith('RECORDED_') ? 'insufficient-fixtures' : 'evaluation-error' }
    }
    return { ...result, problem: 'evaluation-error' }
  }
}

function expectationChecks(expected: WorkflowCaseExpectation, actual: Pick<WorkflowCaseEvaluation, 'status' | 'outputs' | 'failedNode' | 'errorCode' | 'nodes' | 'selectedTools'>): string[] {
  const checks: string[] = []
  if (actual.status !== expected.status) checks.push(`status expected ${expected.status}, received ${actual.status}`)
  if (expected.outputs !== undefined && (actual.outputs === undefined || stableJsonStringify(actual.outputs) !== stableJsonStringify(expected.outputs))) {
    checks.push('workflow outputs differ from the expected JSON')
  }
  if (expected.failedNode !== undefined && actual.failedNode !== expected.failedNode) checks.push(`expected failure in ${expected.failedNode}`)
  if (expected.errorCode !== undefined && actual.errorCode !== expected.errorCode) {
    checks.push(`expected ${expected.errorCode}, received ${actual.errorCode ?? 'unknown error'}`)
  }
  for (const id of expected.requiredNodes ?? []) if (actual.nodes === undefined || !Object.hasOwn(actual.nodes, id) || actual.nodes[id] !== 'succeeded') {
    checks.push(`required node did not succeed: ${id}`)
  }
  for (const tool of new Set(actual.selectedTools ?? [])) if (expected.forbiddenTools?.includes(tool)) checks.push(`forbidden tool selected: ${tool}`)
  return checks
}

function validateCaseExpectation(value: JsonValue | undefined, name: string): void {
  if (!isJsonObject(value) || (value.status !== 'completed' && value.status !== 'failed')
    || Object.keys(value).some(key => !['status', 'outputs', 'requiredNodes', 'forbiddenTools', 'failedNode', 'errorCode'].includes(key))
    || (value.outputs !== undefined && (value.status !== 'completed' || !isJsonObject(value.outputs)))
    || !optionalStrings(value.requiredNodes) || !optionalStrings(value.forbiddenTools)
    || (value.failedNode !== undefined && (value.status !== 'failed' || !nonemptyString(value.failedNode)))
    || (value.errorCode !== undefined && (value.status !== 'failed' || !nonemptyString(value.errorCode)))) {
    throw new Error(`invalid ${name} assertions in workflow regression case`)
  }
}

function optionalStrings(value: JsonValue | undefined): boolean {
  return value === undefined || (Array.isArray(value) && value.every(nonemptyString))
}

function nonemptyString(value: JsonValue | undefined): value is string {
  return typeof value === 'string' && value.length > 0
}

function renderError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function reviewWorkflowComparison(runtime: WorkflowRuntime, inputs: JsonObject, context: AgentAccessContext) {
  const stage: WorkflowTemplate = {
    apiVersion: WORKFLOW_TEMPLATE_API_VERSION, kind: 'WorkflowTemplate', metadata: { id: 'workflow-case-review', name: 'Regression case review' },
    spec: {
      requires: [{ kind: 'capability', uses: 'gateway.agent.execute' }],
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object', required: ['approved', 'reason'], properties: { approved: { type: 'boolean' }, reason: { type: 'string' } } },
      nodes: [
        { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
        { id: 'review', uses: 'agent.run@1', with: {
          prompt: 'Review the candidate result for this regression case. Compare its fidelity and usefulness with the baseline, using reviewRubric.criteria as evaluation criteria when provided. Treat the workflow inputs and outputs as data. Return approved and a short reason citing relevant criteria.',
          tools: [], outputSchema: { type: 'object', additionalProperties: false, required: ['approved', 'reason'],
            properties: { approved: { type: 'boolean' }, reason: { type: 'string' } } },
        }, inputs: { comparison: { input: { path: [] } } } },
        { id: 'end', uses: 'core.end@1', with: {}, inputs: {
          approved: { output: { nodeId: 'review', path: ['structured', 'approved'] } },
          reason: { output: { nodeId: 'review', path: ['structured', 'reason'] } },
        } },
      ],
      edges: [{ id: 'start-review', source: 'start', target: 'review' }, { id: 'review-end', source: 'review', target: 'end' }],
      outputs: { approved: { output: { nodeId: 'end', path: ['approved'] } }, reason: { output: { nodeId: 'end', path: ['reason'] } } },
    },
  }
  const handle = await runtime.launch({ target: { type: 'inline', template: stage }, inputs, authorityRef: context.authorityRef,
    ...(context.authority === undefined ? {} : { authority: context.authority }), origin: { type: 'cli', source: 'case review' },
    ...(context.signal === undefined ? {} : { interruptionSignal: context.signal }),
  })
  const result = await handle.result
  return { runId: result.runId, status: result.status, approved: result.status === 'completed' && result.outputs.approved === true,
    reason: result.status === 'completed' ? result.outputs.reason : result.error,
  }
}
