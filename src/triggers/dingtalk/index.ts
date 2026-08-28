import { createHmac, randomUUID } from 'node:crypto'
import { snapshotJsonObject, type JsonObject } from '../../core/index.js'
import type { WorkflowTriggerEnvelope } from '../core/index.js'

export interface DingTalkTriggerOptions {
  readonly appSecret: string
  readonly resolveAuthority: (senderId: string, conversationId: string) => string | undefined
  readonly now?: () => number
}

export class DingTalkTriggerAdapter {
  readonly #now: () => number
  constructor(private readonly options: DingTalkTriggerOptions) { this.#now = options.now ?? Date.now }

  accept(request: { readonly timestamp: string; readonly sign: string; readonly body: JsonObject }): WorkflowTriggerEnvelope {
    const expected = createHmac('sha256', this.options.appSecret).update(`${request.timestamp}\n${this.options.appSecret}`).digest('base64')
    if (request.sign !== expected) throw new Error('DingTalk signature is invalid')
    const senderId = stringField(request.body, 'senderStaffId')
    const conversationId = stringField(request.body, 'conversationId')
    const messageId = stringField(request.body, 'msgId')
    const authorityRef = this.options.resolveAuthority(senderId, conversationId)
    if (authorityRef === undefined) throw new Error('DingTalk identity is not mapped to a workflow authority')
    return {
      schemaVersion: 1,
      triggerId: randomUUID(),
      source: 'dingtalk',
      sourceEventId: messageId,
      receivedAt: this.#now(),
      payload: snapshotJsonObject(request.body),
      metadata: { senderId, conversationId, principalRef: authorityRef },
    }
  }
}

export interface WorkflowResultDelivery {
  deliver(request: { readonly runId: string; readonly deliveryRef: string; readonly phase: 'accepted' | 'progress' | 'terminal'; readonly payload: JsonObject; readonly invocationId: string }): Promise<void>
}

function stringField(object: JsonObject, name: string): string {
  const value = object[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`DingTalk field is required: ${name}`)
  return value
}
