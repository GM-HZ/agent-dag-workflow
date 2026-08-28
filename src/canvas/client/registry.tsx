import type { ComponentType } from 'react'
import type { WorkflowFlowNodeData } from './model.js'

export interface WorkflowNodeRendererProps {
  readonly data: WorkflowFlowNodeData
  readonly selected: boolean
}

export type WorkflowNodeRenderer = ComponentType<WorkflowNodeRendererProps>

export class WorkflowNodeRendererRegistry {
  private readonly renderers = new Map<string, WorkflowNodeRenderer>()

  register(uses: string, renderer: WorkflowNodeRenderer): () => void {
    if (this.renderers.has(uses)) throw new Error(`workflow canvas renderer already registered: ${uses}`)
    this.renderers.set(uses, renderer)
    return () => { if (this.renderers.get(uses) === renderer) this.renderers.delete(uses) }
  }

  resolve(uses: string): WorkflowNodeRenderer | undefined { return this.renderers.get(uses) }
}

export const workflowNodeRenderers = new WorkflowNodeRendererRegistry()
