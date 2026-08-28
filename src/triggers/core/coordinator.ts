import { randomUUID } from 'node:crypto'
import type { WorkflowRunResult } from '../../core/index.js'
import type { WorkflowRuntimeApi } from '../../runtime/index.js'

export interface WorkflowRunClaim { readonly runId: string; readonly workerId: string; readonly leaseToken: string; readonly expiresAt: number }
export interface WorkflowRunCoordinator {
  enqueue(runId: string): Promise<void>
  claim(request: { readonly workerId: string; readonly leaseMs: number }): Promise<WorkflowRunClaim | undefined>
  heartbeat(request: { readonly runId: string; readonly leaseToken: string; readonly leaseMs: number }): Promise<boolean>
  release(request: { readonly runId: string; readonly leaseToken: string }): Promise<void>
}

export class InMemoryWorkflowRunCoordinator implements WorkflowRunCoordinator {
  readonly #queued: string[] = []
  readonly #claims = new Map<string, WorkflowRunClaim>()
  constructor(private readonly now: () => number = Date.now) {}
  async enqueue(runId: string): Promise<void> { if (!this.#queued.includes(runId) && !this.#claims.has(runId)) this.#queued.push(runId) }
  async claim(request: { readonly workerId: string; readonly leaseMs: number }): Promise<WorkflowRunClaim | undefined> {
    assertClaimRequest(request)
    for (const [runId, claim] of this.#claims) if (claim.expiresAt <= this.now()) { this.#claims.delete(runId); this.#queued.unshift(runId) }
    const runId = this.#queued.shift()
    if (runId === undefined) return undefined
    const claim = { runId, workerId: request.workerId, leaseToken: randomUUID(), expiresAt: this.now() + request.leaseMs }
    this.#claims.set(runId, claim)
    return claim
  }
  async heartbeat(request: { readonly runId: string; readonly leaseToken: string; readonly leaseMs: number }): Promise<boolean> {
    if (!Number.isSafeInteger(request.leaseMs) || request.leaseMs <= 0) throw new Error('leaseMs must be a positive safe integer')
    const claim = this.#claims.get(request.runId)
    if (claim === undefined || claim.leaseToken !== request.leaseToken || claim.expiresAt <= this.now()) return false
    this.#claims.set(request.runId, { ...claim, expiresAt: this.now() + request.leaseMs })
    return true
  }
  async release(request: { readonly runId: string; readonly leaseToken: string }): Promise<void> {
    if (this.#claims.get(request.runId)?.leaseToken === request.leaseToken) this.#claims.delete(request.runId)
  }
}

export class WorkflowRunWorker {
  constructor(
    private readonly runtime: WorkflowRuntimeApi,
    private readonly coordinator: WorkflowRunCoordinator,
  ) {}

  async runOnce(request: { readonly workerId: string; readonly leaseMs: number; readonly signal?: AbortSignal }): Promise<WorkflowRunResult | undefined> {
    assertClaimRequest(request)
    const claim = await this.coordinator.claim({ workerId: request.workerId, leaseMs: request.leaseMs })
    if (claim === undefined) return undefined
    const summary = await this.runtime.getRun(claim.runId)
    if (summary === undefined) {
      await this.coordinator.release({ runId: claim.runId, leaseToken: claim.leaseToken })
      throw new Error(`claimed workflow run does not exist: ${claim.runId}`)
    }
    const leaseAbort = new AbortController()
    const signal = request.signal === undefined ? leaseAbort.signal : AbortSignal.any([request.signal, leaseAbort.signal])
    const intervalMs = Math.max(10, Math.floor(request.leaseMs / 3))
    let heartbeatBusy = false
    const heartbeat = setInterval(() => {
      if (heartbeatBusy || signal.aborted) return
      heartbeatBusy = true
      void this.coordinator.heartbeat({ runId: claim.runId, leaseToken: claim.leaseToken, leaseMs: request.leaseMs })
        .then(valid => { if (!valid) leaseAbort.abort('workflow worker lease lost') })
        .catch(error => leaseAbort.abort(error))
        .finally(() => { heartbeatBusy = false })
    }, intervalMs)
    try {
      const handle = await this.runtime.resume({ runId: claim.runId, authorityRef: summary.authorityRef, signal })
      return await handle.result
    } finally {
      clearInterval(heartbeat)
      await this.coordinator.release({ runId: claim.runId, leaseToken: claim.leaseToken })
      const latest = await this.runtime.getRun(claim.runId).catch(() => undefined)
      if (latest?.status === 'running') await this.coordinator.enqueue(claim.runId)
    }
  }
}

function assertClaimRequest(request: { readonly workerId: string; readonly leaseMs: number }): void {
  if (request.workerId.length === 0) throw new Error('workerId is required')
  if (!Number.isSafeInteger(request.leaseMs) || request.leaseMs <= 0) throw new Error('leaseMs must be a positive safe integer')
}
