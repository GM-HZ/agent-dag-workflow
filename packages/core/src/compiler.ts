import type { WorkflowNodeRegistry } from './registry.js'
import { compileJsonValidator, structuralDiagnostics } from './schema.js'
import { snapshotJsonValue } from './json.js'
import { materializeWorkflowTemplate } from './hash.js'
import type {
  WorkflowBinding,
  WorkflowDiagnostic,
  WorkflowEdgeTemplate,
  WorkflowNodeDefinition,
  WorkflowNodeTemplate,
  WorkflowTemplate,
  JsonSchema,
} from './types.js'
import { WorkflowCompileError } from './errors.js'

export interface CompiledWorkflowNode {
  readonly template: WorkflowNodeTemplate
  readonly definition: WorkflowNodeDefinition
  readonly incoming: readonly WorkflowEdgeTemplate[]
  readonly outgoing: readonly WorkflowEdgeTemplate[]
  readonly validateInputs: (value: unknown) => readonly string[]
  readonly validateOutputs: (value: unknown) => readonly string[]
}

export interface CompiledWorkflow {
  readonly template: WorkflowTemplate
  readonly nodes: ReadonlyMap<string, CompiledWorkflowNode>
  readonly edges: ReadonlyMap<string, WorkflowEdgeTemplate>
  readonly order: readonly string[]
  readonly startNodeId: string
  readonly semanticHash: string
  readonly validateWorkflowInputs: (value: unknown) => readonly string[]
  readonly validateWorkflowOutputs: (value: unknown) => readonly string[]
}

export interface WorkflowCompileResult {
  readonly workflow?: CompiledWorkflow
  readonly diagnostics: readonly WorkflowDiagnostic[]
}

export function compileWorkflow(candidate: WorkflowTemplate, registry: WorkflowNodeRegistry): WorkflowCompileResult {
  let template: WorkflowTemplate
  try {
    template = snapshotJsonValue(candidate) as unknown as WorkflowTemplate
  } catch (error: unknown) {
    return { diagnostics: [diagnostic('TEMPLATE_NOT_LOSSLESS_JSON', renderError(error))] }
  }
  const diagnostics = structuralDiagnostics(template)
  if (diagnostics.length > 0) return { diagnostics }

  const nodesById = new Map<string, WorkflowNodeTemplate>()
  const definitions = new Map<string, WorkflowNodeDefinition>()
  for (const [index, node] of template.spec.nodes.entries()) {
    if (nodesById.has(node.id)) {
      diagnostics.push(diagnostic('DUPLICATE_NODE_ID', `duplicate node id: ${node.id}`, node.id, ['spec', 'nodes', index, 'id']))
      continue
    }
    nodesById.set(node.id, node)
    const definition = registry.resolve(node.uses)
    if (definition === undefined) {
      diagnostics.push(diagnostic('UNKNOWN_NODE_TYPE', `node provider is not registered: ${node.uses}`, node.id, ['spec', 'nodes', index, 'uses']))
      continue
    }
    definitions.set(node.id, definition)
    if ((node.policy?.retry?.maxAttempts ?? 1) > 1) {
      diagnostics.push(diagnostic('RETRY_UNSUPPORTED', 'v0.1 executes every node at most once; maxAttempts must be 1', node.id, ['spec', 'nodes', index, 'policy', 'retry']))
    }
    try {
      const configErrors = compileJsonValidator(definition.configSchema, `${node.uses} config schema`)(node.with)
      for (const message of configErrors) diagnostics.push(diagnostic('NODE_CONFIG_INVALID', message, node.id, ['spec', 'nodes', index, 'with']))
    } catch (error: unknown) {
      diagnostics.push(diagnostic('NODE_PROVIDER_SCHEMA_INVALID', renderError(error), node.id))
    }
  }

  const edgesById = new Map<string, WorkflowEdgeTemplate>()
  const incoming = new Map<string, WorkflowEdgeTemplate[]>()
  const outgoing = new Map<string, WorkflowEdgeTemplate[]>()
  for (const nodeId of nodesById.keys()) {
    incoming.set(nodeId, [])
    outgoing.set(nodeId, [])
  }
  for (const [index, edge] of template.spec.edges.entries()) {
    if (edgesById.has(edge.id)) {
      diagnostics.push(diagnostic('DUPLICATE_EDGE_ID', `duplicate edge id: ${edge.id}`, undefined, ['spec', 'edges', index, 'id']))
      continue
    }
    edgesById.set(edge.id, edge)
    const source = nodesById.get(edge.source)
    const target = nodesById.get(edge.target)
    if (source === undefined) diagnostics.push(diagnostic('DANGLING_EDGE_SOURCE', `unknown source node: ${edge.source}`, undefined, ['spec', 'edges', index, 'source']))
    if (target === undefined) diagnostics.push(diagnostic('DANGLING_EDGE_TARGET', `unknown target node: ${edge.target}`, undefined, ['spec', 'edges', index, 'target']))
    if (source === undefined || target === undefined) continue
    outgoing.get(edge.source)!.push(edge)
    incoming.get(edge.target)!.push(edge)
    const definition = definitions.get(edge.source)
    const port = edge.sourcePort ?? 'success'
    if (definition !== undefined && !definition.outputPorts.includes(port)) {
      diagnostics.push(diagnostic('UNKNOWN_OUTPUT_PORT', `${edge.source} does not declare output port ${port}`, edge.source, ['spec', 'edges', index, 'sourcePort']))
    }
  }

  const starts = [...definitions].filter(([, definition]) => definition.role === 'start').map(([id]) => id)
  const ends = [...definitions].filter(([, definition]) => definition.role === 'end').map(([id]) => id)
  if (starts.length !== 1) diagnostics.push(diagnostic('START_COUNT', `expected exactly one start node, found ${starts.length}`))
  if (ends.length === 0) diagnostics.push(diagnostic('END_COUNT', 'expected at least one end node'))
  for (const start of starts) {
    if ((incoming.get(start)?.length ?? 0) > 0) diagnostics.push(diagnostic('START_HAS_INCOMING', 'start node cannot have incoming edges', start))
  }
  for (const end of ends) {
    if ((outgoing.get(end)?.length ?? 0) > 0) diagnostics.push(diagnostic('END_HAS_OUTGOING', 'end node cannot have outgoing edges', end))
  }
  for (const [nodeId, definition] of definitions) {
    const usedPorts = new Set((outgoing.get(nodeId) ?? []).map(edge => edge.sourcePort ?? 'success'))
    for (const port of definition.requiredOutputPorts ?? []) {
      if (!usedPorts.has(port)) diagnostics.push(diagnostic('REQUIRED_OUTPUT_PORT_MISSING', `required output port has no edge: ${port}`, nodeId))
    }
  }

  const order = topologicalOrder(nodesById, incoming, outgoing)
  if (order.length !== nodesById.size) diagnostics.push(diagnostic('GRAPH_CYCLE', 'workflow graph contains a cycle'))
  const startNodeId = starts[0]
  if (startNodeId !== undefined) {
    const reachable = collectReachable(startNodeId, outgoing)
    for (const nodeId of nodesById.keys()) {
      if (!reachable.has(nodeId)) diagnostics.push(diagnostic('UNREACHABLE_NODE', 'node is not reachable from start', nodeId))
    }
  }
  const canReachEnd = collectReverseReachable(ends, incoming)
  for (const nodeId of nodesById.keys()) {
    if (!canReachEnd.has(nodeId)) diagnostics.push(diagnostic('NODE_CANNOT_REACH_END', 'node has no path to an end node', nodeId))
  }

  if (order.length === nodesById.size) {
    const ancestors = computeAncestors(order, incoming)
    for (const [nodeId, node] of nodesById) {
      validateBindings(
        node.inputs,
        nodeId,
        nodesById,
        definitions,
        ancestors,
        template.spec.inputSchema,
        definitions.get(nodeId)?.inputSchema,
        diagnostics,
        ['spec', 'nodes', template.spec.nodes.indexOf(node), 'inputs'],
      )
    }
    validateBindings(
      template.spec.outputs,
      undefined,
      nodesById,
      definitions,
      undefined,
      template.spec.inputSchema,
      template.spec.outputSchema,
      diagnostics,
      ['spec', 'outputs'],
    )
    for (const [name, binding] of Object.entries(template.spec.outputs)) {
      if (!('output' in binding)) {
        diagnostics.push(diagnostic('WORKFLOW_OUTPUT_BINDING_INVALID', 'workflow output must reference an end node output', undefined, ['spec', 'outputs', name]))
      } else if (definitions.get(binding.output.node)?.role !== 'end') {
        diagnostics.push(diagnostic('WORKFLOW_OUTPUT_SOURCE_NOT_END', `workflow output must reference an end node: ${binding.output.node}`, undefined, ['spec', 'outputs', name]))
      }
    }
  }

  let validateWorkflowInputs: (value: unknown) => readonly string[]
  let validateWorkflowOutputs: (value: unknown) => readonly string[]
  try {
    validateWorkflowInputs = compileJsonValidator(template.spec.inputSchema, 'workflow input schema')
    validateWorkflowOutputs = compileJsonValidator(template.spec.outputSchema, 'workflow output schema')
  } catch (error: unknown) {
    diagnostics.push(diagnostic('WORKFLOW_SCHEMA_INVALID', renderError(error)))
    return { diagnostics }
  }

  if (diagnostics.some(item => item.severity === 'error') || startNodeId === undefined) return { diagnostics }

  const compiledNodes = new Map<string, CompiledWorkflowNode>()
  for (const [nodeId, node] of nodesById) {
    const definition = definitions.get(nodeId)!
    try {
      compiledNodes.set(nodeId, {
        template: node,
        definition,
        incoming: incoming.get(nodeId) ?? [],
        outgoing: outgoing.get(nodeId) ?? [],
        validateInputs: compileJsonValidator(definition.inputSchema, `${node.uses} input schema`),
        validateOutputs: compileJsonValidator(definition.outputSchema, `${node.uses} output schema`),
      })
    } catch (error: unknown) {
      diagnostics.push(diagnostic('NODE_PROVIDER_SCHEMA_INVALID', renderError(error), nodeId))
    }
  }
  if (diagnostics.length > 0) return { diagnostics }

  return {
    diagnostics,
    workflow: {
      template,
      nodes: compiledNodes,
      edges: edgesById,
      order,
      startNodeId,
      semanticHash: materializeWorkflowTemplate(template).semanticHash,
      validateWorkflowInputs,
      validateWorkflowOutputs,
    },
  }
}

export function compileWorkflowOrThrow(template: WorkflowTemplate, registry: WorkflowNodeRegistry): CompiledWorkflow {
  const result = compileWorkflow(template, registry)
  if (result.workflow === undefined) throw new WorkflowCompileError(result.diagnostics)
  return result.workflow
}

function validateBindings(
  bindings: Readonly<Record<string, WorkflowBinding>>,
  consumerNodeId: string | undefined,
  nodes: ReadonlyMap<string, WorkflowNodeTemplate>,
  definitions: ReadonlyMap<string, WorkflowNodeDefinition>,
  ancestors: ReadonlyMap<string, ReadonlySet<string>> | undefined,
  workflowInputSchema: JsonSchema,
  targetSchema: JsonSchema | undefined,
  diagnostics: WorkflowDiagnostic[],
  basePath: readonly (string | number)[],
): void {
  for (const required of requiredProperties(targetSchema)) {
    if (!(required in bindings)) {
      diagnostics.push(diagnostic(
        'REQUIRED_BINDING_MISSING',
        `required input/output binding is missing: ${required}`,
        consumerNodeId,
        [...basePath, required],
      ))
    }
  }
  for (const [name, binding] of Object.entries(bindings)) {
    const target = propertySchema(targetSchema, name)
    if (target.forbidden) {
      diagnostics.push(diagnostic('UNKNOWN_TARGET_BINDING', `target schema does not declare property: ${name}`, consumerNodeId, [...basePath, name]))
    }
    if ('literal' in binding) {
      if (target.schema !== undefined) {
        try {
          const errors = compileJsonValidator(target.schema, `binding ${name} target schema`)(binding.literal)
          for (const message of errors) diagnostics.push(diagnostic('BINDING_LITERAL_INVALID', message, consumerNodeId, [...basePath, name, 'literal']))
        } catch (error: unknown) {
          diagnostics.push(diagnostic('TARGET_SCHEMA_INVALID', renderError(error), consumerNodeId, [...basePath, name]))
        }
      }
      continue
    }
    if ('secret' in binding) continue

    let sourceSchema: JsonSchema | undefined
    if ('input' in binding) {
      const source = propertySchema(workflowInputSchema, binding.input)
      if (source.forbidden) {
        diagnostics.push(diagnostic('UNKNOWN_WORKFLOW_INPUT', `binding references unknown workflow input: ${binding.input}`, consumerNodeId, [...basePath, name, 'input']))
      }
      sourceSchema = source.schema
    } else {
      const sourceId = binding.output.node
      if (!nodes.has(sourceId)) {
        diagnostics.push(diagnostic('UNKNOWN_BINDING_NODE', `binding references unknown node: ${sourceId}`, consumerNodeId, [...basePath, name, 'output', 'node']))
        continue
      }
      if (consumerNodeId !== undefined && !ancestors?.get(consumerNodeId)?.has(sourceId)) {
        diagnostics.push(diagnostic('BINDING_NOT_UPSTREAM', `binding source ${sourceId} is not a strict upstream node`, consumerNodeId, [...basePath, name]))
      }
      const resolved = schemaAtPath(definitions.get(sourceId)?.outputSchema, binding.output.path)
      if (resolved.error !== undefined) {
        diagnostics.push(diagnostic('BINDING_OUTPUT_PATH_INVALID', resolved.error, consumerNodeId, [...basePath, name, 'output', 'path']))
      }
      sourceSchema = resolved.schema
    }
    if (sourceSchema !== undefined && target.schema !== undefined && !schemasMayOverlap(sourceSchema, target.schema)) {
      diagnostics.push(diagnostic(
        'BINDING_TYPE_MISMATCH',
        `binding ${name} source type ${renderSchemaTypes(sourceSchema)} is incompatible with target type ${renderSchemaTypes(target.schema)}`,
        consumerNodeId,
        [...basePath, name],
      ))
    }
  }
}

function requiredProperties(schema: JsonSchema | undefined): readonly string[] {
  return Array.isArray(schema?.required) ? schema.required.filter((value): value is string => typeof value === 'string') : []
}

function propertySchema(schema: JsonSchema | undefined, name: string): { readonly schema?: JsonSchema; readonly forbidden: boolean } {
  if (schema === undefined) return { forbidden: false }
  const properties = isRecord(schema.properties) ? schema.properties : undefined
  const value = properties?.[name]
  if (isRecord(value)) return { schema: value, forbidden: false }
  if (schema.additionalProperties === false) return { forbidden: true }
  if (isRecord(schema.additionalProperties)) return { schema: schema.additionalProperties, forbidden: false }
  return { forbidden: false }
}

function schemaAtPath(schema: JsonSchema | undefined, path: readonly (string | number)[]): { readonly schema?: JsonSchema; readonly error?: string } {
  let current = schema
  for (const segment of path) {
    if (current === undefined || Object.keys(current).length === 0) return {}
    if (typeof segment === 'string') {
      const property = propertySchema(current, segment)
      if (property.forbidden) return { error: `output schema has no property ${segment}` }
      current = property.schema
    } else {
      const types = schemaTypes(current)
      if (types !== undefined && !types.has('array')) return { error: `output schema is not an array at index ${segment}` }
      if (Array.isArray(current.items)) {
        const item = current.items[segment]
        if (item === undefined) return { error: `output tuple schema has no index ${segment}` }
        current = isRecord(item) ? item : undefined
      } else {
        current = isRecord(current.items) ? current.items : undefined
      }
    }
  }
  return current === undefined ? {} : { schema: current }
}

function schemasMayOverlap(source: JsonSchema, target: JsonSchema): boolean {
  const sourceTypes = schemaTypes(source)
  const targetTypes = schemaTypes(target)
  if (sourceTypes === undefined || targetTypes === undefined) return true
  for (const sourceType of sourceTypes) {
    for (const targetType of targetTypes) {
      if (sourceType === targetType || (sourceType === 'integer' && targetType === 'number')) return true
    }
  }
  return false
}

function schemaTypes(schema: JsonSchema): ReadonlySet<string> | undefined {
  const authored = schema.type
  if (typeof authored === 'string') return new Set([authored])
  if (Array.isArray(authored) && authored.every(value => typeof value === 'string')) return new Set(authored)
  if ('const' in schema) return new Set([jsonType(schema.const)])
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return new Set(schema.enum.map(jsonType))
  return undefined
}

function renderSchemaTypes(schema: JsonSchema): string {
  return [...(schemaTypes(schema) ?? ['unknown'])].sort().join('|')
}

function jsonType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number' && Number.isInteger(value)) return 'integer'
  if (typeof value === 'object') return 'object'
  return typeof value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function topologicalOrder(
  nodes: ReadonlyMap<string, WorkflowNodeTemplate>,
  incoming: ReadonlyMap<string, readonly WorkflowEdgeTemplate[]>,
  outgoing: ReadonlyMap<string, readonly WorkflowEdgeTemplate[]>,
): string[] {
  const degrees = new Map([...nodes.keys()].map(id => [id, incoming.get(id)?.length ?? 0]))
  const queue = [...degrees].filter(([, degree]) => degree === 0).map(([id]) => id).sort()
  const order: string[] = []
  while (queue.length > 0) {
    const nodeId = queue.shift()!
    order.push(nodeId)
    for (const edge of outgoing.get(nodeId) ?? []) {
      const next = degrees.get(edge.target)! - 1
      degrees.set(edge.target, next)
      if (next === 0) {
        queue.push(edge.target)
        queue.sort()
      }
    }
  }
  return order
}

function collectReachable(start: string, outgoing: ReadonlyMap<string, readonly WorkflowEdgeTemplate[]>): Set<string> {
  const reachable = new Set<string>()
  const pending = [start]
  while (pending.length > 0) {
    const nodeId = pending.pop()!
    if (reachable.has(nodeId)) continue
    reachable.add(nodeId)
    for (const edge of outgoing.get(nodeId) ?? []) pending.push(edge.target)
  }
  return reachable
}

function collectReverseReachable(ends: readonly string[], incoming: ReadonlyMap<string, readonly WorkflowEdgeTemplate[]>): Set<string> {
  const reachable = new Set<string>()
  const pending = [...ends]
  while (pending.length > 0) {
    const nodeId = pending.pop()!
    if (reachable.has(nodeId)) continue
    reachable.add(nodeId)
    for (const edge of incoming.get(nodeId) ?? []) pending.push(edge.source)
  }
  return reachable
}

function computeAncestors(
  order: readonly string[],
  incoming: ReadonlyMap<string, readonly WorkflowEdgeTemplate[]>,
): Map<string, ReadonlySet<string>> {
  const result = new Map<string, ReadonlySet<string>>()
  for (const nodeId of order) {
    const ancestors = new Set<string>()
    for (const edge of incoming.get(nodeId) ?? []) {
      ancestors.add(edge.source)
      for (const ancestor of result.get(edge.source) ?? []) ancestors.add(ancestor)
    }
    result.set(nodeId, ancestors)
  }
  return result
}

function diagnostic(code: string, message: string, nodeId?: string, path?: readonly (string | number)[]): WorkflowDiagnostic {
  return {
    code,
    severity: 'error',
    message,
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(path === undefined ? {} : { path }),
  }
}

function renderError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
