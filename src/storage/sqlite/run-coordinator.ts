import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import type { WorkflowRunClaim, WorkflowRunCoordinator } from '../../triggers/core/index.js'
import { openWorkflowDatabase, transaction, type SqliteWorkflowOptions } from './database.js'

export type SqliteWorkflowRunCoordinatorOptions = SqliteWorkflowOptions & { readonly now?: () => number }

export class SqliteWorkflowRunCoordinator implements WorkflowRunCoordinator {
  readonly #db: DatabaseSync
  readonly #now: () => number

  constructor(options: SqliteWorkflowRunCoordinatorOptions) {
    this.#db = openWorkflowDatabase(options)
    this.#now = options.now ?? Date.now
  }

  close(): void { this.#db.close() }

  async enqueue(runId: string): Promise<void> {
    if (runId.length === 0) throw new Error('runId is required')
    this.#db.prepare(`INSERT INTO workflow_run_queue (run_id, enqueued_at) VALUES (?, ?)
      ON CONFLICT(run_id) DO NOTHING`).run(runId, this.#now())
  }

  async claim(request: { readonly workerId: string; readonly leaseMs: number; readonly authorityRef?: string; readonly runId?: string }): Promise<WorkflowRunClaim | undefined> {
    validateLeaseRequest(request.workerId, request.leaseMs)
    return transaction(this.#db, () => {
      const now = this.#now()
      const run = request.runId ?? null
      const authority = request.authorityRef ?? null
      const row = this.#db.prepare(`SELECT queue.run_id FROM workflow_run_queue AS queue
        WHERE (queue.worker_id IS NULL OR queue.lease_expires_at <= ?) AND (? IS NULL OR queue.run_id = ?)
        AND (? IS NULL OR EXISTS (SELECT 1 FROM workflow_runs AS run WHERE run.run_id = queue.run_id
          AND json_extract(run.execution_json, '$.authorityRef') = ?))
        ORDER BY queue.enqueued_at, queue.run_id LIMIT 1`).get(now, run, run, authority, authority)
      if (row === undefined) return undefined
      const runId = text(row, 'run_id')
      const leaseToken = randomUUID()
      const expiresAt = now + request.leaseMs
      const result = this.#db.prepare(`UPDATE workflow_run_queue
        SET worker_id = ?, lease_token = ?, lease_expires_at = ?
        WHERE run_id = ? AND (worker_id IS NULL OR lease_expires_at <= ?)`).run(request.workerId, leaseToken, expiresAt, runId, now)
      if (result.changes !== 1) return undefined
      return { runId, workerId: request.workerId, leaseToken, expiresAt }
    })
  }

  async heartbeat(request: { readonly runId: string; readonly leaseToken: string; readonly leaseMs: number }): Promise<boolean> {
    validateLeaseRequest(request.leaseToken, request.leaseMs)
    const now = this.#now()
    const result = this.#db.prepare(`UPDATE workflow_run_queue SET lease_expires_at = ?
      WHERE run_id = ? AND lease_token = ? AND lease_expires_at > ?`)
      .run(now + request.leaseMs, request.runId, request.leaseToken, now)
    return result.changes === 1
  }

  async release(request: { readonly runId: string; readonly leaseToken: string }): Promise<void> {
    this.#db.prepare('DELETE FROM workflow_run_queue WHERE run_id = ? AND lease_token = ?')
      .run(request.runId, request.leaseToken)
  }

  async requeue(request: { readonly runId: string; readonly leaseToken: string }): Promise<void> {
    this.#db.prepare(`UPDATE workflow_run_queue SET enqueued_at = ?, worker_id = NULL, lease_token = NULL, lease_expires_at = NULL
      WHERE run_id = ? AND lease_token = ?`).run(this.#now(), request.runId, request.leaseToken)
  }
}

function validateLeaseRequest(identity: string, leaseMs: number): void {
  if (identity.length === 0) throw new Error('worker/lease identity is required')
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 86_400_000) throw new Error('leaseMs must be 1..86400000')
}

function text(row: unknown, name: string): string {
  const value = (row as Record<string, SQLOutputValue>)[name]
  if (typeof value !== 'string') throw new Error(`workflow run queue column ${name} is invalid`)
  return value
}
