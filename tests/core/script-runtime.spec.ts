import { describe, expect, it } from 'vitest'
import {
  createScriptNodeDefinition,
  createScopedWorkflowCapabilityResolver,
  scriptRuntimeKey,
  WorkflowNodeRegistry,
  WorkflowScriptRuntimeRegistry,
} from '../../src/core/index.js'

describe('workflow script runtime registry', () => {
  it('registers versioned deterministic runtimes and disposes them idempotently', () => {
    const registry = new WorkflowScriptRuntimeRegistry()
    const runtime = {
      language: 'acme.rules',
      version: 2,
      title: 'Acme rules',
      description: 'Test-only pure transform.',
      deterministic: true as const,
      validate: () => [],
      async execute() { return { accepted: true } },
    }

    const dispose = registry.register(runtime)
    expect(scriptRuntimeKey(runtime.language, runtime.version)).toBe('acme.rules@2')
    expect(registry.resolve('acme.rules@2')).toBe(runtime)
    expect(registry.list()).toEqual([runtime])

    dispose()
    dispose()
    expect(registry.resolve('acme.rules@2')).toBeUndefined()
  })

  it('rejects runtimes that do not declare deterministic execution', () => {
    const registry = new WorkflowScriptRuntimeRegistry()

    expect(() => registry.register({
      language: 'acme.unsafe',
      version: 1,
      title: 'Unsafe',
      description: 'Invalid test runtime.',
      deterministic: false as true,
      validate: () => [],
      async execute() { return {} },
    })).toThrow('must declare deterministic')
  })

  it('lets a node plugin target a custom runtime without changing the DAG engine', async () => {
    const scripts = new WorkflowScriptRuntimeRegistry()
    scripts.register({
      language: 'acme.rules',
      version: 1,
      title: 'Acme rules',
      description: 'Test-only pure transform.',
      deterministic: true,
      validate: source => source === 'accept' ? [] : ['unknown rule'],
      async execute(request) {
        return { accepted: request.source === 'accept', payload: request.inputs }
      },
    })
    const definition = createScriptNodeDefinition(scripts)
    const nodes = new WorkflowNodeRegistry()
    nodes.register(definition)

    expect(definition.validateConfig?.({ language: 'acme.rules@1', source: 'accept' })).toEqual([])
    await expect(definition.execute({
      runId: 'run-1',
      nodeId: 'rules',
      config: { language: 'acme.rules@1', source: 'accept' },
      inputs: { orderId: 'order-1' },
      workflowInputs: {},
      signal: new AbortController().signal,
      capabilities: createScopedWorkflowCapabilityResolver(undefined, ['workflow.script.execute'], 'rules'),
      services: {},
      requirements: [
        { kind: 'capability', uses: 'workflow.script.execute' },
        { kind: 'script-runtime', uses: 'acme.rules@1' },
      ],
      depth: 0,
      subworkflowMaxDepth: 8,
      checkpointProgress() {},
    })).resolves.toEqual({
      outputs: { accepted: true, payload: { orderId: 'order-1' } },
    })
  })
})
