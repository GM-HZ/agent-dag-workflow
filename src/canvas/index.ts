import type { Context } from '@deepseek-ai/cordis'
import { WorkflowCanvasGateway } from './host.js'
import type { WorkflowCanvasConfig } from './types.js'

export const name = 'dsh-dag-workflow-canvas'
export const inject = ['workflowNodes', 'workflowTemplates', 'workflowRuns', 'dagWorkflowEngine', 'agents']

export async function apply(ctx: Context, config: WorkflowCanvasConfig = {}): Promise<void> {
  await ctx.plugin(WorkflowCanvasGateway, config)
}

export { WorkflowCanvasGateway } from './host.js'
export type * from './types.js'
export default WorkflowCanvasGateway
