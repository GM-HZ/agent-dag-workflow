import { randomUUID } from 'node:crypto'
import type { WorkflowRunResult } from '../../core/index.js'
import type { WorkflowRuntimeApi, WorkflowRunSummary } from '../../runtime/index.js'
import type { WorkflowDeliveryRequest, WorkflowResultDeliveryService } from './delivery.js'

export interface WorkflowRunClaim { readonly runId: string; readonly workerId: string; readonly leaseToken: string; readonly expiresAt: number }
export class WorkflowRunWorkerError extends Error {
  constructor(readonly runId: string, readonly phase: 'workflow' | 'delivery', cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'WorkflowRunWorkerError'
  }
}
export interface WorkflowRunCoordinator {
  enqueue(runId: string): Promise<void>
  claim(request: { readonly workerId: string; readonly leaseMs: number }): Promise<WorkflowRunClaim | undefined>
  heartbeat(request: { readonly runId: string; readonly leaseToken: string; readonly leaseMs: number }): Promise<boolean>
  release(request: { readonly runId: string; readonly leaseToken: string }): Promise<void>
  /** Return a claim to the queue without deleting its durable intent. */
  requeue?(request: { readonly runId: string; readonly leaseToken: string }): Promise<void>
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
  async requeue(request: { readonly runId: string; readonly leaseToken: string }): Promise<void> {
    if (this.#claims.get(request.runId)?.leaseToken !== request.leaseToken) return
    this.#claims.delete(request.runId)
    this.#queued.push(request.runId)
  }
}

/** Single-claim reference runner. Host-level worker pools and distributed fencing are intentionally out of scope. */
export class WorkflowRunWorker {
  constructor(
    private readonly runtime: WorkflowRuntimeApi,
    private readonly coordinator: WorkflowRunCoordinator,
    private readonly delivery?: WorkflowResultDeliveryService,
  ) {}

  async runOnce(request: { readonly workerId: string; readonly leaseMs: number; readonly signal?: AbortSignal }): Promise<WorkflowRunResult | undefined> {
    assertClaimRequest(request)
    const claim = await this.coordinator.claim({ workerId: request.workerId, leaseMs: request.leaseMs })
    if (claim === undefined) return undefined
    let keepClaim = true
    let phase: WorkflowRunWorkerError['phase'] = 'workflow'
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
      const summary = await this.runtime.getRun(claim.runId)
      if (summary === undefined) {
        keepClaim = false
        throw new Error(`claimed workflow run does not exist: ${claim.runId}`)
      }
      const handle = terminal(summary)
        ? await this.runtime.replay({ runId: claim.runId, mode: 'inspect' })
        : await this.runtime.resume({ runId: claim.runId, authorityRef: summary.authorityRef, interruptionSignal: signal })
      const result = await handle.result
      const latest = await this.runtime.getRun(claim.runId)
      if (latest === undefined || latest.status === 'running') return result
      if (terminal(latest) && latest.deliveryRef !== undefined) {
        phase = 'delivery'
        if (this.delivery === undefined) throw new Error(`terminal delivery gateway unavailable for run ${claim.runId}`)
        signal.throwIfAborted()
        const deliveryRequest = makeTerminalDelivery(latest, latest.deliveryRef)
        try {
          if (!await this.delivery.hasRecord(deliveryRequest)) await this.delivery.deliver(deliveryRequest)
        } catch (error: unknown) {
          // Transfer custody only after verifying that a recoverable delivery record exists.
          keepClaim = !await this.delivery.hasRecord(deliveryRequest).catch(() => false)
          throw error
        }
      }
      keepClaim = false
      return result
    } catch (error: unknown) {
      throw new WorkflowRunWorkerError(claim.runId, phase, error)
    } finally {
      clearInterval(heartbeat)
      const lease = { runId: claim.runId, leaseToken: claim.leaseToken }
      // Older stores can preserve the row by letting the lease expire instead.
      if (keepClaim) await this.coordinator.requeue?.(lease)
      else await this.coordinator.release(lease)
    }
  }
}

function terminal(run: WorkflowRunSummary): boolean {
  return run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled'
}

function makeTerminalDelivery(run: WorkflowRunSummary, deliveryRef: string): WorkflowDeliveryRequest {
  if (run.status === 'completed' && run.outputs === undefined) throw new Error(`missing output for completed workflow run ${run.runId}`)
  return {
    runId: run.runId,
    deliveryRef,
    phase: 'terminal',
    payload: run.status === 'completed'
      ? { status: run.status, outputs: run.outputs! }
      : { status: run.status, error: run.error ?? run.status, ...(run.needsAttention === undefined ? {} : { needsAttention: run.needsAttention }) },
  }
}

function assertClaimRequest(request: { readonly workerId: string; readonly leaseMs: number }): void {
  if (request.workerId.length === 0) throw new Error('workerId is required')
  if (!Number.isSafeInteger(request.leaseMs) || request.leaseMs <= 0) throw new Error('leaseMs must be a positive safe integer')
}
