import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  compileWorkflow,
  compileWorkflowOrThrow,
  parseWorkflowTemplate,
  registerCoreNodes,
  WorkflowNodeRegistry,
  type WorkflowNodeDefinition,
  type WorkflowTemplate,
} from '../src/index.js'
import { toolWorkflowTemplate } from './fixtures.js'

describe('workflow compiler', () => {
  it('parses and compiles the checked-in v0.1 YAML example', () => {
    const registry = new WorkflowNodeRegistry()
    registerCoreNodes(registry)
    const source = readFileSync(new URL('../../../examples/tool-echo.workflow.yaml', import.meta.url), 'utf8')
    const workflow = compileWorkflowOrThrow(parseWorkflowTemplate(source), registry)

    expect(workflow.template.metadata.id).toBe('tool-echo')
    expect(workflow.order).toEqual(['start', 'echo', 'end'])
  })

  it('leases exact node definitions and ignores layout in the semantic hash', () => {
    const registry = new WorkflowNodeRegistry()
    const dispose = registerCoreNodes(registry)
    const template = toolWorkflowTemplate()
    const first = compileWorkflowOrThrow(template, registry)
    const second = compileWorkflowOrThrow({ ...template, layout: { nodes: { start: { x: 999, y: 400 } } } }, registry)

    expect(first.semanticHash).toBe(second.semanticHash)
    expect(first.order).toEqual(['start', 'call', 'end'])

    dispose()
    expect(registry.list()).toEqual([])
    expect(first.nodes.get('call')?.definition.type).toBe('dsh.tool')
    expect(compileWorkflow(template, registry).diagnostics).toContainEqual(expect.objectContaining({ code: 'UNKNOWN_NODE_TYPE' }))
  })

  it('rejects a binding whose producer is not a strict upstream node', () => {
    const registry = new WorkflowNodeRegistry()
    registerCoreNodes(registry)
    const template = toolWorkflowTemplate()
    const invalid = {
      ...template,
      spec: {
        ...template.spec,
        nodes: template.spec.nodes.map(node => node.id === 'call'
          ? { ...node, inputs: { message: { output: { node: 'end', path: ['answer'] } } } }
          : node),
      },
    } as typeof template

    expect(compileWorkflow(invalid, registry).diagnostics).toContainEqual(expect.objectContaining({
      code: 'BINDING_NOT_UPSTREAM',
      nodeId: 'call',
    }))
  })

  it('rejects ordinary cycles', () => {
    const registry = new WorkflowNodeRegistry()
    registerCoreNodes(registry)
    const template = toolWorkflowTemplate()
    const invalid = {
      ...template,
      spec: {
        ...template.spec,
        edges: [...template.spec.edges, { id: 'end-call', source: 'end', target: 'call' }],
      },
    }

    const codes = compileWorkflow(invalid, registry).diagnostics.map(item => item.code)
    expect(codes).toContain('END_HAS_OUTGOING')
    expect(codes).toContain('GRAPH_CYCLE')
  })

  it('validates required bindings, workflow input names, and explicit output paths before publish', () => {
    const registry = new WorkflowNodeRegistry()
    registerCoreNodes(registry)
    const base = toolWorkflowTemplate()
    const invalid = {
      ...base,
      spec: {
        ...base.spec,
        nodes: base.spec.nodes.map(node => node.id === 'call'
          ? { ...node, inputs: { message: { input: 'missing' } } }
          : node.id === 'end'
            ? { ...node, inputs: { answer: { output: { node: 'call', path: ['missing'] } } } }
            : node),
        outputs: {},
      },
    } as unknown as WorkflowTemplate

    const codes = compileWorkflow(invalid, registry).diagnostics.map(item => item.code)
    expect(codes).toContain('UNKNOWN_WORKFLOW_INPUT')
    expect(codes).toContain('BINDING_OUTPUT_PATH_INVALID')
    expect(codes).toContain('REQUIRED_BINDING_MISSING')
  })

  it('rejects statically disjoint source and target JSON Schema types', () => {
    const registry = new WorkflowNodeRegistry()
    registerCoreNodes(registry)
    registry.register(testNode('test.string', {}, {
      type: 'object', additionalProperties: false, required: ['value'], properties: { value: { type: 'string' } },
    }))
    registry.register(testNode('test.number', {
      type: 'object', additionalProperties: false, required: ['value'], properties: { value: { type: 'number' } },
    }, {
      type: 'object', additionalProperties: false, required: ['value'], properties: { value: { type: 'number' } },
    }))
    const template: WorkflowTemplate = {
      apiVersion: 'dsh.workflow/v1alpha1', kind: 'WorkflowTemplate',
      metadata: { id: 'type-mismatch', name: 'Type mismatch' },
      spec: {
        inputSchema: { type: 'object', additionalProperties: false },
        outputSchema: { type: 'object', additionalProperties: false, required: ['value'], properties: { value: { type: 'number' } } },
        nodes: [
          { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
          { id: 'text', uses: 'test.string@1', with: {}, inputs: {} },
          { id: 'number', uses: 'test.number@1', with: {}, inputs: { value: { output: { node: 'text', path: ['value'] } } } },
          { id: 'end', uses: 'core.end@1', with: {}, inputs: { value: { output: { node: 'number', path: ['value'] } } } },
        ],
        edges: [
          { id: 's-t', source: 'start', target: 'text' },
          { id: 't-n', source: 'text', target: 'number' },
          { id: 'n-e', source: 'number', target: 'end' },
        ],
        outputs: { value: { output: { node: 'end', path: ['value'] } } },
      },
    }

    expect(compileWorkflow(template, registry).diagnostics).toContainEqual(expect.objectContaining({
      code: 'BINDING_TYPE_MISMATCH', nodeId: 'number',
    }))
  })
})

function testNode(type: string, inputSchema: Record<string, unknown>, outputSchema: Record<string, unknown>): WorkflowNodeDefinition {
  return {
    type, version: 1, title: type, description: type,
    configSchema: { type: 'object', additionalProperties: false },
    inputSchema, outputSchema, outputPorts: ['success'], capabilities: [], retry: 'safe',
    async execute(context) { return { outputs: context.inputs } },
  }
}
