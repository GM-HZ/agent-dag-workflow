import type { WorkflowDeploymentLimits, WorkflowPolicies } from './types.js'

export const DEFAULT_WORKFLOW_DEPLOYMENT_LIMITS: WorkflowDeploymentLimits = Object.freeze({
  maxConcurrentNodes: 16,
  maxNodeRuns: 1_000,
  maxDurationMs: 60 * 60_000,
  maxOutputBytes: 8 * 1024 * 1024,
  subworkflowMaxDepth: 16,
})

export const DEFAULT_WORKFLOW_POLICIES: Required<WorkflowPolicies> = Object.freeze({
  maxConcurrentNodes: 4,
  maxNodeRuns: 100,
  maxDurationMs: 10 * 60_000,
  maxOutputBytes: 1024 * 1024,
  subworkflowMaxDepth: 8,
})

export function normalizeWorkflowDeploymentLimits(
  overrides: Partial<WorkflowDeploymentLimits> = {},
): WorkflowDeploymentLimits {
  const limits = { ...DEFAULT_WORKFLOW_DEPLOYMENT_LIMITS, ...overrides }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`workflow deployment limit ${name} must be a positive safe integer`)
  }
  if (limits.maxConcurrentNodes > 64) throw new Error('workflow deployment limit maxConcurrentNodes must be at most 64')
  return Object.freeze(limits)
}

export function effectiveWorkflowPolicies(
  authored: WorkflowPolicies | undefined,
  limits: WorkflowDeploymentLimits,
): Required<WorkflowPolicies> {
  return Object.freeze({
    maxConcurrentNodes: Math.min(authored?.maxConcurrentNodes ?? DEFAULT_WORKFLOW_POLICIES.maxConcurrentNodes, limits.maxConcurrentNodes),
    maxNodeRuns: Math.min(authored?.maxNodeRuns ?? DEFAULT_WORKFLOW_POLICIES.maxNodeRuns, limits.maxNodeRuns),
    maxDurationMs: Math.min(authored?.maxDurationMs ?? DEFAULT_WORKFLOW_POLICIES.maxDurationMs, limits.maxDurationMs),
    maxOutputBytes: Math.min(authored?.maxOutputBytes ?? DEFAULT_WORKFLOW_POLICIES.maxOutputBytes, limits.maxOutputBytes),
    subworkflowMaxDepth: Math.min(authored?.subworkflowMaxDepth ?? DEFAULT_WORKFLOW_POLICIES.subworkflowMaxDepth, limits.subworkflowMaxDepth),
  })
}
