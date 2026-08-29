import { describe, expect, it } from 'vitest'
import {
  compileWorkflow,
  DagWorkflowEngine,
  InMemoryWorkflowRunStore,
  registerCoreNodes,
  WorkflowNodeRegistry,
  type WorkflowEdgeTemplate,
  type WorkflowNodeTemplate,
  type WorkflowTemplate,
} from '../../src/core/index.js'

const execution = { authorityRef: 'verify:dag', authority: { test: true }, origin: { type: 'sdk', source: 'verification' } } as const

interface GeneratedDag {
  readonly seed: number
  readonly template: WorkflowTemplate
  readonly inputs: Readonly<Record<string, boolean>>
  readonly expected: boolean
  readonly selected: readonly string[]
  readonly skipped: readonly string[]
  readonly unsafeSource: string
}

describe('generated DAG properties', () => {
  it('keeps compiled branch data available and rejects branch-local leakage for every seed', async () => {
    const cases = verificationCases()
    const baseSeed = verificationSeed()
    const registry = verificationRegistry()
    for (let index = 0; index < cases; index++) {
      const generated = generateDag((baseSeed + index) >>> 0)
      const compiled = compileWorkflow(generated.template, registry)
      expect(compiled.diagnostics, failure(generated, compiled.diagnostics)).toEqual([])

      const unsafe = withUnsafeEndBinding(generated.template, generated.unsafeSource)
      expect(compileWorkflow(unsafe, registry).diagnostics, failure(generated, 'unsafe binding was accepted'))
        .toContainEqual(expect.objectContaining({ code: 'BINDING_SOURCE_NOT_GUARANTEED', nodeId: 'end' }))

      const store = new InMemoryWorkflowRunStore()
      const run = await new DagWorkflowEngine(registry, {}, { runStore: store }).start({
        runId: `generated-${generated.seed}`,
        execution,
        template: generated.template,
        inputs: generated.inputs,
      })
      const result = await run.result
      expect(result, failure(generated, result)).toMatchObject({
        status: 'completed',
        outputs: { answer: generated.expected, global: `global-${generated.seed}` },
      })
      for (const nodeId of generated.selected) expect(result.nodeStates[nodeId], failure(generated, nodeId)).toBe('succeeded')
      for (const nodeId of generated.skipped) expect(result.nodeStates[nodeId], failure(generated, nodeId)).toBe('skipped')
      expect(result.nodeStates.end, failure(generated, 'end')).toBe('succeeded')
      expect(result.nodeStates.global, failure(generated, 'global')).toBe('succeeded')
      expect(result.events.map(event => event.seq)).toEqual(result.events.map((_, eventIndex) => eventIndex + 1))

      const record = await store.loadRun(run.id)
      expect(record?.checkpoint, failure(generated, record?.checkpoint)).toMatchObject({
        status: 'completed',
        seq: record?.events.length,
        resultOutputs: { answer: generated.expected, global: `global-${generated.seed}` },
      })
    }
  }, 600_000)
})

function verificationRegistry(): WorkflowNodeRegistry {
  const registry = new WorkflowNodeRegistry()
  registerCoreNodes(registry)
  registry.register({
    type: 'verify.step', version: 1, title: 'Verification step', description: 'Pure generated-DAG step.',
    configSchema: { type: 'object', additionalProperties: false },
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['value'], properties: { value: {} },
    },
    outputSchema: {
      type: 'object', additionalProperties: false, required: ['value'], properties: { value: {} },
    },
    outputPorts: ['success'], capabilities: [], retry: 'safe', implementationDigest: 'verification-step-v1',
    async execute(context) {
      const value = context.inputs.value
      if (value === undefined) throw new Error('generated verification step is missing value')
      return { outputs: { value } }
    },
  })
  return registry
}

function generateDag(seed: number): GeneratedDag {
  const random = mulberry32(seed)
  const stageCount = 1 + integer(random, 6)
  const nodes: WorkflowNodeTemplate[] = [
    { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
    { id: 'global', uses: 'verify.step@1', with: {}, inputs: { value: { literal: `global-${seed}` } } },
  ]
  const edges: WorkflowEdgeTemplate[] = [
    { id: 'start-global', source: 'start', target: 'global' },
  ]
  const inputs: Record<string, boolean> = {}
  const selected: string[] = []
  const skipped: string[] = []
  let previous = 'start'
  let lastCondition = ''
  let unsafeSource = ''

  for (let stage = 0; stage < stageCount; stage++) {
    const flag = `flag_${stage}`
    const condition = `condition_${stage}`
    const join = `join_${stage}`
    const enabled = random() >= 0.5
    inputs[flag] = enabled
    lastCondition = condition
    nodes.push({
      id: condition, uses: 'core.condition@1', with: { operator: 'truthy' },
      inputs: { left: { input: { path: [flag] } } },
    })
    edges.push({ id: `${previous}-${condition}`, source: previous, target: condition })

    const branchEnds: string[] = []
    for (const branch of ['true', 'false'] as const) {
      const length = 1 + integer(random, 3)
      let branchPrevious = condition
      const branchNodes: string[] = []
      for (let position = 0; position < length; position++) {
        const nodeId = `${branch}_${stage}_${position}`
        branchNodes.push(nodeId)
        nodes.push({
          id: nodeId, uses: 'verify.step@1', with: {},
          inputs: position === 0
            ? { value: { output: { nodeId: condition, path: ['result'] } } }
            : { value: { output: { nodeId: branchPrevious, path: ['value'] } } },
        })
        edges.push({
          id: `${branchPrevious}-${nodeId}`,
          source: branchPrevious,
          target: nodeId,
          ...(position === 0 ? { sourcePort: branch } : {}),
        })
        branchPrevious = nodeId
      }
      branchEnds.push(branchPrevious)
      const isSelected = enabled === (branch === 'true')
      const branchState = isSelected ? selected : skipped
      branchState.push(...branchNodes)
      if (branch === 'true' && stage === stageCount - 1) unsafeSource = branchPrevious
    }
    nodes.push({ id: join, uses: 'verify.step@1', with: {}, inputs: { value: { literal: `stage-${stage}` } } })
    edges.push(
      { id: `${branchEnds[0]}-${join}`, source: branchEnds[0]!, target: join },
      { id: `${branchEnds[1]}-${join}`, source: branchEnds[1]!, target: join },
    )
    selected.push(join)
    previous = join
  }

  nodes.push({
    id: 'end', uses: 'core.end@1', with: {},
    inputs: {
      answer: { output: { nodeId: lastCondition, path: ['result'] } },
      global: { output: { nodeId: 'global', path: ['value'] } },
    },
  })
  edges.push(
    { id: `${previous}-end`, source: previous, target: 'end' },
    { id: 'global-end', source: 'global', target: 'end' },
  )

  const template: WorkflowTemplate = {
    apiVersion: 'workflow.gm-hz.dev/v1alpha1', kind: 'WorkflowTemplate',
    metadata: { id: `generated-${seed}`, name: `Generated ${seed}` },
    spec: {
      inputSchema: {
        type: 'object', additionalProperties: false, required: Object.keys(inputs),
        properties: Object.fromEntries(Object.keys(inputs).map(name => [name, { type: 'boolean' }])),
      },
      outputSchema: {
        type: 'object', additionalProperties: false, required: ['answer', 'global'],
        properties: { answer: { type: 'boolean' }, global: { type: 'string' } },
      },
      nodes,
      edges,
      outputs: {
        answer: { output: { nodeId: 'end', path: ['answer'] } },
        global: { output: { nodeId: 'end', path: ['global'] } },
      },
    },
  }
  return { seed, template, inputs, expected: inputs[`flag_${stageCount - 1}`]!, selected, skipped, unsafeSource }
}

function withUnsafeEndBinding(template: WorkflowTemplate, sourceNodeId: string): WorkflowTemplate {
  return {
    ...template,
    spec: {
      ...template.spec,
      nodes: template.spec.nodes.map(node => node.id === 'end'
        ? { ...node, inputs: { ...node.inputs, answer: { output: { nodeId: sourceNodeId, path: ['value'] } } } }
        : node),
    },
  }
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

function integer(random: () => number, exclusiveMaximum: number): number {
  return Math.floor(random() * exclusiveMaximum)
}

function verificationCases(): number {
  return boundedEnvironmentInteger('WORKFLOW_VERIFY_CASES', 64, 1, 10_000)
}

function verificationSeed(): number {
  return boundedEnvironmentInteger('WORKFLOW_VERIFY_SEED', 20_260_829, 0, 0xFFFF_FFFF)
}

function boundedEnvironmentInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const authored = process.env[name]
  if (authored === undefined) return fallback
  const value = Number(authored)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return value
}

function failure(generated: GeneratedDag, detail: unknown): string {
  return `generated DAG invariant failed; reproduce with WORKFLOW_VERIFY_CASES=1 WORKFLOW_VERIFY_SEED=${generated.seed} pnpm verify:core\n${JSON.stringify(detail, null, 2)}`
}
