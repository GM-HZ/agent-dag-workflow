import { WorkflowExecutionError, stableJsonStringify } from '../../core/index.js'
import type {
  DshSubagentActivationRuntimeLike,
  DshSubagentRequest,
  DshSubagentRunLike,
  DshSubagentRuntimeLike,
  DshToolBatchRuntimeLike,
  DshToolRuntimeInput,
  DshToolRuntimeLike,
  DshToolRuntimeResult,
} from './types.js'

export type DshSubagents = DshSubagentRuntimeLike | DshSubagentActivationRuntimeLike

export async function executeDshTool(
  tools: DshToolRuntimeLike | DshToolBatchRuntimeLike,
  input: DshToolRuntimeInput,
): Promise<DshToolRuntimeResult> {
  if (!('setExecutor' in tools)) return tools.execute(input)
  const batch = await tools.execute({
    calls: [{ type: 'tool-call', id: input.callId, name: input.name, arguments: stableJsonStringify(input.arguments) }],
    agent: input.agent,
    signal: input.signal,
  })
  const outcome = batch.results[0]
  if (batch.results.length !== 1 || outcome?.callId !== input.callId) {
    throw new WorkflowExecutionError('DSH_TOOL_FAILED', 'DSH did not return the requested tool outcome')
  }
  return outcome.result
}

function subagentProviders(runtime: DshSubagents) {
  // Managed DSH exposes provider lookup only. Use its built-in fresh-child
  // provider, which starts without the parent's conversation history.
  const listed = 'startActivation' in runtime ? ['spawn'] : runtime.list()
  const names = [...new Set(['spawn', 'general-purpose', ...listed])].filter(name => listed.includes(name))
  return names.flatMap(name => {
    const provider = runtime.getProvider(name)
    if (provider === undefined || provider.inheritsParentContext === true) return []
    const { outputSchema, depthLimit, toolFilter, persona } = provider.capabilities
    return [{ name, outputSchema, depthLimit, toolFilter: 'start' in runtime && toolFilter === true, persona: persona === true }]
  })
}

export function currentAgentCapabilities(runtime: DshSubagents) {
  const providers = subagentProviders(runtime)
  return {
    outputSchema: providers.some(provider => provider.outputSchema),
    depthLimit: providers.some(provider => provider.depthLimit),
    toolFilter: providers.some(provider => provider.toolFilter),
    persona: providers.some(provider => provider.persona),
  }
}

export async function startDshSubagent(
  runtime: DshSubagents,
  request: DshSubagentRequest & { readonly label: string },
  allowedTools: readonly string[] | undefined,
): Promise<DshSubagentRunLike> {
  const provider = selectDshSubagent(runtime, {
    nodeId: request.label,
    outputSchema: request.outputSchema !== undefined,
    depthLimit: request.maxDepth !== undefined,
    toolFilter: allowedTools !== undefined,
  })
  if ('startActivation' in runtime) {
    const activation = await runtime.startActivation({ ...request, provider, delivery: 'caller' })
    return { id: activation.childId, result: activation.result, dispose: () => activation.dispose() }
  }
  return runtime.start(provider, {
    ...request,
    ...(allowedTools === undefined ? {} : { toolFilter: { allow: allowedTools } }),
  })
}

export function selectDshSubagent(runtime: DshSubagents, request: {
  readonly nodeId: string
  readonly outputSchema: boolean
  readonly depthLimit: boolean
  readonly toolFilter: boolean
}): string {
  if ('startActivation' in runtime && request.toolFilter) {
    throw new WorkflowExecutionError('DSH_SUBAGENT_TOOL_FILTER_UNSUPPORTED',
      'This DSH version cannot enforce per-node subagent tool allowlists. Move declared tool calls to tool.call nodes.',
      { nodeId: request.nodeId })
  }
  const provider = subagentProviders(runtime).find(candidate =>
    (!request.outputSchema || candidate.outputSchema)
    && (!request.depthLimit || candidate.depthLimit)
    && (!request.toolFilter || candidate.toolFilter))
  if (provider === undefined) {
    throw new WorkflowExecutionError('AGENT_TARGET_UNAVAILABLE',
      'DSH has no registered subagent target compatible with this workflow node', { nodeId: request.nodeId })
  }
  return provider.name
}
