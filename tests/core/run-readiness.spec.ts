import { describe, expect, it, vi } from 'vitest'
import { InMemoryWorkflowCatalogRepository, WorkflowTemplateCatalog } from '../../src/catalog/index.js'
import { InMemoryWorkflowRunStore, registerCoreNodes, WorkflowNodeRegistry, type WorkflowNodeTemplate, type WorkflowTemplate } from '../../src/core/index.js'
import { WorkflowRuntime, type WorkflowRuntimeOptions } from '../../src/runtime/index.js'
import { branchingWorkflowTemplate, toolWorkflowTemplate } from './fixtures.js'

function setup(options: Pick<WorkflowRuntimeOptions, 'services' | 'deploymentLimits'> = {}, repository = new InMemoryWorkflowCatalogRepository()): WorkflowRuntime {
  const nodes = new WorkflowNodeRegistry()
  registerCoreNodes(nodes)
  return new WorkflowRuntime({
    nodes,
    catalog: new WorkflowTemplateCatalog(repository, nodes),
    runStore: new InMemoryWorkflowRunStore(),
    ...options,
  })
}

async function publish(runtime: WorkflowRuntime, template: WorkflowTemplate) {
  const draft = await runtime.createDraft(template)
  return runtime.publish(draft.id, draft.revision)
}

function call(target: string, id = 'invoke'): WorkflowNodeTemplate {
  return { id, uses: 'workflow.call@1', with: { templateId: target, revision: 1 }, inputs: { message: { literal: 'hello' } } }
}

function wrapper(id: string, target: string, calls: readonly WorkflowNodeTemplate[]): WorkflowTemplate {
  return {
    apiVersion: 'workflow.gm-hz.dev/v1', kind: 'WorkflowTemplate', metadata: { id, name: id },
    spec: {
      requires: [{ kind: 'capability', uses: 'gateway.workflow.call' }, { kind: 'workflow', uses: `${target}@1` }],
      inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, outputs: {},
      nodes: [
        { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
        ...calls,
        { id: 'end', uses: 'core.end@1', with: {}, inputs: {} },
      ],
      edges: calls.flatMap(node => [
        { id: `start-${node.id}`, source: 'start', target: node.id }, { id: `${node.id}-end`, source: node.id, target: 'end' },
      ]),
    },
  }
}

describe('WorkflowRuntime run readiness', () => {
  it('keeps template-only validation independent of host services', async () => {
    const runtime = setup()
    const template = toolWorkflowTemplate()

    await expect(runtime.validate(template)).resolves.toEqual([])
    await expect(runtime.validate(template, { inputs: { message: 'hello' } })).resolves.toContainEqual(
      expect.objectContaining({ code: 'TOOL_GATEWAY_MISSING', severity: 'error' }),
    )
  })

  it('applies the runtime input budget even if the input matches the schema', async () => {
    const execute = vi.fn(async () => null)
    const runtime = setup({ services: { tools: { execute } }, deploymentLimits: { maxInputBytes: 32 } })

    await expect(runtime.validate(toolWorkflowTemplate(), { inputs: { message: 'x'.repeat(100) } })).resolves.toContainEqual(
      expect.objectContaining({ code: 'WORKFLOW_INPUT_TOO_LARGE', severity: 'error' }),
    )
    expect(execute).not.toHaveBeenCalled()
  })

  it('reports an unavailable Tool on an alternate branch without blocking the selected branch', async () => {
    const authority = { kind: 'ready-authority' }
    const execute = vi.fn(async () => null)
    const list = vi.fn(async () => [{
      uses: 'enabled-tool', title: 'Enabled tool', description: 'Only visible tool',
      inputSchema: { type: 'object' } as const, idempotency: 'never' as const,
    }])
    const runtime = setup({ services: { tools: { list, execute } } })
    const template = branchingWorkflowTemplate()
    const inputs = { enabled: true }

    await expect(runtime.validate(template, { inputs, authority })).resolves.toEqual([
      expect.objectContaining({ code: 'WORKFLOW_TOOL_UNAVAILABLE', severity: 'warning', message: expect.stringContaining('disabled-tool') }),
    ])
    expect(list).toHaveBeenCalledWith(authority)
    expect(execute).not.toHaveBeenCalled()

    const run = await runtime.launch({
      target: { type: 'inline', template }, inputs, authorityRef: 'readiness:branch', authority, origin: { type: 'sdk' },
    })
    await expect(run.result).resolves.toMatchObject({ status: 'completed', outputs: { answer: true } })
    expect(execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ uses: 'enabled-tool', authority }))
  })

  it('treats a node reached from every branch as mandatory', async () => {
    const runtime = setup({ services: { tools: {
      execute: vi.fn(),
      list: async () => ['enabled-tool', 'disabled-tool'].map(uses => ({ uses, title: uses, description: uses, inputSchema: {}, idempotency: 'never' })),
    } } })
    const template = branchingWorkflowTemplate()
    const joined: WorkflowTemplate = { ...template, spec: {
      ...template.spec,
      requires: [...template.spec.requires!, { kind: 'tool', uses: 'joined-tool' }],
      nodes: [...template.spec.nodes, { id: 'join', uses: 'tool.call@1', with: { uses: 'joined-tool' }, inputs: {} }],
      edges: [...template.spec.edges.map(edge => edge.target === 'end' ? { ...edge, target: 'join' } : edge),
        { id: 'join-end', source: 'join', target: 'end' }],
    } }
    await expect(runtime.validate(joined, { inputs: { enabled: true } })).resolves.toEqual([
      expect.objectContaining({ code: 'WORKFLOW_TOOL_UNAVAILABLE', nodeId: 'join', severity: 'error' }),
    ])
  })

  it('inspects nested pinned revisions once per phase and reports each root invocation path', async () => {
    const repository = new InMemoryWorkflowCatalogRepository()
    const execute = vi.fn()
    const list = vi.fn(async () => [{ uses: 'new-echo', title: 'New echo', description: 'New revision', inputSchema: {}, idempotency: 'never' as const }])
    const runtime = setup({ services: { tools: { list, execute } } }, repository)
    const original = toolWorkflowTemplate()
    await publish(runtime, original)
    const latest = await runtime.updateDraft('tool-flow', 1, { ...original, spec: {
      ...original.spec,
      requires: [{ kind: 'capability', uses: 'gateway.tool.execute' }, { kind: 'tool', uses: 'new-echo' }],
      nodes: original.spec.nodes.map(node => node.id === 'call' ? { ...node, with: { uses: 'new-echo' } } : node),
    } })
    await runtime.publish(latest.id, latest.revision)
    await publish(runtime, wrapper('child-wrapper', 'tool-flow', [call('tool-flow')]))
    const readPublished = vi.spyOn(repository, 'readPublished')
    const callIds = Array.from({ length: 24 }, (_, index) => `invoke-${String(index).padStart(2, '0')}`)
    const root = wrapper('parent', 'child-wrapper', callIds.map(id => call('child-wrapper', id)))
    const authority = { source: 'pinned' }

    const result = await runtime.validate(root, { inputs: {}, authority })
    expect(result).toEqual(callIds.map(nodeId => expect.objectContaining({
      code: 'WORKFLOW_TOOL_UNAVAILABLE', severity: 'error', nodeId,
      path: ['dependencies', nodeId, 'child-wrapper@1', 'dependencies', 'invoke', 'tool-flow@1', 'nodes', 'call'],
      message: expect.stringContaining('echo is not visible'),
    })))
    expect(readPublished.mock.calls.filter(([id, revision]) => id === 'tool-flow' && revision === 1)).toHaveLength(2)
    expect(readPublished.mock.calls.filter(([id, revision]) => id === 'child-wrapper' && revision === 1)).toHaveLength(2)
    expect(readPublished).not.toHaveBeenCalledWith('tool-flow', 2)
    expect(list).toHaveBeenCalledExactlyOnceWith(authority)
    expect(execute).not.toHaveBeenCalled()
  })

  it('downgrades nested dependencies on possible routes and distinguishes empty, nonempty, and unresolved foreach items', async () => {
    const list = vi.fn(async () => [])
    const execute = vi.fn()
    const runtime = setup({ services: { tools: { list, execute } } })
    const tool = toolWorkflowTemplate()
    const itemTool: WorkflowTemplate = { ...tool, metadata: { id: 'item-tool', name: 'Item tool' }, spec: {
      ...tool.spec,
      inputSchema: { type: 'object', required: ['item', 'index', 'shared'], properties: {
        item: { type: 'string' }, index: { type: 'number' }, shared: { type: 'object' },
      } },
      nodes: tool.spec.nodes.map(node => node.id === 'call' ? { ...node, inputs: { message: { input: { path: ['item'] } } } } : node),
    } }
    await publish(runtime, itemTool)
    const loop: WorkflowNodeTemplate = {
      id: 'for-each', uses: 'core.foreach@1', with: { templateId: 'item-tool', revision: 1 }, inputs: { items: { input: { path: ['items'] } } },
    }
    const root = wrapper('loop-parent', 'item-tool', [loop])
    await expect(runtime.validate(root, { inputs: { items: [] } })).resolves.toEqual([])
    expect(list).not.toHaveBeenCalled()
    const emptyRun = await runtime.launch({ target: { type: 'inline', template: root }, inputs: { items: [] }, authorityRef: 'readiness:empty', authority: {}, origin: { type: 'sdk' } })
    await expect(emptyRun.result).resolves.toMatchObject({ status: 'completed' })

    const missingTool = { code: 'WORKFLOW_TOOL_UNAVAILABLE', nodeId: 'for-each', path: ['dependencies', 'for-each', 'item-tool@1', 'nodes', 'call'] }
    await expect(runtime.validate(root, { inputs: { items: ['first', 'second'] } })).resolves.toEqual([
      expect.objectContaining({ ...missingTool, severity: 'error' }),
    ])
    await expect(runtime.validate(root, { inputs: { items: [4] } })).resolves.toEqual([
      expect.objectContaining({ code: 'SUBWORKFLOW_INPUT_INVALID', severity: 'error', nodeId: 'for-each' }),
      expect.objectContaining({ ...missingTool, severity: 'error' }),
    ])
    const fromStart = wrapper('loop-start-output', 'item-tool', [{ ...loop, inputs: { items: { output: { nodeId: 'start', path: ['items'] } } } }])
    await expect(runtime.validate(fromStart, { inputs: { items: [] } })).resolves.toEqual([])
    const dynamic: WorkflowTemplate = { ...fromStart, spec: {
      ...fromStart.spec,
      requires: [...fromStart.spec.requires!, { kind: 'capability', uses: 'workflow.script.execute' }, { kind: 'script-runtime', uses: 'json.expr@1' }],
      nodes: [...fromStart.spec.nodes.map(node => node.id === 'for-each'
        ? { ...node, inputs: { items: { output: { nodeId: 'select-items', path: ['items'] } } } } : node),
      { id: 'select-items', uses: 'core.script@1', with: { language: 'json.expr@1', source: '{ items: [] }' }, inputs: {} }],
      edges: [
        { id: 'start-select', source: 'start', target: 'select-items' },
        { id: 'select-loop', source: 'select-items', target: 'for-each' },
        { id: 'loop-end', source: 'for-each', target: 'end' },
      ],
    } }
    await expect(runtime.validate(dynamic, { inputs: { items: [] } })).resolves.toEqual([
      expect.objectContaining({ ...missingTool, severity: 'warning' }),
    ])

    const possible: WorkflowTemplate = { ...root, spec: {
      ...root.spec,
      nodes: [...root.spec.nodes, { id: 'choose', uses: 'core.condition@1', with: { operator: 'truthy' }, inputs: { left: { literal: false } } }],
      edges: [
        { id: 'start-choose', source: 'start', target: 'choose' },
        { id: 'choose-loop', source: 'choose', target: 'for-each', sourcePort: 'true' },
        { id: 'choose-end', source: 'choose', target: 'end', sourcePort: 'false' },
        { id: 'loop-end', source: 'for-each', target: 'end' },
      ],
    } }
    await expect(runtime.validate(possible, { inputs: { items: ['first'] } })).resolves.toEqual([
      expect.objectContaining({ ...missingTool, severity: 'warning' }),
    ])
    expect(execute).not.toHaveBeenCalled()
  })

  it('reports an unusable pinned revision even when the enclosing foreach has no items', async () => {
    const runtime = setup({ deploymentLimits: { maxNodes: 3 } })
    await publish(runtime, branchingWorkflowTemplate())
    const loop: WorkflowNodeTemplate = {
      id: 'for-each', uses: 'core.foreach@1', with: { templateId: 'branch-flow', revision: 1 }, inputs: { items: { literal: [] } },
    }
    await expect(runtime.validate(wrapper('empty-loop', 'branch-flow', [loop]), { inputs: {} })).resolves.toEqual([
      expect.objectContaining({ code: 'WORKFLOW_NODE_LIMIT_EXCEEDED', severity: 'error', nodeId: 'for-each',
        path: ['dependencies', 'for-each', 'branch-flow@1', 'spec', 'nodes'] }),
    ])
  })
})
