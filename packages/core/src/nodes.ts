import type {
  JsonObject,
  JsonValue,
  WorkflowNodeDefinition,
} from './types.js'
import type { WorkflowNodeDisposer, WorkflowNodeRegistry } from './registry.js'
import { createDefaultWorkflowScriptRuntimeRegistry, type WorkflowScriptRuntimeRegistry } from './script-runtime.js'
import { WorkflowExecutionError } from './errors.js'
import { stableJsonStringify } from './json.js'
import { validateDshObjectJsonSchema } from './dsh-schema.js'

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
  defaultConfig: { operator: 'truthy' },
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

const defaultScriptRuntimes = createDefaultWorkflowScriptRuntimeRegistry()

export function createScriptNodeDefinition(runtimes: WorkflowScriptRuntimeRegistry): WorkflowNodeDefinition {
  return {
    type: 'core.script',
    version: 1,
    title: 'Deterministic script',
    description: 'Transforms JSON with a bounded, plugin-provided deterministic script runtime; I/O must use DSH tools.',
    configSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['language', 'source'],
      properties: {
        language: { type: 'string', pattern: '^[a-z][a-z0-9.-]*@[1-9][0-9]*$' },
        source: {
          type: 'string',
          minLength: 1,
          maxLength: 32768,
          'x-dsh-editor': 'multiline',
          description: 'A pure expression that must return one JSON object. The input object is available as `input`.',
        },
        maxOperations: {
          type: 'integer',
          minimum: 1,
          maximum: 100000,
          description: 'Maximum parser/evaluator operations for one node execution.',
        },
      },
    },
    defaultConfig: {
      language: 'dsh.expr@1',
      source: '{ result: input }',
      maxOperations: 10000,
    },
    inputSchema: objectSchema,
    outputSchema: objectSchema,
    outputPorts: ['success'],
    capabilities: ['workflow.script.execute'],
    dependencyKinds: ['script-runtime'],
    retry: 'safe',
    dependencies(config) {
      return typeof config.language === 'string' ? [{ kind: 'script-runtime', uses: config.language }] : []
    },
    validateConfig(config) {
      const language = config.language
      const source = config.source
      if (typeof language !== 'string' || typeof source !== 'string') return []
      const runtime = runtimes.resolve(language)
      if (runtime === undefined) return [`script runtime is not registered: ${language}`]
      return runtime.validate(source)
    },
    async execute(context) {
      const language = stringConfig(context.config, 'language', context.nodeId)
      const source = stringConfig(context.config, 'source', context.nodeId)
      const maxOperations = optionalIntegerConfig(context.config, 'maxOperations', context.nodeId) ?? 10000
      const runtime = runtimes.resolve(language)
      if (runtime === undefined) {
        throw new WorkflowExecutionError('SCRIPT_RUNTIME_MISSING', `script runtime is not registered: ${language}`, { nodeId: context.nodeId })
      }
      return {
        outputs: await runtime.execute({
          source,
          inputs: context.inputs,
          signal: context.signal,
          maxOperations,
        }),
      }
    },
  }
}

export const scriptNodeDefinition = createScriptNodeDefinition(defaultScriptRuntimes)

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
  dependencyKinds: ['tool'],
  retry: 'never',
  dependencies(config) {
    return typeof config.name === 'string' ? [{ kind: 'tool', uses: config.name }] : []
  },
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
  dependencyKinds: ['agent-provider'],
  retry: 'never',
  dependencies(config) {
    return typeof config.provider === 'string' ? [{ kind: 'agent-provider', uses: config.provider }] : []
  },
  validateConfig(config) {
    return config.outputSchema === undefined ? [] : validateDshObjectJsonSchema(config.outputSchema)
  },
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
  dependencyKinds: ['approval-action'],
  retry: 'safe',
  execution: 'human-wait',
  dependencies(config) {
    return typeof config.action === 'string' ? [{ kind: 'approval-action', uses: config.action }] : []
  },
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

export const subworkflowNodeDefinition: WorkflowNodeDefinition = {
  type: 'core.subworkflow',
  version: 1,
  title: 'Subworkflow',
  description: 'Runs one fixed published workflow revision as a durable child invocation.',
  configSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['templateId', 'revision'],
    properties: {
      templateId: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' },
      revision: { type: 'integer', minimum: 1 },
    },
  },
  inputSchema: objectSchema,
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['runId', 'outputs'],
    properties: { runId: { type: 'string' }, outputs: { type: 'object' } },
  },
  outputPorts: ['success'],
  capabilities: ['workflowTemplates.getPublished', 'dagWorkflowEngine.invoke'],
  dependencyKinds: ['workflow'],
  retry: 'safe',
  dependencies(config) {
    return subworkflowDependency(config)
  },
  async execute(context) {
    const subworkflows = requireSubworkflows(context.services.subworkflows, context.nodeId)
    const target = subworkflowTarget(context.config, context.nodeId)
    const depth = nextSubworkflowDepth(context.depth, context.subworkflowMaxDepth, context.nodeId)
    const result = await subworkflows.execute({
      parentRunId: context.runId,
      nodeId: context.nodeId,
      invocationId: `${context.runId}:${context.nodeId}:subworkflow`,
      templateId: target.templateId,
      revision: target.revision,
      inputs: context.inputs,
      depth,
      depthLimit: context.subworkflowMaxDepth,
      signal: context.signal,
      ...(context.owner === undefined ? {} : { owner: context.owner }),
    })
    return { outputs: { runId: result.runId, outputs: result.outputs } }
  },
}

export const foreachNodeDefinition: WorkflowNodeDefinition = {
  type: 'core.foreach',
  version: 1,
  title: 'For each',
  description: 'Runs a fixed published workflow revision once per item using durable container frames.',
  configSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['templateId', 'revision'],
    properties: {
      templateId: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' },
      revision: { type: 'integer', minimum: 1 },
      maxConcurrency: { type: 'integer', minimum: 1, maximum: 64 },
      maxItems: { type: 'integer', minimum: 0, maximum: 10000 },
    },
  },
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: { items: { type: 'array' }, shared: { type: 'object' } },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['results'],
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['index', 'runId', 'outputs'],
          properties: { index: { type: 'integer' }, runId: { type: 'string' }, outputs: { type: 'object' } },
        },
      },
    },
  },
  outputPorts: ['success'],
  capabilities: ['workflowTemplates.getPublished', 'dagWorkflowEngine.invoke'],
  dependencyKinds: ['workflow'],
  retry: 'safe',
  dependencies(config) {
    return subworkflowDependency(config)
  },
  async execute(context) {
    const subworkflows = requireSubworkflows(context.services.subworkflows, context.nodeId)
    const target = subworkflowTarget(context.config, context.nodeId)
    const depth = nextSubworkflowDepth(context.depth, context.subworkflowMaxDepth, context.nodeId)
    const items = context.inputs.items
    if (!Array.isArray(items)) throw new WorkflowExecutionError('FOREACH_INPUT', 'foreach items must be an array', { nodeId: context.nodeId })
    const sharedValue = context.inputs.shared ?? {}
    if (!isObject(sharedValue)) throw new WorkflowExecutionError('FOREACH_INPUT', 'foreach shared must be an object', { nodeId: context.nodeId })
    const maxItems = optionalIntegerConfig(context.config, 'maxItems', context.nodeId) ?? 100
    if (items.length > maxItems) {
      throw new WorkflowExecutionError('FOREACH_ITEM_LIMIT', `foreach received ${items.length} items, limit is ${maxItems}`, { nodeId: context.nodeId })
    }
    const concurrency = Math.min(optionalIntegerConfig(context.config, 'maxConcurrency', context.nodeId) ?? 4, Math.max(1, items.length))
    const frames = restoreForEachFrames(context.progress, items.length, context.nodeId)
    checkpointFrames()
    let cursor = 0
    let firstError: unknown
    const stop = new AbortController()
    const signal = AbortSignal.any([context.signal, stop.signal])
    const workers = Array.from({ length: concurrency }, async () => {
      while (!signal.aborted) {
        let index = cursor++
        while (index < frames.length && frames[index]!.status === 'completed') index = cursor++
        if (index >= frames.length) return
        frames[index] = { index, status: 'running' }
        checkpointFrames()
        try {
          const result = await subworkflows.execute({
            parentRunId: context.runId,
            nodeId: context.nodeId,
            invocationId: `${context.runId}:${context.nodeId}:item:${index}`,
            templateId: target.templateId,
            revision: target.revision,
            inputs: { item: items[index]!, index, shared: sharedValue },
            depth,
            depthLimit: context.subworkflowMaxDepth,
            signal,
            ...(context.owner === undefined ? {} : { owner: context.owner }),
          })
          frames[index] = { index, status: 'completed', runId: result.runId, outputs: result.outputs }
          checkpointFrames()
        } catch (error: unknown) {
          firstError ??= error
          stop.abort('foreach child failed')
          return
        }
      }
    })
    await Promise.allSettled(workers)
    if (firstError !== undefined) throw firstError
    if (context.signal.aborted) throw new WorkflowExecutionError('WORKFLOW_CANCELLED', 'foreach was cancelled', { nodeId: context.nodeId })
    return {
      outputs: {
        results: frames.map(frame => {
          if (frame.status !== 'completed') throw new WorkflowExecutionError('FOREACH_FRAME_INVALID', `foreach item ${frame.index} did not complete`, { nodeId: context.nodeId })
          return { index: frame.index, runId: frame.runId, outputs: frame.outputs }
        }),
      },
    }

    function checkpointFrames(): void {
      context.checkpointProgress({ version: 1, kind: 'foreach', items: frames })
    }
  },
}

export function registerCoreNodes(
  registry: WorkflowNodeRegistry,
  options: { readonly scriptRuntimes?: WorkflowScriptRuntimeRegistry } = {},
): WorkflowNodeDisposer {
  const disposers = [
    registry.register(startNodeDefinition),
    registry.register(endNodeDefinition),
    registry.register(conditionNodeDefinition),
    registry.register(options.scriptRuntimes === undefined ? scriptNodeDefinition : createScriptNodeDefinition(options.scriptRuntimes)),
    registry.register(toolNodeDefinition),
    registry.register(agentNodeDefinition),
    registry.register(humanApprovalNodeDefinition),
    registry.register(subworkflowNodeDefinition),
    registry.register(foreachNodeDefinition),
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
  return `${prompt}\n\nWorkflow node inputs (JSON):\n${stableJsonStringify(inputs)}`
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

function requireSubworkflows(value: import('./types.js').WorkflowSubworkflowGateway | undefined, nodeId: string): import('./types.js').WorkflowSubworkflowGateway {
  if (value === undefined) throw new WorkflowExecutionError('SUBWORKFLOW_GATEWAY_MISSING', 'nested workflow node requires a WorkflowSubworkflowGateway', { nodeId })
  return value
}

function subworkflowTarget(config: JsonObject, nodeId: string): { readonly templateId: string; readonly revision: number } {
  const templateId = stringConfig(config, 'templateId', nodeId)
  const revision = optionalIntegerConfig(config, 'revision', nodeId)
  if (revision === undefined || revision < 1) throw new WorkflowExecutionError('SUBWORKFLOW_CONFIG', 'revision must be a positive safe integer', { nodeId })
  return { templateId, revision }
}

function subworkflowDependency(config: JsonObject): readonly import('./types.js').WorkflowRequirement[] {
  const templateId = config.templateId
  const revision = config.revision
  return typeof templateId === 'string' && typeof revision === 'number' && Number.isSafeInteger(revision) && revision > 0
    ? [{ kind: 'workflow', uses: `${templateId}@${revision}` }]
    : []
}

function nextSubworkflowDepth(depth: number, maxDepth: number, nodeId: string): number {
  const next = depth + 1
  if (next > maxDepth) throw new WorkflowExecutionError('SUBWORKFLOW_DEPTH_EXCEEDED', `subworkflow depth ${next} exceeds limit ${maxDepth}`, { nodeId })
  return next
}

type ForEachFrame =
  | { readonly index: number; readonly status: 'pending' | 'running' }
  | { readonly index: number; readonly status: 'completed'; readonly runId: string; readonly outputs: JsonObject }

function restoreForEachFrames(progress: JsonValue | undefined, itemCount: number, nodeId: string): ForEachFrame[] {
  if (progress === undefined) return Array.from({ length: itemCount }, (_, index) => ({ index, status: 'pending' as const }))
  if (!isObject(progress) || progress.version !== 1 || progress.kind !== 'foreach' || !Array.isArray(progress.items) || progress.items.length !== itemCount) {
    throw new WorkflowExecutionError('FOREACH_FRAME_INVALID', 'persisted foreach frame has an invalid envelope or item count', { nodeId })
  }
  return progress.items.map((value, index): ForEachFrame => {
    if (!isObject(value) || value.index !== index || (value.status !== 'pending' && value.status !== 'running' && value.status !== 'completed')) {
      throw new WorkflowExecutionError('FOREACH_FRAME_INVALID', `persisted foreach item ${index} is invalid`, { nodeId })
    }
    if (value.status !== 'completed') return { index, status: value.status }
    if (typeof value.runId !== 'string' || value.outputs === undefined || !isObject(value.outputs)) {
      throw new WorkflowExecutionError('FOREACH_FRAME_INVALID', `persisted foreach item ${index} result is invalid`, { nodeId })
    }
    return { index, status: 'completed', runId: value.runId, outputs: value.outputs }
  })
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
