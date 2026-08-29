import type { Context } from '@deepseek-ai/cordis'
import {
  DshDagWorkflowEngineService,
  InMemoryWorkflowRunsService,
  InMemoryWorkflowTemplatesService,
  WorkflowRecoveryCoordinator,
  WorkflowCapabilityRegistryService,
  WorkflowNodeRegistryService,
  WorkflowScriptRuntimeRegistryService,
} from './services.js'
import type { DshWorkflowPluginConfig } from './types.js'
import { WorkflowAuthoringService } from './authoring.js'

export const name = 'agent-dag-workflow'
export const inject = ['tools', 'subagents', 'approval', 'skills']

export async function apply(ctx: Context, config: DshWorkflowPluginConfig = {}): Promise<void> {
  if (ctx.get('workflowCapabilities') === undefined) await ctx.plugin(WorkflowCapabilityRegistryService)
  if (ctx.get('workflowScripts') === undefined) await ctx.plugin(WorkflowScriptRuntimeRegistryService)
  if (ctx.get('workflowNodes') === undefined) await ctx.plugin(WorkflowNodeRegistryService)

  if ((config.catalog ?? 'memory') === 'memory') {
    if (ctx.get('workflowTemplates') === undefined) await ctx.plugin(InMemoryWorkflowTemplatesService)
  } else if (ctx.get('workflowTemplates') === undefined) {
    throw new Error("catalog: 'external' requires a workflowTemplates service to be installed before agent-dag-workflow")
  }

  if ((config.runStore ?? 'memory') === 'memory') {
    if (ctx.get('workflowRuns') === undefined) await ctx.plugin(InMemoryWorkflowRunsService)
  } else if (ctx.get('workflowRuns') === undefined) {
    throw new Error("runStore: 'external' requires a workflowRuns service to be installed before agent-dag-workflow")
  }

  await ctx.plugin(DshDagWorkflowEngineService, config)
  if (config.recovery !== undefined) await ctx.plugin(WorkflowRecoveryCoordinator, config)
  await ctx.plugin(WorkflowAuthoringService)
}

export {
  DshDagWorkflowEngineService,
  DagWorkflowEngineService,
  InMemoryWorkflowRunsService,
  InMemoryWorkflowTemplatesService,
  WorkflowRecoveryCoordinator,
  WorkflowCapabilityRegistryService,
  RepositoryWorkflowTemplatesService,
  WorkflowNodeRegistryService,
  WorkflowScriptRuntimeRegistryService,
  WorkflowRunsService,
  WorkflowTemplatesService,
} from './services.js'
export { recoverPersistedWorkflowRuns } from './services.js'
export { registerWorkflowAuthoring, WorkflowAuthoringService, workflowToolDefinitions } from './authoring.js'
export type * from './types.js'
export { createDshToolGateway } from './tool-gateway.js'
export type { DshToolExecute, DshToolExecutionInput, DshToolExecutionResult } from './tool-gateway.js'
export { SqliteWorkflowRunsService, SqliteWorkflowTemplatesService } from '../../storage/sqlite/cordis.js'
