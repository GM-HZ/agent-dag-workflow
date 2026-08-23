import type { Context } from '@deepseek-ai/cordis'
import { DagWorkflowEngineProvider, WorkflowNodeRegistryService } from './services.js'
import type { DshWorkflowPluginConfig } from './types.js'

export const name = 'dsh-dag-workflow'
export const inject = ['tools']

export async function apply(ctx: Context, config: DshWorkflowPluginConfig = {}): Promise<void> {
  await ctx.plugin(WorkflowNodeRegistryService)
  await ctx.plugin(DagWorkflowEngineProvider, config)
}

export { DagWorkflowEngineProvider, DagWorkflowEngineService, WorkflowNodeRegistryService } from './services.js'
export type * from './types.js'
