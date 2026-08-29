import workflowCanvasRemote from '@gm-hz/agent-dag-workflow/remote'
import type { WorkflowCanvasRemoteNamespace } from './api.js'
import { WorkflowCanvasUiController } from './controller.js'
import { WorkflowCanvasOverlay, type SnapshotStore } from './overlay.js'

export { createWorkflowCanvasApi } from './api.js'
export type { WorkflowCanvasClientApi, WorkflowCanvasRemoteNamespace } from './api.js'
export * from './model.js'
export { WorkflowCanvasUiController } from './controller.js'
export type { WorkflowCanvasUiSnapshot, WorkflowCanvasUiTarget } from './controller.js'
export { WorkflowCanvasOverlay } from './overlay.js'
export type { SnapshotStore, WorkflowCanvasOverlayProps } from './overlay.js'
export { WorkflowNodeRendererRegistry, workflowNodeRenderers } from './registry.js'
export type { WorkflowNodeRenderer, WorkflowNodeRendererProps } from './registry.js'
export { WorkflowStudio } from './studio.js'
export type { WorkflowStudioProps } from './studio.js'

interface ClientRemote {
  readonly workflowCanvas: WorkflowCanvasRemoteNamespace
  $mount(contribution: unknown): Promise<() => Promise<void>>
}

interface ClientSlots {
  inject(name: 'shell.overlay', callback: () => void): void
  register(options: {
    readonly name: 'shell.overlay'
    readonly id: string
    readonly order: number
    readonly label: string
    readonly inject: () => {
      readonly remote: WorkflowCanvasRemoteNamespace
      readonly sessions: SnapshotStore<{ readonly current?: string }>
      readonly controller: WorkflowCanvasUiController
    }
  }, component: typeof WorkflowCanvasOverlay): () => void
}

interface WorkflowCanvasClientContext {
  readonly remote: ClientRemote
  readonly slots: ClientSlots
  readonly sessions: { readonly list: SnapshotStore<{ readonly current?: string }> }
  readonly reflect: { provide(name: string, value: unknown): Promise<void> | (() => Promise<void>) }
  effect(effect: () => (() => void) | Promise<() => Promise<void>>, label: string): void
  inject(
    services: readonly string[],
    callback: (scope: WorkflowCanvasClientContext) => void,
  ): unknown
}

export const name = 'agent-dag-workflow-canvas-client'
export const inject = ['slots', 'sessions', 'remote']

export async function apply(ctx: WorkflowCanvasClientContext): Promise<void> {
  const controller = new WorkflowCanvasUiController()
  ctx.effect(() => {
    const disposal = ctx.reflect.provide('workflowCanvasUi', controller)
    return () => { if (typeof disposal === 'function') void disposal() }
  }, 'agent-dag-workflow-canvas: UI controller')
  await ctx.remote.$mount(workflowCanvasRemote)
  ctx.inject(['slots', 'sessions', 'remote.workflowCanvas'], (scope) => {
    scope.slots.inject('shell.overlay', () => scope.slots.register({
      name: 'shell.overlay',
      id: 'agent-dag-workflow-canvas',
      order: 80,
      label: 'Agent DAG Workflow',
      inject: () => ({ remote: scope.remote.workflowCanvas, sessions: scope.sessions.list, controller }),
    }, WorkflowCanvasOverlay))
  })
}

export default { name, inject, apply }
