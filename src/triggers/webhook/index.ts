import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { snapshotJsonObject } from '../../core/index.js'
import type { WorkflowTriggerEnvelope } from '../core/index.js'

export interface WebhookTriggerOptions {
  readonly secret: string
  readonly maxBodyBytes?: number
  readonly toleranceMs?: number
  readonly now?: () => number
}

export class WebhookTriggerAdapter {
  readonly #now: () => number
  readonly #secret: string
  readonly #maxBodyBytes: number
  readonly #toleranceMs: number

  constructor(options: WebhookTriggerOptions) {
    if (typeof options.secret !== 'string' || options.secret.length === 0 || options.secret.length > 4096) {
      throw new Error('webhook secret must contain 1-4096 characters')
    }
    const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024
    if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 16 * 1024 * 1024) {
      throw new Error('webhook maxBodyBytes must be a safe integer between 1 and 16777216')
    }
    const toleranceMs = options.toleranceMs ?? 5 * 60_000
    if (!Number.isSafeInteger(toleranceMs) || toleranceMs < 0 || toleranceMs > 24 * 60 * 60_000) {
      throw new Error('webhook toleranceMs must be a safe integer between 0 and 86400000')
    }
    this.#secret = options.secret
    this.#maxBodyBytes = maxBodyBytes
    this.#toleranceMs = toleranceMs
    this.#now = options.now ?? Date.now
  }

  accept(request: { readonly body: Uint8Array; readonly headers: Readonly<Record<string, string | undefined>> }): WorkflowTriggerEnvelope {
    if (request.body.byteLength > this.#maxBodyBytes) throw new Error('webhook body exceeds configured limit')
    const timestamp = required(request.headers['x-workflow-timestamp'], 'x-workflow-timestamp', 16)
    const eventId = required(request.headers['x-workflow-event-id'], 'x-workflow-event-id', 512)
    const signature = required(request.headers['x-workflow-signature'], 'x-workflow-signature', 67)
    const occurredAt = Number(timestamp)
    const receivedAt = this.#now()
    if (/[^0-9]/u.test(timestamp) || (timestamp.length > 1 && timestamp.startsWith('0')) || !Number.isSafeInteger(occurredAt)
      || !Number.isSafeInteger(receivedAt) || receivedAt < 0 || Math.abs(receivedAt - occurredAt) > this.#toleranceMs) {
      throw new Error('webhook timestamp is invalid or expired')
    }
    if (/[^A-Za-z0-9._:-]/u.test(eventId)) throw new Error('webhook event ID is invalid')
    if (signature.length !== 67 || !/^v1=[0-9a-f]{64}$/u.test(signature)) throw new Error('webhook signature is invalid')
    // The two canonical header fields cannot contain LF. The rest is the raw body.
    const expected = createHmac('sha256', this.#secret)
      .update(`agent-dag-webhook:v1\n${timestamp}\n${eventId}\n`)
      .update(request.body)
      .digest()
    if (!timingSafeEqual(Buffer.from(signature.slice(3), 'hex'), expected)) throw new Error('webhook signature is invalid')
    const decoded: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(request.body))
    const payload = snapshotJsonObject(decoded)
    return {
      schemaVersion: 1,
      triggerId: randomUUID(),
      source: 'webhook',
      sourceEventId: eventId,
      receivedAt,
      occurredAt,
      payload,
      metadata: { signedAt: occurredAt },
    }
  }
}

function required(value: string | undefined, name: string, maxLength: number): string {
  if (value === undefined || value === '') throw new Error(`webhook header is required: ${name}`)
  if (typeof value !== 'string') throw new Error(`webhook header must have one string value: ${name}`)
  if (value.length > maxLength) throw new Error(`webhook header exceeds configured limit: ${name}`)
  return value
}
