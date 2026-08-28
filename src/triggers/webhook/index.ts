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
  constructor(private readonly options: WebhookTriggerOptions) { this.#now = options.now ?? Date.now }

  accept(request: { readonly body: Uint8Array; readonly headers: Readonly<Record<string, string | undefined>> }): WorkflowTriggerEnvelope {
    if (request.body.byteLength > (this.options.maxBodyBytes ?? 1024 * 1024)) throw new Error('webhook body exceeds configured limit')
    const timestamp = required(request.headers['x-workflow-timestamp'], 'x-workflow-timestamp')
    const eventId = required(request.headers['x-workflow-event-id'], 'x-workflow-event-id')
    const signature = required(request.headers['x-workflow-signature'], 'x-workflow-signature')
    const occurredAt = Number(timestamp)
    if (!Number.isSafeInteger(occurredAt) || Math.abs(this.#now() - occurredAt) > (this.options.toleranceMs ?? 5 * 60_000)) throw new Error('webhook timestamp is invalid or expired')
    const expected = createHmac('sha256', this.options.secret).update(timestamp).update('.').update(request.body).digest('hex')
    const left = Buffer.from(signature, 'hex')
    const right = Buffer.from(expected, 'hex')
    if (left.length !== right.length || !timingSafeEqual(left, right)) throw new Error('webhook signature is invalid')
    const decoded: unknown = JSON.parse(new TextDecoder().decode(request.body))
    const payload = snapshotJsonObject(decoded as Record<string, import('../../core/index.js').JsonValue>)
    return {
      schemaVersion: 1,
      triggerId: randomUUID(),
      source: 'webhook',
      sourceEventId: eventId,
      receivedAt: this.#now(),
      occurredAt,
      payload,
      metadata: { signedAt: occurredAt },
    }
  }
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) throw new Error(`webhook header is required: ${name}`)
  return value
}
