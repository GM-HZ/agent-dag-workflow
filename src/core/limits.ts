import type { WorkflowDeploymentLimits, WorkflowPolicies } from './types.js'
import { MAX_WORKFLOW_COMMIT_BYTES } from './run-store.js'

export const MAX_WORKFLOW_CHECKPOINT_BYTES = MAX_WORKFLOW_COMMIT_BYTES - 1024 * 1024

export const DEFAULT_WORKFLOW_DEPLOYMENT_LIMITS: WorkflowDeploymentLimits = Object.freeze({
  maxTemplateBytes: 4 * 1024 * 1024,
  maxInputBytes: 2 * 1024 * 1024,
  maxNodes: 1_000,
  maxEdges: 5_000,
  maxSchemaBytes: 1024 * 1024,
  maxConcurrentNodes: 16,
  maxNodeRuns: 1_000,
  maxDurationMs: 60 * 60_000,
  maxOutputBytes: 8 * 1024 * 1024,
  maxCheckpointBytes: 12 * 1024 * 1024,
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
  if (limits.maxNodes > 10_000) throw new Error('workflow deployment limit maxNodes must be at most 10000')
  if (limits.maxEdges > 50_000) throw new Error('workflow deployment limit maxEdges must be at most 50000')
  if (limits.maxTemplateBytes > MAX_WORKFLOW_COMMIT_BYTES) throw new Error(`workflow deployment limit maxTemplateBytes must be at most ${MAX_WORKFLOW_COMMIT_BYTES}`)
  if (limits.maxInputBytes > MAX_WORKFLOW_COMMIT_BYTES) throw new Error(`workflow deployment limit maxInputBytes must be at most ${MAX_WORKFLOW_COMMIT_BYTES}`)
  if (limits.maxSchemaBytes > 4 * 1024 * 1024) throw new Error('workflow deployment limit maxSchemaBytes must be at most 4194304')
  if (limits.maxCheckpointBytes > MAX_WORKFLOW_CHECKPOINT_BYTES) {
    throw new Error(`workflow deployment limit maxCheckpointBytes must be at most ${MAX_WORKFLOW_CHECKPOINT_BYTES}`)
  }
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
