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
    title={!canLaunchWorkflowCanvas(snapshot.current) ? '请先打开一个 DSH 顶层会话' : '打开 DSH DAG Workflow'}
    onClick={() => controller.open()}
  >
    <style>{LAUNCHER_CSS}</style>
    <span>◇</span><b>工作流</b>
  </button>
}

const LAUNCHER_CSS = String.raw`.wf-launcher{pointer-events:auto;position:absolute;right:22px;bottom:22px;min-width:76px;height:48px;padding:0 15px;border:1px solid #d9dee8;border-radius:14px;background:#fff;color:#182033;font-family:var(--dsw-font-family),"Avenir Next","PingFang SC",sans-serif;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:7px;box-shadow:0 12px 34px rgba(25,38,67,.16);transition:transform .18s,box-shadow .18s,border-color .18s;z-index:35}.wf-launcher:hover{transform:translateY(-2px);border-color:#2563eb;box-shadow:0 16px 40px rgba(25,38,67,.2)}.wf-launcher:disabled{opacity:.38;cursor:not-allowed;transform:none}.wf-launcher span{display:grid;place-items:center;width:24px;height:24px;border-radius:8px;background:#eaf1ff;color:#2563eb;font-size:15px;line-height:1}.wf-launcher b{font-size:10px;letter-spacing:0;white-space:nowrap}@media(prefers-color-scheme:dark){html:not([style*="color-scheme: light"]) .wf-launcher{border-color:#303744;background:#1b1f27;color:#eef1f6;box-shadow:0 12px 34px rgba(0,0,0,.3)}html:not([style*="color-scheme: light"]) .wf-launcher span{background:#1d2b47;color:#75a2ff}}html[style*="color-scheme: dark"] .wf-launcher{border-color:#303744;background:#1b1f27;color:#eef1f6;box-shadow:0 12px 34px rgba(0,0,0,.3)}html[style*="color-scheme: dark"] .wf-launcher span{background:#1d2b47;color:#75a2ff}`
