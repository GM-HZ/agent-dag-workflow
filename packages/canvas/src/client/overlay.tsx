import { useMemo, useRef, useSyncExternalStore } from 'react'
import { createWorkflowCanvasApi, type WorkflowCanvasRemoteNamespace } from './api.js'
import type { WorkflowCanvasUiController } from './controller.js'
import { WorkflowStudio } from './studio.js'

export interface SnapshotStore<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

export interface WorkflowCanvasOverlayProps {
  readonly remote: WorkflowCanvasRemoteNamespace
  readonly sessions: SnapshotStore<{ readonly current?: string }>
  readonly controller: WorkflowCanvasUiController
}

/**
 * Keep the authority session that opened Studio stable for the lifetime of the
 * overlay. Starting a DSH Agent temporarily changes `sessions.current` to the
 * child session; following that value would make in-flight Canvas RPCs switch
 * principal (and the fail-closed host correctly rejects the child session).
 */
export function retainWorkflowCanvasSession(
  open: boolean,
  current: string | undefined,
  retained: string | undefined,
): string | undefined {
  if (!open) return undefined
  return retained ?? current
}

export function canLaunchWorkflowCanvas(current: string | undefined): boolean {
  return current !== undefined
}

export function WorkflowCanvasOverlay({ remote, sessions, controller }: WorkflowCanvasOverlayProps) {
  const api = useMemo(() => createWorkflowCanvasApi(remote), [remote])
  const snapshot = useSyncExternalStore(
    listener => sessions.subscribe(listener),
    () => sessions.getSnapshot(),
    () => sessions.getSnapshot(),
  )
  const ui = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const retainedSession = useRef<string | undefined>(undefined)
  const sessionId = retainWorkflowCanvasSession(ui.open, snapshot.current, retainedSession.current)
  retainedSession.current = sessionId
  if (ui.open && sessionId !== undefined) {
    return <WorkflowStudio
      key={ui.requestId}
      api={api}
      sessionId={sessionId}
      {...(ui.target === undefined ? {} : { initialTarget: ui.target })}
      onClose={() => controller.close()}
    />
  }
  return <button
    className="wf-launcher"
    data-workflow-canvas-launcher
    disabled={!canLaunchWorkflowCanvas(snapshot.current)}
    title={!canLaunchWorkflowCanvas(snapshot.current) ? 'Open a DSH session before launching Workflow Studio' : 'Open Workflow Signal Studio'}
    onClick={() => controller.open()}
  >
    <style>{LAUNCHER_CSS}</style>
    <span>◇</span><b>FLOW</b>
  </button>
}

const LAUNCHER_CSS = String.raw`.wf-launcher{pointer-events:auto;position:absolute;right:22px;bottom:22px;width:66px;height:66px;border:1px solid #ed5a3d;background:#141615;color:#e6e2d8;clip-path:polygon(18% 0,82% 0,100% 18%,100% 82%,82% 100%,18% 100%,0 82%,0 18%);font-family:"IBM Plex Mono",monospace;cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;box-shadow:0 12px 40px #000a;transition:transform .18s,background .18s;z-index:35}.wf-launcher:hover{transform:translateY(-3px);background:#ed5a3d;color:#150d0a}.wf-launcher:disabled{opacity:.3;cursor:not-allowed}.wf-launcher span{font-size:19px;line-height:1}.wf-launcher b{font-size:8px;letter-spacing:.16em}`
