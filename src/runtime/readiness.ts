import {
  effectiveWorkflowPolicies,
  isJsonObject,
  snapshotJsonObject,
  stableJsonStringify,
  type CompiledWorkflow,
  type CompiledWorkflowNode,
  type JsonObject,
  type WorkflowCompileResult,
  type WorkflowDeploymentLimits,
  type WorkflowDiagnostic,
  type WorkflowEngineServices,
  type WorkflowNodeTemplate,
} from '../core/index.js'
import { resolveWorkflowBindings } from '../core/bindings.js'
import { publishedWorkflowDependency, qualifyDependencyDiagnostic, type PublishedWorkflowDependency } from '../core/dependencies.js'
import type { WorkflowValidationContext } from './types.js'

type InvocationReadiness = 'mandatory' | 'possible' | 'skipped'

interface ReadinessOptions {
  readonly services: WorkflowEngineServices
  readonly deploymentLimits: WorkflowDeploymentLimits
  readonly loadDependency: (dependency: PublishedWorkflowDependency) => Promise<WorkflowCompileResult>
  readonly checkNode: ((node: WorkflowNodeTemplate, authority: unknown) => WorkflowDiagnostic | undefined) | undefined
}

export async function checkWorkflowReadiness(
  workflow: CompiledWorkflow,
  context: WorkflowValidationContext,
  options: ReadinessOptions,
): Promise<readonly WorkflowDiagnostic[]> {
  const diagnostics: WorkflowDiagnostic[] = []
  let workflowInputs: JsonObject | undefined
  try {
    workflowInputs = snapshotJsonObject(context.inputs)
    diagnostics.push(...inputDiagnostics(workflow, workflowInputs, options.deploymentLimits.maxInputBytes))
    if (diagnostics.length > 0) workflowInputs = undefined
  } catch (error: unknown) {
    workflowInputs = undefined
    diagnostics.push({ severity: 'error', code: 'WORKFLOW_INPUT_INVALID', message: error instanceof Error ? error.message : 'Run input must be a JSON object.' })
  }

  let tools: Promise<ReadonlySet<string> | undefined> | undefined
  const loadResults = new Map<string, Promise<WorkflowCompileResult>>()
  const nodeChecks = new Map<CompiledWorkflowNode, WorkflowDiagnostic | undefined>()
  await visit(workflow, workflowInputs, 'mandatory', options.deploymentLimits.subworkflowMaxDepth, [])
  return diagnostics

  async function visit(
    current: CompiledWorkflow, inputs: JsonObject | undefined, invocation: InvocationReadiness,
    depthLimit: number, path: readonly PublishedWorkflowDependency[],
  ): Promise<void> {
    const localLimit = Math.min(depthLimit, effectiveWorkflowPolicies(current.template.spec.policies, options.deploymentLimits).subworkflowMaxDepth)
    const startNodeId = current.nodes.get(current.startNodeId)?.template.uses === 'core.start@1' ? current.startNodeId : undefined
    if (path.length > 0 && invocation !== 'skipped' && inputs !== undefined) {
      for (const issue of inputDiagnostics(current, inputs, options.deploymentLimits.maxInputBytes)) {
        diagnostics.push(qualifyDependencyDiagnostic({
          ...issue, code: issue.code === 'WORKFLOW_INPUT_TOO_LARGE' ? 'SUBWORKFLOW_INPUT_TOO_LARGE' : 'SUBWORKFLOW_INPUT_INVALID',
          severity: invocation === 'mandatory' ? issue.severity : 'warning',
        }, path))
      }
    }
    for (const nodeId of current.order) {
      const node = current.nodes.get(nodeId)!
      const activation = invocation === 'mandatory' && !current.guaranteedNodes.has(nodeId) ? 'possible' : invocation
      if (activation !== 'skipped') {
        if (!nodeChecks.has(node)) {
          const names = node.template.uses === 'tool.call@1' && options.services.tools !== undefined
            ? await (tools ??= visibleTools(options.services, context.authority)) : undefined
          nodeChecks.set(node, checkBuiltIn(node.template, options.services, names) ?? options.checkNode?.(node.template, context.authority))
        }
        const issue = nodeChecks.get(node)
        if (issue !== undefined) diagnostics.push(qualifyDependencyDiagnostic({
          ...issue, nodeId, severity: activation === 'mandatory' ? issue.severity : 'warning',
        }, path))
      }
      const dependency = publishedWorkflowDependency(node.template)
      if (dependency === undefined) continue
      const childPath = [...path, dependency]
      const key = `${dependency.id}@${dependency.revision}`
      if (path.some(parent => parent.id === dependency.id && parent.revision === dependency.revision)) {
        diagnostics.push(qualifyDependencyDiagnostic({ code: 'SUBWORKFLOW_DEPENDENCY_CYCLE', severity: 'error', message: `published dependency cycle reaches ${key}` }, childPath))
        continue
      }
      let lookup = loadResults.get(key)
      if (lookup === undefined) {
        lookup = options.loadDependency(dependency)
        loadResults.set(key, lookup)
      }
      // Launch compiles every pinned revision, even one in a skipped branch.
      const child = await lookup
      for (const issue of child.diagnostics) diagnostics.push(qualifyDependencyDiagnostic(issue, childPath))
      if (child.workflow === undefined) continue
      if (childPath.length > localLimit && activation !== 'skipped') {
        diagnostics.push(qualifyDependencyDiagnostic({
          code: 'SUBWORKFLOW_DEPTH_EXCEEDED', severity: activation === 'mandatory' ? 'error' : 'warning',
          message: `dependency reaches depth ${childPath.length}, limit is ${localLimit}`,
        }, childPath))
      }
      const next = childInvocation(node.template, inputs, startNodeId, childPath.length > localLimit ? 'skipped' : activation)
      await visit(child.workflow, next.inputs, next.activation, localLimit, childPath)
    }
  }
}

function inputDiagnostics(workflow: CompiledWorkflow, inputs: JsonObject, maxBytes: number): readonly WorkflowDiagnostic[] {
  const bytes = Buffer.byteLength(stableJsonStringify(inputs), 'utf8')
  if (bytes > maxBytes) {
    return [{ severity: 'error', code: 'WORKFLOW_INPUT_TOO_LARGE', message: `Run input is ${bytes} bytes. The deployment limit is ${maxBytes} bytes.` }]
  }
  return workflow.validateWorkflowInputs(inputs).map(message => ({ severity: 'error', code: 'WORKFLOW_INPUT_INVALID', message }))
}

function childInvocation(node: WorkflowNodeTemplate, inputs: JsonObject | undefined, startNodeId: string | undefined, activation: InvocationReadiness): {
  readonly activation: InvocationReadiness
  readonly inputs?: JsonObject
} {
  if (activation === 'skipped') return { activation }
  if (node.uses === 'workflow.call@1') {
    const bound = knownBindings(node.inputs, inputs, startNodeId)
    return { activation, ...(bound === undefined ? {} : { inputs: bound }) }
  }

  const binding = node.inputs.items
  const items = binding === undefined ? undefined : knownBindings({ items: binding }, inputs, startNodeId)?.items
  if (!Array.isArray(items)) return { activation: 'possible' }
  if (items.length === 0) return { activation: 'skipped' }
  // For multiple items the mapping proves that the body is invoked. Nested
  // values can vary by item, so deeper data-dependent fan-out stays possible.
  if (items.length !== 1) return { activation }
  const shared = node.inputs.shared
  const value = shared === undefined ? {} : knownBindings({ shared }, inputs, startNodeId)?.shared
  return { activation, ...(isJsonObject(value) ? { inputs: { item: items[0]!, index: 0, shared: value } } : {}) }
}

function knownBindings(bindings: WorkflowNodeTemplate['inputs'], inputs: JsonObject | undefined, startNodeId: string | undefined): JsonObject | undefined {
  if (inputs === undefined && Object.values(bindings).some(binding => !('literal' in binding))) return undefined
  try { return resolveWorkflowBindings(bindings, inputs ?? {}, id => id === startNodeId ? inputs : undefined) }
  catch { return undefined }
}

async function visibleTools(services: WorkflowEngineServices, authority: unknown): Promise<ReadonlySet<string> | undefined> {
  try {
    const tools = await services.tools?.list?.(authority)
    return tools === undefined ? undefined : new Set(tools.map(tool => tool.uses))
  } catch {
    // Discovery unavailable is not a verdict from the host's execution policy.
    return undefined
  }
}

function checkBuiltIn(node: WorkflowNodeTemplate, services: WorkflowEngineServices, tools: ReadonlySet<string> | undefined): WorkflowDiagnostic | undefined {
  switch (node.uses) {
    case 'tool.call@1': {
      if (services.tools === undefined) return missingGateway('TOOL_GATEWAY_MISSING', 'Tool')
      const uses = node.with.uses
      if (typeof uses !== 'string') return undefined
      if (tools === undefined) return {
        code: 'WORKFLOW_TOOL_VISIBILITY_UNKNOWN', severity: 'warning',
        message: `This host did not provide a tool catalog. Availability of ${uses} will be checked during execution.`,
      }
      return tools.has(uses) ? undefined : {
        code: 'WORKFLOW_TOOL_UNAVAILABLE', severity: 'error',
        message: `Tool ${uses} is not visible to this caller. Check the active host, tool name, and permissions.`,
      }
    }
    case 'agent.run@1': return services.agents === undefined ? missingGateway('AGENT_GATEWAY_MISSING', 'Agent') : undefined
    case 'human.approval@1': return services.approvals === undefined ? missingGateway('APPROVAL_GATEWAY_MISSING', 'approval') : undefined
    default: return undefined
  }
}

function missingGateway(code: string, name: string): WorkflowDiagnostic {
  return { code, severity: 'error', message: `The current host does not provide the ${name} gateway required by this node.` }
}
