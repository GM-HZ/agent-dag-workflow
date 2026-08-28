import { describe, expect, it, vi } from 'vitest'
import {
  createDshToolGateway,
  DagWorkflowEngine,
  registerCoreNodes,
  WorkflowCapabilityRegistry,
  WorkflowNodeRegistry,
  type DshToolExecutionInput,
  type WorkflowToolRequest,
  type WorkflowTemplate,
} from '../../src/core/index.js'
import { branchingWorkflowTemplate, toolWorkflowTemplate } from './fixtures.js'

describe('DAG workflow engine', () => {
  it('executes tool nodes only through the injected gateway', async () => {
    const registry = new WorkflowNodeRegistry()
    registerCoreNodes(registry)
    const execute = vi.fn(async (request: WorkflowToolRequest) => ({ echo: request.input.message ?? null }))
    const engine = new DagWorkflowEngine(registry, { tools: { execute } })

    const result = await engine.start({ template: toolWorkflowTemplate(), inputs: { message: 'hello' } }).result

    expect(result.status).toBe('completed')
    if (result.status !== 'completed') throw new Error(result.error)
    expect(result.outputs).toEqual({ answer: 'hello' })
    expect(execute).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ name: 'echo', nodeId: 'call', input: { message: 'hello' } }))
    expect(result.events.map(event => event.seq)).toEqual(result.events.map((_, index) => index + 1))
  })

  it('settles untaken branches as skipped before running a join', async () => {
    const registry = new WorkflowNodeRegistry()
    registerCoreNodes(registry)
    const calls: string[] = []
    const engine = new DagWorkflowEngine(registry, {
      tools: {
        async execute(request) {
          calls.push(request.name)
          return request.input.value ?? null
        },
      },
    })

    const result = await engine.start({ template: branchingWorkflowTemplate(), inputs: { enabled: true } }).result

    expect(result.status).toBe('completed')
    if (result.status !== 'completed') throw new Error(result.error)
    expect(result.outputs).toEqual({ answer: 'selected' })
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

    const result = await engine.start({ template: toolWorkflowTemplate(), inputs: { message: 'hello' } }).result

    expect(result).toMatchObject({ status: 'failed', error: 'policy denied' })
    expect(result.nodeStates.call).toBe('failed')
    expect(result.events).toContainEqual(expect.objectContaining({ type: 'node.failed', nodeId: 'call' }))
  })

  it('adapts the public ctx.tools.execute result contract', async () => {
    const execute = vi.fn(async (input: DshToolExecutionInput) => ({ isError: false as const, value: { received: input.arguments } }))
    const gateway = createDshToolGateway(execute)
    const signal = new AbortController().signal

    await expect(gateway.execute({ runId: 'run-1', nodeId: 'node-1', name: 'search', input: { q: 'dsh' }, signal }))
      .resolves.toEqual({ received: { q: 'dsh' } })
    expect(execute).toHaveBeenCalledWith({ callId: 'run-1:node-1', name: 'search', arguments: { q: 'dsh' }, signal })
  })

  it('keeps resolved secrets transient and rejects node outputs that leak them', async () => {
    const registry = new WorkflowNodeRegistry()
    registerCoreNodes(registry)
    const base = toolWorkflowTemplate()
    const template = {
      ...base,
      spec: {
        ...base.spec,
        requires: [
          ...(base.spec.requires ?? []),
          { kind: 'capability', uses: 'workflow.secrets.resolve' },
          { kind: 'secret', uses: 'credential:test' },
        ],
        nodes: base.spec.nodes.map(node => node.id === 'call'
          ? { ...node, inputs: { message: { secret: { ref: 'credential:test' } } } }
          : node),
      },
    } as WorkflowTemplate
    const engine = new DagWorkflowEngine(registry, {
      secrets: { async resolve() { return 'top-secret-value' } },
      tools: { async execute(request) { return { echoed: request.input.message ?? null } } },
    })

    const result = await engine.start({ template, inputs: { message: 'unused' } }).result

    expect(result).toMatchObject({ status: 'failed', error: 'node output contains a resolved secret value and cannot be persisted' })
    expect(JSON.stringify(result)).not.toContain('top-secret-value')
  })

  it('executes deterministic script nodes as standardized JSON transforms', async () => {
    const registry = new WorkflowNodeRegistry()
    registerCoreNodes(registry)
    const template: WorkflowTemplate = {
      apiVersion: 'dsh.workflow/v1alpha1',
      kind: 'WorkflowTemplate',
      metadata: { id: 'script-transform', name: 'Script transform' },
      spec: {
        requires: [
          { kind: 'capability', uses: 'workflow.script.execute' },
          { kind: 'script-runtime', uses: 'dsh.expr@1' },
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
              language: 'dsh.expr@1',
              source: '{ message: format("Hello {{ name }}", input), total: sum(input.scores) }',
            },
            inputs: { name: { input: 'name' }, scores: { input: 'scores' } },
          },
          {
            id: 'end', uses: 'core.end@1', with: {}, inputs: {
              message: { output: { node: 'transform', path: ['message'] } },
              total: { output: { node: 'transform', path: ['total'] } },
            },
          },
        ],
        edges: [
          { id: 'start-transform', source: 'start', target: 'transform' },
          { id: 'transform-end', source: 'transform', target: 'end' },
        ],
        outputs: {
          message: { output: { node: 'end', path: ['message'] } },
          total: { output: { node: 'end', path: ['total'] } },
        },
      },
    }

    const result = await new DagWorkflowEngine(registry).start({ template, inputs: { name: 'Lin', scores: [2, 3, 5] } }).result

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

    const result = await engine.start({ template, inputs: { message: 'hello' } }).result

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
      outputPorts: ['success'], capabilities: [], retry: 'safe',
      async execute(context) { return { outputs: { isolated: context.services.tools === undefined } } },
    })
    const template: WorkflowTemplate = {
      apiVersion: 'dsh.workflow/v1alpha1', kind: 'WorkflowTemplate',
      metadata: { id: 'service-isolation', name: 'Service isolation' },
      spec: {
        inputSchema: { type: 'object', additionalProperties: false },
        outputSchema: { type: 'object', additionalProperties: false, required: ['isolated'], properties: { isolated: { type: 'boolean' } } },
        nodes: [
          { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
          { id: 'isolated', uses: 'test.isolated@1', with: {}, inputs: {} },
          { id: 'end', uses: 'core.end@1', with: {}, inputs: { isolated: { output: { node: 'isolated', path: ['isolated'] } } } },
        ],
        edges: [
          { id: 'start-isolated', source: 'start', target: 'isolated' },
          { id: 'isolated-end', source: 'isolated', target: 'end' },
        ],
        outputs: { isolated: { output: { node: 'end', path: ['isolated'] } } },
      },
    }
    const engine = new DagWorkflowEngine(registry, { tools: { async execute() { return null } } })

    await expect(engine.start({ template, inputs: {} }).result).resolves.toMatchObject({
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
      apiVersion: 'dsh.workflow/v1alpha1', kind: 'WorkflowTemplate',
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
          { id: 'job', uses: 'acme.durable-job@1', with: { queue: 'critical' }, inputs: { value: { literal: 'payload' } } },
          { id: 'end', uses: 'core.end@1', with: {}, inputs: { result: { output: { node: 'job', path: ['result'] } } } },
        ],
        edges: [
          { id: 'start-job', source: 'start', target: 'job' },
          { id: 'job-end', source: 'job', target: 'end' },
        ],
        outputs: { result: { output: { node: 'end', path: ['result'] } } },
      },
    }
    const capabilities = new WorkflowCapabilityRegistry()
    capabilities.register('acme.jobs.execute', {
      async run(queue: string, value: string) { return `${queue}:${value}` },
    })

    await expect(new DagWorkflowEngine(registry, { capabilities }).start({ template, inputs: {} }).result)
      .resolves.toMatchObject({ status: 'completed', outputs: { result: 'critical:payload' } })
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

    const result = await engine.start({ template, inputs: { message: 'hello' } }).result

    expect(result).toMatchObject({ status: 'failed', error: expect.stringContaining('limit is 16') })
    expect(result.nodeStates.call).toBe('failed')
  })
})
