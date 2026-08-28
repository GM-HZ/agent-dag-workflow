import { describe, expect, it } from 'vitest'
import type { CanvasNodeDefinition, CanvasWorkflowTemplate } from '../../src/canvas/types.js'
import { addNode, connectNodes, moveNode, removeNode, templateToFlow } from '../../src/canvas/client/model.js'
import { WorkflowNodeRendererRegistry } from '../../src/canvas/client/registry.js'
import { WorkflowCanvasUiController } from '../../src/canvas/client/controller.js'

const definition: CanvasNodeDefinition = {
  catalogId: 'acme.work@1',
  kind: 'node',
  uses: 'acme.work@1',
  title: 'Work',
  description: 'Does work',
  role: 'regular',
  configSchema: { type: 'object' },
  defaultConfig: { mode: 'safe' },
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  outputPorts: ['done'],
  requiredOutputPorts: [],
  capabilities: ['acme.work.execute'],
  dependencyKinds: ['acme-resource'],
  defaultRequirements: [{ kind: 'capability', uses: 'acme.work.execute' }],
  retry: 'safe',
}

function template(): CanvasWorkflowTemplate {
  return {
    apiVersion: 'workflow.gm-hz.dev/v1alpha1',
    kind: 'WorkflowTemplate',
    metadata: { id: 'canvas-test', name: 'Canvas test' },
    spec: { inputSchema: {}, outputSchema: {}, nodes: [], edges: [], outputs: {} },
  }
}

describe('canvas template projection', () => {
  it('round-trips graph edits through the canonical WorkflowTemplate only', () => {
    const withNode = addNode(template(), definition, { x: 41, y: 73 })
    const second = addNode(withNode, definition, { x: 380, y: 73 })
    const connected = connectNodes(second, {
      source: 'work',
      sourceHandle: 'done',
      target: 'work-2',
      targetHandle: null,
    })
    const moved = moveNode(connected, 'work', { x: 99, y: 101 })
    const flow = templateToFlow(moved, [definition])

    expect(moved.spec.edges).toEqual([{ id: 'work-done-work-2', source: 'work', target: 'work-2', sourcePort: 'done' }])
    expect(moved.spec.nodes[0]?.with).toEqual({ mode: 'safe' })
    expect(moved.spec.requires).toEqual([{ kind: 'capability', uses: 'acme.work.execute' }])
    expect(flow.nodes[0]?.position).toEqual({ x: 99, y: 101 })
    expect(flow.edges[0]).toMatchObject({ sourceHandle: 'done', type: 'smoothstep' })
    expect(removeNode(moved, 'work').spec).toMatchObject({ nodes: [{ id: 'work-2' }], edges: [] })
  })

  it('materializes a visible DSH Tool as the generic tool node with exact requirements', () => {
    const tool: CanvasNodeDefinition = {
      catalogId: 'tool:dms.query',
      kind: 'tool',
      uses: 'tool.call@1',
      toolName: 'dms.query',
      title: 'DMS query',
      description: 'Queries an authorized database.',
      role: 'regular',
      configSchema: { type: 'object' },
      defaultConfig: { uses: 'dms.query' },
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      outputPorts: ['success'],
      requiredOutputPorts: [],
      capabilities: ['gateway.tool.execute'],
      dependencyKinds: ['tool'],
      defaultRequirements: [
        { kind: 'capability', uses: 'gateway.tool.execute' },
        { kind: 'tool', uses: 'dms.query' },
      ],
      retry: 'never',
    }

    const withTool = addNode(template(), tool, { x: 10, y: 20 })
    const node = withTool.spec.nodes[0]!

    expect(node).toMatchObject({ id: 'dms-query', uses: 'tool.call@1', with: { uses: 'dms.query' } })
    expect(withTool.spec.requires).toEqual(tool.defaultRequirements)
    expect(templateToFlow(withTool, [tool]).nodes[0]?.data.definition?.catalogId).toBe('tool:dms.query')
  })

  it('allows one renderer owner per exact uses identifier and disposes by identity', () => {
    const registry = new WorkflowNodeRendererRegistry()
    const renderer = () => <div>custom</div>
    const dispose = registry.register('acme.work@1', renderer)
    expect(registry.resolve('acme.work@1')).toBe(renderer)
    expect(() => registry.register('acme.work@1', renderer)).toThrow(/already registered/)
    dispose()
    expect(registry.resolve('acme.work@1')).toBeUndefined()
  })

  it('exposes a stable client navigation seam for run and Session renderers', () => {
    const controller = new WorkflowCanvasUiController()
    let changes = 0
    const dispose = controller.subscribe(() => { changes++ })
    controller.open({ templateId: 'canvas-test', runId: 'run-1', nodeId: 'work' })
    expect(controller.getSnapshot()).toEqual({
      open: true,
      requestId: 1,
      target: { templateId: 'canvas-test', runId: 'run-1', nodeId: 'work' },
    })
    controller.close()
    expect(controller.getSnapshot().open).toBe(false)
    expect(changes).toBe(2)
    dispose()
  })
})
