import type { Context } from '@deepseek-ai/cordis'
import { DagWorkflowEngineProvider, InMemoryWorkflowTemplatesProvider, WorkflowNodeRegistryService } from './services.js'
import type { DshWorkflowPluginConfig } from './types.js'

export const name = 'dsh-dag-workflow'
export const inject = ['tools']

export async function apply(ctx: Context, config: DshWorkflowPluginConfig = {}): Promise<void> {
  await ctx.plugin(WorkflowNodeRegistryService)
  if ((config.catalog ?? 'memory') === 'memory') await ctx.plugin(InMemoryWorkflowTemplatesProvider)
  await ctx.plugin(DagWorkflowEngineProvider, config)
}

export {
  DagWorkflowEngineProvider,
  DagWorkflowEngineService,
  InMemoryWorkflowTemplatesProvider,
  RepositoryWorkflowTemplatesProvider,
  WorkflowNodeRegistryService,
  WorkflowTemplatesService,
} from './services.js'
export type * from './types.js'
