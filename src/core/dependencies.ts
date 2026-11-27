import type { WorkflowDiagnostic, WorkflowNodeTemplate } from './types.js'

export interface PublishedWorkflowDependency {
  readonly nodeId: string
  readonly id: string
  readonly revision: number
}

export function publishedWorkflowDependency(node: WorkflowNodeTemplate): PublishedWorkflowDependency | undefined {
  if (node.uses !== 'workflow.call@1' && node.uses !== 'core.foreach@1') return undefined
  const { templateId, revision } = node.with
  if (typeof templateId !== 'string' || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) return undefined
  return { nodeId: node.id, id: templateId, revision }
}

export function qualifyDependencyDiagnostic(
  diagnostic: WorkflowDiagnostic, dependencies: readonly PublishedWorkflowDependency[],
): WorkflowDiagnostic {
  const first = dependencies[0]
  if (first === undefined) return diagnostic
  const route = dependencies.map(dependency => ({ nodeId: dependency.nodeId, ref: `${dependency.id}@${dependency.revision}` }))
  const location = route.flatMap(({ nodeId, ref }) => [nodeId, ref])
  if (diagnostic.nodeId !== undefined) location.push(diagnostic.nodeId)
  return {
    ...diagnostic,
    nodeId: first.nodeId,
    path: [
      ...route.flatMap(({ nodeId, ref }) => ['dependencies', nodeId, ref]),
      ...(diagnostic.nodeId === undefined ? [] : ['nodes', diagnostic.nodeId]),
      ...(diagnostic.path ?? []),
    ],
    message: `${location.join(' → ')}. ${diagnostic.message}`,
  }
}
