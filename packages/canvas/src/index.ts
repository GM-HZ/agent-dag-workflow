import type { Context } from '@deepseek-ai/cordis'
import { WorkflowCanvasGateway } from './host.js'
import type { WorkflowCanvasConfig } from './types.js'

export const name = 'dsh-workflow-canvas'
export const inject = ['workflowNodes', 'workflowTemplates', 'workflowRuns', 'dagWorkflowEngine']

export async function apply(ctx: Context, config: WorkflowCanvasConfig): Promise<void> {
  if (config === undefined || typeof config.authorize !== 'function') {
    throw new Error('dsh-workflow-canvas requires a fail-closed authorize(request) function')
  }
  await ctx.plugin(WorkflowCanvasGateway, config)
}

export { WorkflowCanvasGateway } from './host.js'
export type * from './types.js'
export default WorkflowCanvasGateway
