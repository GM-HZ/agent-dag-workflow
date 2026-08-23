import type {
  JsonObject,
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
      ...(context.owner === undefined ? {} : { owner: context.owner }),
    })
    return { outputs: { result: value } }
  },
}

export const agentNodeDefinition: WorkflowNodeDefinition = {
  type: 'dsh.agent',
  version: 1,
  title: 'DSH Agent',
  description: 'Runs one foreground child through the injected DSH subagent seam.',
  configSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['provider', 'prompt'],
    properties: {
      provider: { type: 'string', minLength: 1 },
      prompt: { type: 'string', minLength: 1 },
      label: { type: 'string', minLength: 1 },
      outputSchema: { type: 'object' },
      maxDepth: { type: 'integer', minimum: 0 },
    },
  },
  inputSchema: objectSchema,
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['runId', 'content'],
    properties: {
      runId: { type: 'string' },
      content: { type: 'array' },
      structured: {},
    },
  },
  outputPorts: ['success'],
  capabilities: ['dsh.subagents.start'],
  retry: 'never',
  async execute(context) {
    const agents = context.services.agents
    if (agents === undefined) {
      throw new WorkflowExecutionError('AGENT_GATEWAY_MISSING', 'dsh.agent requires a WorkflowAgentGateway', { nodeId: context.nodeId })
    }
    const provider = stringConfig(context.config, 'provider', context.nodeId)
    const prompt = stringConfig(context.config, 'prompt', context.nodeId)
    const label = optionalStringConfig(context.config, 'label', context.nodeId)
    const maxDepth = optionalIntegerConfig(context.config, 'maxDepth', context.nodeId)
    const outputSchema = context.config.outputSchema
    if (outputSchema !== undefined && !isObject(outputSchema)) {
      throw new WorkflowExecutionError('AGENT_CONFIG', 'agent outputSchema must be an object', { nodeId: context.nodeId })
    }
    const result = await agents.execute({
      runId: context.runId,
      nodeId: context.nodeId,
      provider,
      prompt: renderAgentPrompt(prompt, context.inputs),
      signal: context.signal,
      ...(label === undefined ? {} : { label }),
      ...(maxDepth === undefined ? {} : { maxDepth }),
      ...(outputSchema === undefined ? {} : { outputSchema }),
      ...(context.owner === undefined ? {} : { owner: context.owner }),
    })
    return {
      outputs: {
        runId: result.runId,
        content: result.content,
        ...(result.structured === undefined ? {} : { structured: result.structured }),
      },
    }
  },
}

export const humanApprovalNodeDefinition: WorkflowNodeDefinition = {
  type: 'dsh.human-approval',
  version: 1,
  title: 'Human approval',
  description: 'Requests a fail-closed one-shot decision through the DSH approval seam.',
  configSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['action', 'reason'],
    properties: {
      action: { type: 'string', minLength: 1 },
      reason: { type: 'string', minLength: 1 },
    },
  },
  inputSchema: objectSchema,
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['outcome', 'approved', 'token'],
    properties: {
      outcome: { enum: ['allowed-once', 'rejected', 'cancelled', 'unavailable'] },
      approved: { type: 'boolean' },
      token: { type: 'string' },
    },
  },
  outputPorts: ['approved', 'rejected'],
  requiredOutputPorts: ['approved', 'rejected'],
  capabilities: ['dsh.approval.request'],
  retry: 'safe',
  execution: 'human-wait',
  async execute(context) {
    const approvals = context.services.approvals
    if (approvals === undefined) {
      throw new WorkflowExecutionError('APPROVAL_GATEWAY_MISSING', 'dsh.human-approval requires a WorkflowApprovalGateway', { nodeId: context.nodeId })
    }
    const action = stringConfig(context.config, 'action', context.nodeId)
    const reason = stringConfig(context.config, 'reason', context.nodeId)
    const token = `${context.runId}:${context.nodeId}:approval`
    const outcome = await approvals.request({
      runId: context.runId,
      nodeId: context.nodeId,
      token,
      action,
      reason,
      details: context.inputs,
      signal: context.signal,
      ...(context.owner === undefined ? {} : { owner: context.owner }),
    })
    const approved = outcome === 'allowed-once'
    return { outputs: { outcome, approved, token }, selectedPorts: [approved ? 'approved' : 'rejected'] }
  },
}

export function registerCoreNodes(registry: WorkflowNodeRegistry): WorkflowNodeDisposer {
  const disposers = [
    registry.register(startNodeDefinition),
    registry.register(endNodeDefinition),
    registry.register(conditionNodeDefinition),
    registry.register(toolNodeDefinition),
    registry.register(agentNodeDefinition),
    registry.register(humanApprovalNodeDefinition),
  ]
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    for (const dispose of disposers.reverse()) dispose()
  }
}

function renderAgentPrompt(prompt: string, inputs: JsonObject): string {
  const keys = Object.keys(inputs)
  if (keys.length === 0) return prompt
  return `${prompt}\n\nWorkflow node inputs (JSON):\n${JSON.stringify(inputs)}`
}

function stringConfig(config: JsonObject, name: string, nodeId: string): string {
  const value = config[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new WorkflowExecutionError('NODE_CONFIG', `${name} must be a non-empty string`, { nodeId })
  }
  return value
}

function optionalStringConfig(config: JsonObject, name: string, nodeId: string): string | undefined {
  const value = config[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new WorkflowExecutionError('NODE_CONFIG', `${name} must be a non-empty string`, { nodeId })
  }
  return value
}

function optionalIntegerConfig(config: JsonObject, name: string, nodeId: string): number | undefined {
  const value = config[name]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new WorkflowExecutionError('NODE_CONFIG', `${name} must be a non-negative safe integer`, { nodeId })
  }
  return value
}

function isObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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
