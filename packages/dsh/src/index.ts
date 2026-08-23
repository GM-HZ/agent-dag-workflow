import type { Context } from '@deepseek-ai/cordis'
import {
  DagWorkflowEngineProvider,
  InMemoryWorkflowRunsProvider,
  InMemoryWorkflowTemplatesProvider,
  WorkflowNodeRegistryService,
} from './services.js'
import type { DshWorkflowPluginConfig } from './types.js'
import { WorkflowAuthoringProvider } from './authoring.js'

export const name = 'dsh-dag-workflow'
export const inject = ['tools', 'subagents', 'approval', 'skills']

export async function apply(ctx: Context, config: DshWorkflowPluginConfig = {}): Promise<void> {
  await ctx.plugin(WorkflowNodeRegistryService)
  if ((config.catalog ?? 'memory') === 'memory') await ctx.plugin(InMemoryWorkflowTemplatesProvider)
  if ((config.runStore ?? 'memory') === 'memory') await ctx.plugin(InMemoryWorkflowRunsProvider)
  await ctx.plugin(DagWorkflowEngineProvider, config)
  await ctx.plugin(WorkflowAuthoringProvider)
}

export {
  DagWorkflowEngineProvider,
  DagWorkflowEngineService,
  InMemoryWorkflowRunsProvider,
  InMemoryWorkflowTemplatesProvider,
  RepositoryWorkflowTemplatesProvider,
  WorkflowNodeRegistryService,
  WorkflowRunsService,
  WorkflowTemplatesService,
} from './services.js'
export { registerWorkflowAuthoring, WorkflowAuthoringProvider, workflowToolDefinitions } from './authoring.js'
export type * from './types.js'
