import type { Connection, Edge, Node, XYPosition } from '@xyflow/react'
import type {
  CanvasNodeDefinition,
  CanvasTrace,
  CanvasWorkflowEdge,
  CanvasWorkflowNode,
  CanvasWorkflowTemplate,
} from '../types.js'

export interface WorkflowFlowNodeData extends Record<string, unknown> {
  readonly template: CanvasWorkflowNode
  readonly definition?: CanvasNodeDefinition
  readonly status?: string
}

export type WorkflowFlowNode = Node<WorkflowFlowNodeData, 'workflow'>

export function templateToFlow(
  template: CanvasWorkflowTemplate,
  definitions: readonly CanvasNodeDefinition[],
  trace?: CanvasTrace,
): { nodes: WorkflowFlowNode[]; edges: Edge[] } {
  const positions = readPositions(template)
  return {
    nodes: template.spec.nodes.map((node, index) => {
      const definition = findNodeDefinition(definitions, node)
      const status = trace?.nodeStates[node.id]
      return {
        id: node.id,
        type: 'workflow',
        position: positions[node.id] ?? fallbackPosition(index),
        data: {
          template: node,
          ...(definition === undefined ? {} : { definition }),
          ...(status === undefined ? {} : { status }),
        },
      }
    }),
    edges: template.spec.edges.map(edge => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      ...(edge.sourcePort === undefined ? {} : { sourceHandle: edge.sourcePort }),
      type: 'smoothstep',
      animated: trace?.edgeStates[edge.id] === 'taken',
      ...(trace?.edgeStates[edge.id] === 'skipped' ? { className: 'wf-edge-skipped' } : {}),
    })),
  }
}

export function moveNode(
  template: CanvasWorkflowTemplate,
  nodeId: string,
  position: XYPosition,
): CanvasWorkflowTemplate {
  const positions = readPositions(template)
  return {
    ...template,
    layout: {
      ...(template.layout ?? {}),
      canvas: {
        positions: {
          ...positions,
          [nodeId]: { x: position.x, y: position.y },
        },
      },
    },
  }
}

export function addNode(
  template: CanvasWorkflowTemplate,
  definition: CanvasNodeDefinition,
  position: XYPosition,
): CanvasWorkflowTemplate {
  const stem = (definition.toolName ?? definition.uses.split('@', 1)[0]?.split('.').at(-1))
    ?.toLowerCase().replaceAll(/[^a-z0-9]/g, '-') || 'node'
  const occupied = new Set(template.spec.nodes.map(node => node.id))
  let id = stem
  let suffix = 2
  while (occupied.has(id)) id = `${stem}-${suffix++}`
  const node: CanvasWorkflowNode = {
    id,
    uses: definition.uses,
    with: definition.defaultConfig ?? {},
    inputs: {},
  }
  return moveNode({
    ...template,
    spec: {
      ...template.spec,
      requires: mergeRequirements(template.spec.requires ?? [], definition.defaultRequirements),
      nodes: [...template.spec.nodes, node],
    },
  }, id, position)
}

export function findNodeDefinition(
  definitions: readonly CanvasNodeDefinition[],
  node: CanvasWorkflowNode,
): CanvasNodeDefinition | undefined {
  const toolName = typeof node.with.name === 'string' ? node.with.name : undefined
  return definitions.find(definition => definition.uses === node.uses && definition.toolName === toolName)
    ?? definitions.find(definition => definition.uses === node.uses && definition.toolName === undefined)
}

function mergeRequirements(
  current: readonly import('../types.js').CanvasWorkflowRequirement[],
  added: readonly import('../types.js').CanvasWorkflowRequirement[],
): readonly import('../types.js').CanvasWorkflowRequirement[] {
  const requirements = new Map(current.map(item => [`${item.kind}:${item.uses}`, item]))
  for (const item of added) requirements.set(`${item.kind}:${item.uses}`, item)
  return [...requirements.values()]
}

export function removeNode(template: CanvasWorkflowTemplate, nodeId: string): CanvasWorkflowTemplate {
  return {
    ...template,
    spec: {
      ...template.spec,
      nodes: template.spec.nodes.filter(node => node.id !== nodeId),
      edges: template.spec.edges.filter(edge => edge.source !== nodeId && edge.target !== nodeId),
    },
  }
}

export function connectNodes(template: CanvasWorkflowTemplate, connection: Connection): CanvasWorkflowTemplate {
  if (connection.source === null || connection.target === null) return template
  const base = `${connection.source}-${connection.sourceHandle ?? 'out'}-${connection.target}`
  const occupied = new Set(template.spec.edges.map(edge => edge.id))
  let id = base
  let suffix = 2
  while (occupied.has(id)) id = `${base}-${suffix++}`
  const edge: CanvasWorkflowEdge = {
    id,
    source: connection.source,
    target: connection.target,
    ...(connection.sourceHandle === null ? {} : { sourcePort: connection.sourceHandle }),
  }
  return { ...template, spec: { ...template.spec, edges: [...template.spec.edges, edge] } }
}

export function removeEdge(template: CanvasWorkflowTemplate, edgeId: string): CanvasWorkflowTemplate {
  return { ...template, spec: { ...template.spec, edges: template.spec.edges.filter(edge => edge.id !== edgeId) } }
}

export function blankTemplate(seed = Date.now()): CanvasWorkflowTemplate {
  return {
    apiVersion: 'dsh.workflow/v1alpha1',
    kind: 'WorkflowTemplate',
    metadata: { id: `workflow-${seed}`, name: 'Untitled signal' },
    spec: {
      inputSchema: { type: 'object', additionalProperties: true },
      outputSchema: { type: 'object' },
      nodes: [],
      edges: [],
      outputs: {},
    },
    layout: { canvas: { positions: {} } },
  }
}

function readPositions(template: CanvasWorkflowTemplate): Record<string, XYPosition> {
  const canvas = template.layout?.canvas
  if (!isCanvasObject(canvas)) return {}
  const raw = canvas.positions
  if (!isCanvasObject(raw)) return {}
  const positions: Record<string, XYPosition> = {}
  for (const [id, value] of Object.entries(raw)) {
    if (!isCanvasObject(value)) continue
    const x = value.x
    const y = value.y
    if (typeof x === 'number' && typeof y === 'number') positions[id] = { x, y }
  }
  return positions
}

function isCanvasObject(value: unknown): value is import('../types.js').CanvasJsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function fallbackPosition(index: number): XYPosition {
  return { x: 120 + (index % 3) * 310, y: 90 + Math.floor(index / 3) * 190 }
}
