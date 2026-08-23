import type {
  JsonValue,
  WorkflowNodeDefinition,
} from './types.js'
import type { WorkflowNodeDisposer, WorkflowNodeRegistry } from './registry.js'
import { WorkflowExecutionError } from './errors.js'

const objectSchema = { type: 'object' } as const

export const startNodeDefinition: WorkflowNodeDefinition = {
  type: 'core.start',
  version: 1,
  title: 'Start',
  description: 'Validates and exposes workflow inputs.',
  role: 'start',
  configSchema: { type: 'object', additionalProperties: false },
  inputSchema: objectSchema,
  outputSchema: objectSchema,
  outputPorts: ['success'],
  capabilities: [],
  retry: 'safe',
  async execute(context) {
    return { outputs: context.workflowInputs }
  },
}

export const endNodeDefinition: WorkflowNodeDefinition = {
  type: 'core.end',
  version: 1,
  title: 'End',
  description: 'Materializes one terminal workflow output object.',
  role: 'end',
  configSchema: { type: 'object', additionalProperties: false },
  inputSchema: objectSchema,
  outputSchema: objectSchema,
  outputPorts: ['success'],
  capabilities: [],
  retry: 'safe',
  async execute(context) {
    return { outputs: context.inputs }
  },
}

export const conditionNodeDefinition: WorkflowNodeDefinition = {
  type: 'core.condition',
  version: 1,
  title: 'Condition',
  description: 'Selects a true or false edge using a fixed, non-eval operator.',
  configSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['operator'],
    properties: {
      operator: { enum: ['truthy', 'falsy', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte'] },
    },
  },
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['left'],
    properties: { left: {}, right: {} },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['result'],
    properties: { result: { type: 'boolean' } },
  },
  outputPorts: ['true', 'false'],
  requiredOutputPorts: ['true', 'false'],
  capabilities: [],
  retry: 'safe',
  async execute(context) {
    const operator = context.config.operator
    if (typeof operator !== 'string') throw new WorkflowExecutionError('CONDITION_CONFIG', 'condition operator is missing', { nodeId: context.nodeId })
    const result = evaluateCondition(operator, context.inputs.left, context.inputs.right)
    return { outputs: { result }, selectedPorts: [result ? 'true' : 'false'] }
  },
}

export const toolNodeDefinition: WorkflowNodeDefinition = {
  type: 'dsh.tool',
  version: 1,
  title: 'DSH Tool',
  description: 'Executes a tool through the injected DSH tool policy pipeline.',
  configSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['name'],
    properties: { name: { type: 'string', minLength: 1 } },
  },
  inputSchema: objectSchema,
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['result'],
    properties: { result: {} },
  },
  outputPorts: ['success'],
  capabilities: ['dsh.tools.execute'],
  retry: 'never',
  async execute(context) {
    const tools = context.services.tools
    if (tools === undefined) {
      throw new WorkflowExecutionError('TOOL_GATEWAY_MISSING', 'dsh.tool requires a WorkflowToolGateway', { nodeId: context.nodeId })
    }
    const name = context.config.name
    if (typeof name !== 'string') throw new WorkflowExecutionError('TOOL_CONFIG', 'tool name is missing', { nodeId: context.nodeId })
    const value = await tools.execute({
      runId: context.runId,
      nodeId: context.nodeId,
      name,
      input: context.inputs,
      signal: context.signal,
    })
    return { outputs: { result: value } }
  },
}

export function registerCoreNodes(registry: WorkflowNodeRegistry): WorkflowNodeDisposer {
  const disposers = [
    registry.register(startNodeDefinition),
    registry.register(endNodeDefinition),
    registry.register(conditionNodeDefinition),
    registry.register(toolNodeDefinition),
  ]
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    for (const dispose of disposers.reverse()) dispose()
  }
}

function evaluateCondition(operator: string, left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  switch (operator) {
    case 'truthy': return Boolean(left)
    case 'falsy': return !left
    case 'eq': return jsonEquals(left, right)
    case 'neq': return !jsonEquals(left, right)
    case 'gt': return compareNumbers(operator, left, right, (a, b) => a > b)
    case 'gte': return compareNumbers(operator, left, right, (a, b) => a >= b)
    case 'lt': return compareNumbers(operator, left, right, (a, b) => a < b)
    case 'lte': return compareNumbers(operator, left, right, (a, b) => a <= b)
    default: throw new WorkflowExecutionError('CONDITION_OPERATOR', `unsupported condition operator: ${operator}`)
  }
}

function compareNumbers(operator: string, left: JsonValue | undefined, right: JsonValue | undefined, compare: (a: number, b: number) => boolean): boolean {
  if (typeof left !== 'number' || typeof right !== 'number') {
    throw new WorkflowExecutionError('CONDITION_OPERAND', `${operator} requires numeric left and right inputs`)
  }
  return compare(left, right)
}

function jsonEquals(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
