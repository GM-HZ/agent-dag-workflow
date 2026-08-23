import type { Context } from '@deepseek-ai/cordis'
import {
  DagWorkflowEngineProvider,
  InMemoryWorkflowRunsProvider,
  InMemoryWorkflowTemplatesProvider,
  WorkflowRecoveryCoordinatorProvider,
  WorkflowNodeRegistryService,
} from './services.js'
import type { DshWorkflowPluginConfig } from './types.js'
import { WorkflowAuthoringProvider } from './authoring.js'

export const name = 'dsh-dag-workflow'
export const inject = ['tools', 'subagents', 'approval', 'skills']

export async function apply(ctx: Context, config: DshWorkflowPluginConfig = {}): Promise<void> {
  if (ctx.get('workflowNodes') === undefined) await ctx.plugin(WorkflowNodeRegistryService)

  if ((config.catalog ?? 'memory') === 'memory') {
    if (ctx.get('workflowTemplates') === undefined) await ctx.plugin(InMemoryWorkflowTemplatesProvider)
  } else if (ctx.get('workflowTemplates') === undefined) {
    throw new Error("catalog: 'external' requires a workflowTemplates service to be installed before dsh-dag-workflow")
  }

  if ((config.runStore ?? 'memory') === 'memory') {
    if (ctx.get('workflowRuns') === undefined) await ctx.plugin(InMemoryWorkflowRunsProvider)
  } else if (ctx.get('workflowRuns') === undefined) {
    throw new Error("runStore: 'external' requires a workflowRuns service to be installed before dsh-dag-workflow")
  }

  await ctx.plugin(DagWorkflowEngineProvider, config)
  if (config.recovery !== undefined) await ctx.plugin(WorkflowRecoveryCoordinatorProvider, config)
  await ctx.plugin(WorkflowAuthoringProvider)
}

export {
  DagWorkflowEngineProvider,
  DagWorkflowEngineService,
  InMemoryWorkflowRunsProvider,
  InMemoryWorkflowTemplatesProvider,
  WorkflowRecoveryCoordinatorProvider,
  RepositoryWorkflowTemplatesProvider,
  WorkflowNodeRegistryService,
  WorkflowRunsService,
  WorkflowTemplatesService,
} from './services.js'
export { recoverPersistedWorkflowRuns } from './services.js'
export { registerWorkflowAuthoring, WorkflowAuthoringProvider, workflowToolDefinitions } from './authoring.js'
export type * from './types.js'
