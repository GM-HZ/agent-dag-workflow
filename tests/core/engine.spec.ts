import { describe, expect, it, vi } from 'vitest'
import {
  DagWorkflowEngine,
  InMemoryWorkflowRunStore,
  parseWorkflowTemplate,
  registerCoreNodes,
  WORKFLOW_TEMPLATE_API_VERSION,
  WorkflowCapabilityRegistry,
  WorkflowExecutionError,
  WorkflowNodeRegistry,
  type WorkflowHostEvidenceReporter,
  type WorkflowHostInvocationEvidence,
  type WorkflowToolRequest,
  type WorkflowTemplate,
} from '../../src/core/index.js'
import { branchingWorkflowTemplate, toolWorkflowTemplate } from './fixtures.js'

const testExecution = { authorityRef: 'test:user', authority: { id: 'test-user' }, origin: { type: 'sdk' } } as const

describe('DAG workflow engine', () => {
  it('freezes the public v1 template envelope and rejects pre-v1 input', () => {
    expect(WORKFLOW_TEMPLATE_API_VERSION).toBe('workflow.gm-hz.dev/v1')
    const unsupported = { ...toolWorkflowTemplate(), apiVersion: 'workflow.gm-hz.dev/v1alpha1' }
    expect(() => parseWorkflowTemplate(JSON.stringify(unsupported))).toThrow(/apiVersion/)
  })

  it('executes tool nodes only through the injected gateway', async () => {
    const registry = new WorkflowNodeRegistry()
    registerCoreNodes(registry)
    const execute = vi.fn(async (request: WorkflowToolRequest) => ({ echo: request.inputs.message ?? null }))
    const engine = new DagWorkflowEngine(registry, { tools: { execute } })

    const result = await (await engine.start({ execution: testExecution, template: toolWorkflowTemplate(), inputs: { message: 'hello' } })).result

    if (result.status !== 'completed') throw new Error(result.error)
    expect(result.status).toBe('completed')
    expect(result.outputs).toEqual({ answer: 'hello' })
    expect(execute).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ uses: 'echo', nodeId: 'call', inputs: { message: 'hello' }, authority: testExecution.authority }))
    expect(result.events.map(event => event.seq)).toEqual(result.events.map((_, index) => index + 1))
    expect(result.events.find(event => event.type === 'capability.completed')?.hostEvidence).toBeUndefined()
  })

  it('journals only validated Tool provenance and preserves the Tool result shape', async () => {
    const registry = new WorkflowNodeRegistry()
    registerCoreNodes(registry)
    const store = new InMemoryWorkflowRunStore()
    let report: WorkflowHostEvidenceReporter | undefined
    let accessorReads = 0
    const privateValue = 'test-provider-private-marker'
    const engine = new DagWorkflowEngine(registry, {
      tools: {
        async execute(request) {
          report = request.reportEvidence
          expect(report).toBeDefined()
          expect(report!({
            toolVersion: 'echo@2.0.0-rc.1', traceId: 'ABCD'.repeat(8), spanId: '1234'.repeat(4),
            durationMs: 12.5, usage: { inputTokens: 4, cacheReadTokens: 1 },
          })).toBe(true)
          const usage = { outputTokens: 3, totalTokens: 7 }
          expect(report!({ usage })).toBe(true)
          usage.outputTokens = 100
          expect(report!({ toolVersion: 'unrelated@9', usage: { totalTokens: 200 } })).toBe(false)
          expect(report!({ modelId: 'trusted/model-v2', credentials: privateValue } as WorkflowHostInvocationEvidence)).toBe(false)
          expect(report!({ usage: { inputTokens: 999_999_999_999 } })).toBe(false)
          expect(report!({ usage: { inputTokens: 4, prompt: privateValue } } as WorkflowHostInvocationEvidence)).toBe(false)
          expect(report!({ traceId: '0'.repeat(32) })).toBe(false)
          expect(report!(Object.defineProperty({}, 'modelId', {
            enumerable: true,
            get() { accessorReads++; return privateValue },
          }))).toBe(false)
          return { echo: request.inputs.message ?? null }
        },
      },
    }, { runStore: store })
    const run = await engine.start({ execution: testExecution, template: toolWorkflowTemplate(), inputs: { message: 'hello' } })
    expect(await run.result).toMatchObject({ status: 'completed', outputs: { answer: 'hello' } })
    expect(report!({ modelId: 'too-late' })).toBe(false)
    expect(accessorReads).toBe(0)
    const record = await store.loadRun(run.id)
    const completed = record?.events.find(event => event.type === 'capability.completed')
    const evidence = {
      toolVersion: 'echo@2.0.0-rc.1', traceId: 'abcd'.repeat(8), spanId: '1234'.repeat(4), durationMs: 12.5,
      usage: { inputTokens: 4, cacheReadTokens: 1, outputTokens: 3, totalTokens: 7 },
    }
    expect(completed?.hostEvidence).toEqual(evidence)
    expect(completed?.payload.hostEvidence).toEqual(evidence)
    expect(record?.checkpoint.nodeOutputs.call).toEqual({ result: { echo: 'hello' } })
    expect(JSON.stringify(record)).not.toContain(privateValue)
  })

  it('retains Agent child provenance when the invocation fails', async () => {
    const registry = new WorkflowNodeRegistry()
    registerCoreNodes(registry)
    const engine = new DagWorkflowEngine(registry, {
      agents: {
        async execute(request) {
          expect(request.reportEvidence?.({ childRunId: 'dsh-agent:child-1', modelId: 'provider/model-v2', usage: { outputTokens: 17 } })).toBe(true)
          throw new WorkflowExecutionError('FIXTURE_AGENT_FAILED', 'agent execution interrupted')
        },
      },
    })
    const base = toolWorkflowTemplate()
    const template: WorkflowTemplate = {
      ...base,
      spec: {
        ...base.spec,
        requires: [{ kind: 'capability', uses: 'gateway.agent.execute' }],
        nodes: base.spec.nodes.map(node => node.id === 'call'
          ? { ...node, uses: 'agent.run@1', with: { prompt: 'Summarize the sample.' } }
          : node.id === 'end' ? { ...node, inputs: { answer: { literal: 'done' } } } : node),
      },
    }
    const run = await engine.start({ execution: testExecution, template, inputs: { message: 'sample' } })
    const result = await run.result
    expect(result).toMatchObject({ status: 'failed', error: 'agent execution interrupted' })
    const failure = result.events.find(event => event.type === 'capability.failed')
    const evidence = { childRunId: 'dsh-agent:child-1', modelId: 'provider/model-v2', usage: { outputTokens: 17 } }
    expect(failure).toMatchObject({ nodeId: 'call', invocationId: `${run.id}:call`, hostEvidence: evidence })
    expect(failure?.payload.hostEvidence).toEqual(evidence)
  })

  it('settles untaken branches as skipped before running a join', async () => {
    const registry = new WorkflowNodeRegistry()
    registerCoreNodes(registry)
    const calls: string[] = []
    const engine = new DagWorkflowEngine(registry, {
      tools: {
        async execute(request) {
          calls.push(request.uses)
          return request.inputs.value ?? null
        },
      },
    })

    const result = await (await engine.start({ execution: testExecution, template: branchingWorkflowTemplate(), inputs: { enabled: true } })).result

    expect(result.status).toBe('completed')
    if (result.status !== 'completed') throw new Error(result.error)
    expect(result.outputs).toEqual({ answer: true })
    expect(calls).toEqual(['enabled-tool'])
    expect(result.nodeStates.disabled).toBe('skipped')
    expect(result.edgeStates['choose-enabled']).toBe('taken')
    expect(result.edgeStates['choose-disabled']).toBe('skipped')
    expect(result.edgeStates['disabled-end']).toBe('skipped')
  })

  it('resolves tool failures into a failed run result instead of rejecting', async () => {
    const registry = new WorkflowNodeRegistry()
    registerCoreNodes(registry)
    const engine = new DagWorkflowEngine(registry, {
      tools: { async execute() { throw new Error('policy denied') } },
    })

    const result = await (await engine.start({ execution: testExecution, template: toolWorkflowTemplate(), inputs: { message: 'hello' } })).result

    expect(result).toMatchObject({ status: 'failed', error: 'policy denied' })
    expect(result.nodeStates.call).toBe('failed')
    expect(result.events).toContainEqual(expect.objectContaining({ type: 'node.failed', nodeId: 'call' }))
  })

  it('keeps the failed attempt audit when an automatic retry later succeeds', async () => {
    const registry = new WorkflowNodeRegistry()
    registerCoreNodes(registry)
    let attempts = 0
    let now = 1000
    registry.register({
      type: 'test.retry', version: 1, title: 'Retry fixture', description: 'Retry one deterministic transformation',
      configSchema: { type: 'object' }, inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
      outputPorts: ['success'], capabilities: [], effects: 'deterministic', retry: 'safe', implementationDigest: 'test-retry-v1',
      async execute() {
        if (++attempts === 1) {
          now += 18
          throw new WorkflowExecutionError('FIXTURE_TRANSIENT', 'temporary fixture failure')
        }
        now += 7
        return { outputs: { result: { echo: 'recovered' } } }
      },
    })
    const base = toolWorkflowTemplate()
    const template: WorkflowTemplate = {
      ...base,
      spec: {
        ...base.spec, requires: [],
        nodes: base.spec.nodes.map(node => node.id === 'call'
          ? { ...node, uses: 'test.retry@1', with: {}, policy: { retry: { maxAttempts: 2 } } }
          : node),
      },
    }
    const store = new InMemoryWorkflowRunStore()
    const engine = new DagWorkflowEngine(registry, {}, { runStore: store, now: () => now })
    const run = await engine.start({ execution: testExecution, template, inputs: { message: 'example' } })
    expect(await run.result).toMatchObject({ status: 'completed', outputs: { answer: 'recovered' } })
    const events = await store.readEvents(run.id)
    expect(events).toContainEqual(expect.objectContaining({
      type: 'node.retry-scheduled',
      node: expect.objectContaining({ id: 'call', attempt: 1 }),
      payload: {
        error: 'temporary fixture failure', errorCode: 'FIXTURE_TRANSIENT', durationMs: 18,
        nextAttempt: 2, retryMode: 'safe',
      },
    }))
    expect(events).toContainEqual(expect.objectContaining({
      type: 'node.completed',
      node: expect.objectContaining({ id: 'call', attempt: 2 }),
      payload: { durationMs: 7, selectedPorts: ['success'] },
    }))
  })

  it('executes approved offline fixtures only for matching inputs and never uses a live gateway as fallback', async () => {
    const registry = new WorkflowNodeRegistry()
    registerCoreNodes(registry)
    const execute = vi.fn(async () => ({ echo: 'live side effect' }))
    const engine = new DagWorkflowEngine(registry, { tools: { execute } })
    const request = { execution: testExecution, template: toolWorkflowTemplate(), inputs: { message: 'case' } }
    const fixture = { outputs: { result: { echo: 'recorded' } }, selectedPorts: ['success'], expectedInputs: { message: 'case' } }
    const matching = await engine.start({ ...request, recordedFixtures: { call: fixture } })
    expect(await matching.result).toMatchObject({ status: 'completed', outputs: { answer: 'recorded' } })
    const mismatching = await engine.start({ ...request, inputs: { message: 'changed' }, recordedFixtures: { call: fixture } })
    expect(await mismatching.result).toMatchObject({ status: 'failed', error: expect.stringContaining('recorded fixture inputs do not match node call') })
    const missing = await engine.start({ ...request, recordedFixtures: {} })
    expect(await missing.result).toMatchObject({ status: 'failed', error: expect.stringContaining('no committed outputs for call') })
    const recordedFailure = await engine.start({
      ...request,
      recordedFixtures: { call: { failure: { code: 'FIXTURE_FAILURE', message: 'recorded upstream failure' }, expectedInputs: { message: 'case' } } },
    })
    const failure = await recordedFailure.result
    expect(failure).toMatchObject({ status: 'failed', error: 'recorded upstream failure' })
    expect(failure.events).toContainEqual(expect.objectContaining({ type: 'node.failed', nodeId: 'call', errorCode: 'FIXTURE_FAILURE' }))
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects generic secret bindings before compilation', () => {
    const base = toolWorkflowTemplate()
    const template = {
      ...base,
      spec: {
        ...base.spec,
        nodes: base.spec.nodes.map(node => node.id === 'call'
          ? { ...node, inputs: { message: { secret: { ref: 'credential:test' } } } }
          : node),
      },
    }
    expect(() => parseWorkflowTemplate(JSON.stringify(template))).toThrow(/must match exactly one schema in oneOf/)
  })

  it('executes deterministic script nodes as standardized JSON transforms', async () => {
    const registry = new WorkflowNodeRegistry()
    registerCoreNodes(registry)
    const template: WorkflowTemplate = {
      apiVersion: 'workflow.gm-hz.dev/v1',
      kind: 'WorkflowTemplate',
      metadata: { id: 'script-transform', name: 'Script transform' },
      spec: {
        requires: [
          { kind: 'capability', uses: 'workflow.script.execute' },
          { kind: 'script-runtime', uses: 'json.expr@1' },
        ],
        inputSchema: {
          type: 'object', additionalProperties: false, required: ['name', 'scores'],
          properties: { name: { type: 'string' }, scores: { type: 'array', items: { type: 'number' } } },
        },
        outputSchema: {
          type: 'object', additionalProperties: false, required: ['message', 'total'],
          properties: { message: { type: 'string' }, total: { type: 'number' } },
        },
        nodes: [
          { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
          {
            id: 'transform', uses: 'core.script@1',
            with: {
              language: 'json.expr@1',
              source: '{ message: format("Hello {{ name }}", input), total: sum(input.scores) }',
            },
            inputs: { name: { input: { path: ['name'] } }, scores: { input: { path: ['scores'] } } },
          },
          {
            id: 'end', uses: 'core.end@1', with: {}, inputs: {
              message: { output: { nodeId: 'transform', path: ['message'] } },
              total: { output: { nodeId: 'transform', path: ['total'] } },
            },
          },
        ],
        edges: [
          { id: 'start-transform', source: 'start', target: 'transform' },
          { id: 'transform-end', source: 'transform', target: 'end' },
        ],
        outputs: {
          message: { output: { nodeId: 'end', path: ['message'] } },
          total: { output: { nodeId: 'end', path: ['total'] } },
        },
      },
    }

    const result = await (await new DagWorkflowEngine(registry).start({ execution: testExecution, template, inputs: { name: 'Lin', scores: [2, 3, 5] } })).result

    expect(result).toMatchObject({ status: 'completed', outputs: { message: 'Hello Lin', total: 10 } })
    expect(result.nodeStates.transform).toBe('succeeded')
  })

  it('validates a node instance expectation before checkpointing its output', async () => {
    const registry = new WorkflowNodeRegistry()
    registerCoreNodes(registry)
    const base = toolWorkflowTemplate()
    const template: WorkflowTemplate = {
      ...base,
      spec: {
        ...base.spec,
        nodes: base.spec.nodes.map(node => node.id === 'call' ? {
          ...node,
          expects: {
            schema: {
              type: 'object', additionalProperties: false, required: ['result'],
              properties: {
                result: {
                  type: 'object', additionalProperties: false, required: ['echo'],
                  properties: { echo: { type: 'string' } },
                },
              },
            },
            maxBytes: 1000,
          },
        } : node),
      },
    }
    const engine = new DagWorkflowEngine(registry, { tools: { async execute() { return { echo: 42 } } } })

    const result = await (await engine.start({ execution: testExecution, template, inputs: { message: 'hello' } })).result

    expect(result).toMatchObject({ status: 'failed', error: expect.stringContaining('must be string') })
    expect(result.nodeStates.call).toBe('failed')
  })

  it('only exposes gateways covered by the NodeDefinition capability declaration', async () => {
    const registry = new WorkflowNodeRegistry()
    registerCoreNodes(registry)
    registry.register({
      type: 'test.isolated', version: 1, title: 'Isolated', description: 'Isolation check.',
      configSchema: { type: 'object', additionalProperties: false },
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object', additionalProperties: false, required: ['isolated'], properties: { isolated: { type: 'boolean' } } },
      outputPorts: ['success'], capabilities: [], effects: 'deterministic', retry: 'safe',
      async execute(context) { return { outputs: { isolated: context.services.tools === undefined } } },
    })
    const template: WorkflowTemplate = {
      apiVersion: 'workflow.gm-hz.dev/v1', kind: 'WorkflowTemplate',
      metadata: { id: 'service-isolation', name: 'Service isolation' },
      spec: {
        inputSchema: { type: 'object', additionalProperties: false },
        outputSchema: { type: 'object', additionalProperties: false, required: ['isolated'], properties: { isolated: { type: 'boolean' } } },
        nodes: [
          { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
          { id: 'isolated', uses: 'test.isolated@1', with: {}, inputs: {} },
          { id: 'end', uses: 'core.end@1', with: {}, inputs: { isolated: { output: { nodeId: 'isolated', path: ['isolated'] } } } },
        ],
        edges: [
          { id: 'start-isolated', source: 'start', target: 'isolated' },
          { id: 'isolated-end', source: 'isolated', target: 'end' },
        ],
        outputs: { isolated: { output: { nodeId: 'end', path: ['isolated'] } } },
      },
    }
    const engine = new DagWorkflowEngine(registry, { tools: { async execute() { return null } } })

    await expect((await engine.start({ execution: testExecution, template, inputs: {} })).result).resolves.toMatchObject({
      status: 'completed', outputs: { isolated: true },
    })
  })

  it('executes a custom Node through a declared, scoped Host capability', async () => {
    const registry = new WorkflowNodeRegistry()
    registerCoreNodes(registry)
    registry.register({
      type: 'acme.durable-job', version: 1, title: 'Durable job', description: 'Custom workflow lifecycle.',
      configSchema: {
        type: 'object', additionalProperties: false, required: ['queue'],
        properties: { queue: { type: 'string' } },
      },
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['value'],
        properties: { value: { type: 'string' } },
      },
      outputSchema: {
        type: 'object', additionalProperties: false, required: ['result'],
        properties: { result: { type: 'string' } },
      },
      outputPorts: ['success'],
      capabilities: ['acme.jobs.execute'],
      effects: 'external',
      dependencyKinds: ['queue'],
      dependencies(config) {
        return typeof config.queue === 'string' ? [{ kind: 'queue', uses: config.queue }] : []
      },
      retry: 'idempotent',
      async execute(context) {
        const jobs = context.capabilities.require<{ run(queue: string, value: string): Promise<string> }>('acme.jobs.execute')
        return { outputs: { result: await jobs.run(String(context.config.queue), String(context.inputs.value)) } }
      },
    })
    const template: WorkflowTemplate = {
      apiVersion: 'workflow.gm-hz.dev/v1', kind: 'WorkflowTemplate',
      metadata: { id: 'custom-node', name: 'Custom node' },
      spec: {
        requires: [
          { kind: 'capability', uses: 'acme.jobs.execute' },
          { kind: 'queue', uses: 'critical' },
        ],
        inputSchema: { type: 'object', additionalProperties: false },
        outputSchema: {
          type: 'object', additionalProperties: false, required: ['result'],
          properties: { result: { type: 'string' } },
        },
        nodes: [
          { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
          { id: 'job', uses: 'acme.durable-job@1', with: { queue: 'critical' }, inputs: { value: { literal: 'payload' } }, policy: { retry: { maxAttempts: 2 } } },
          { id: 'end', uses: 'core.end@1', with: {}, inputs: { result: { output: { nodeId: 'job', path: ['result'] } } } },
        ],
        edges: [
          { id: 'start-job', source: 'start', target: 'job' },
          { id: 'job-end', source: 'job', target: 'end' },
        ],
        outputs: { result: { output: { nodeId: 'end', path: ['result'] } } },
      },
    }
    const capabilities = new WorkflowCapabilityRegistry()
    let calls = 0
    capabilities.register('acme.jobs.execute', {
      async run(queue: string, value: string) { if (++calls === 1) throw new Error('transient'); return `${queue}:${value}` },
    })

    await expect((await new DagWorkflowEngine(registry, { capabilities }).start({ execution: testExecution, template, inputs: {} })).result)
      .resolves.toMatchObject({ status: 'completed', outputs: { result: 'critical:payload' } })
    expect(calls).toBe(2)
  })

  it('applies a node-local expected output byte cap before persistence', async () => {
    const registry = new WorkflowNodeRegistry()
    registerCoreNodes(registry)
    const base = toolWorkflowTemplate()
    const template: WorkflowTemplate = {
      ...base,
      spec: {
        ...base.spec,
        nodes: base.spec.nodes.map(node => node.id === 'call'
          ? { ...node, expects: { schema: { type: 'object' }, maxBytes: 16 } }
          : node),
      },
    }
    const engine = new DagWorkflowEngine(registry, {
      tools: { async execute() { return { echo: 'this output is intentionally too large' } } },
    })

    const result = await (await engine.start({ execution: testExecution, template, inputs: { message: 'hello' } })).result

    expect(result).toMatchObject({ status: 'failed', error: expect.stringContaining('limit is 16') })
    expect(result.nodeStates.call).toBe('failed')
  })

  it('does not capture or journal an external result before deterministic validation', async () => {
    const registry = new WorkflowNodeRegistry()
    registerCoreNodes(registry)
    const base = toolWorkflowTemplate()
    const template: WorkflowTemplate = {
      ...base,
      spec: {
        ...base.spec,
        nodes: base.spec.nodes.map(node => node.id === 'call'
          ? {
              ...node,
              expects: {
                schema: {
                  type: 'object', additionalProperties: false, required: ['result'],
                  properties: { result: { type: 'string' } },
                },
              },
            }
          : node),
      },
    }
    const captures: { readonly phase: string; readonly nodeId?: string }[] = []
    const engine = new DagWorkflowEngine(
      registry,
      { tools: { async execute() { return { private: 'invalid dynamic data' } } } },
      { capture: { async capture(request) { captures.push({ phase: request.phase, ...(request.nodeId === undefined ? {} : { nodeId: request.nodeId }) }); return { dataHash: 'capture' } } } },
    )

    const result = await (await engine.start({ execution: testExecution, template, inputs: { message: 'hello' } })).result

    expect(result).toMatchObject({ status: 'failed', error: expect.stringContaining('must be string') })
    expect(captures).not.toContainEqual({ phase: 'capability.output', nodeId: 'call' })
    expect(captures).not.toContainEqual({ phase: 'node.output', nodeId: 'call' })
    expect(result.events).toContainEqual(expect.objectContaining({ type: 'capability.failed', nodeId: 'call' }))
    expect(result.events).not.toContainEqual(expect.objectContaining({ type: 'capability.completed', nodeId: 'call' }))
  })
})
