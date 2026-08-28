export interface WorkflowCanvasUiTarget {
  readonly templateId?: string
  readonly runId?: string
  readonly nodeId?: string
}

export interface WorkflowCanvasUiSnapshot {
  readonly open: boolean
  readonly requestId: number
  readonly target?: WorkflowCanvasUiTarget
}

export class WorkflowCanvasUiController {
  private snapshot: WorkflowCanvasUiSnapshot = { open: false, requestId: 0 }
  private readonly listeners = new Set<() => void>()

  getSnapshot = (): WorkflowCanvasUiSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  open(target?: WorkflowCanvasUiTarget): void {
    this.snapshot = {
      open: true,
      requestId: this.snapshot.requestId + 1,
      ...(target === undefined ? {} : { target: { ...target } }),
    }
    this.emit()
  }

  close(): void {
    if (!this.snapshot.open) return
    this.snapshot = { ...this.snapshot, open: false }
    this.emit()
  }

  private emit(): void { for (const listener of this.listeners) listener() }
}
