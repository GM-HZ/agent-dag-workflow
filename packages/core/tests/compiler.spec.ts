import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  compileWorkflow,
  compileWorkflowOrThrow,
  parseWorkflowTemplate,
  registerCoreNodes,
  WorkflowNodeRegistry,
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
})
