import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { isJsonObject, snapshotJsonObject, snapshotJsonValue, stableJsonStringify, type JsonObject } from '../../core/index.js'
import type { WorkflowRunResult } from '../../core/index.js'
import type {
  WorkflowIngressRecord,
  WorkflowResultDeliveryService,
  WorkflowTriggerBinding,
  WorkflowTriggerEnvelope,
  WorkflowTriggerIngress,
} from '../core/index.js'

export interface DingTalkTriggerOptions {
  readonly appSecret: string
  readonly resolveAuthority: (senderId: string, conversationId: string) => string | undefined
  readonly toleranceMs?: number
  readonly maxBodyBytes?: number
  readonly now?: () => number
}

export class DingTalkTriggerAdapter {
  readonly #now: () => number
  constructor(private readonly options: DingTalkTriggerOptions) {
    if (options.appSecret.length === 0) throw new Error('DingTalk appSecret is required')
    this.#now = options.now ?? Date.now
  }

  accept(request: { readonly timestamp: string; readonly sign: string; readonly body: JsonObject }): WorkflowTriggerEnvelope {
    const occurredAt = Number(request.timestamp)
    if (!Number.isSafeInteger(occurredAt) || Math.abs(this.#now() - occurredAt) > (this.options.toleranceMs ?? 5 * 60_000)) {
      throw new Error('DingTalk timestamp is invalid or expired')
    }
    if (Buffer.byteLength(stableJsonStringify(request.body), 'utf8') > (this.options.maxBodyBytes ?? 1024 * 1024)) {
      throw new Error('DingTalk body exceeds configured limit')
    }
    const expected = createHmac('sha256', this.options.appSecret).update(`${request.timestamp}\n${this.options.appSecret}`).digest()
    const actual = Buffer.from(request.sign, 'base64')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('DingTalk signature is invalid')
    const senderId = stringField(request.body, 'senderStaffId')
    const conversationId = stringField(request.body, 'conversationId')
    const messageId = stringField(request.body, 'msgId')
    const principalRef = this.options.resolveAuthority(senderId, conversationId)
    if (principalRef === undefined) throw new Error('DingTalk identity is not mapped to a workflow authority')
    return {
      schemaVersion: 1,
      triggerId: randomUUID(),
      source: 'dingtalk',
      sourceEventId: messageId,
      receivedAt: this.#now(),
      occurredAt,
      payload: snapshotJsonObject(request.body),
      metadata: { senderId, conversationId, principalRef },
    }
  }
}

export interface DingTalkWorkflowRoute {
  readonly binding: { readonly id: string; readonly revision: number }
  readonly command?: string
}

export interface DingTalkNaturalLanguageGateway {
  route(request: {
    readonly text: string
    readonly principalRef: string
    readonly candidates: readonly { readonly id: string; readonly revision: number }[]
    readonly signal: AbortSignal
  }): Promise<{ readonly id: string; readonly revision: number; readonly inputs: JsonObject }>
}

export class DingTalkWorkflowRouter {
  readonly routes: readonly DingTalkWorkflowRoute[]
  readonly #commands = new Map<string, DingTalkWorkflowRoute>()

  constructor(routes: readonly DingTalkWorkflowRoute[], private readonly naturalLanguage?: DingTalkNaturalLanguageGateway) {
    if (routes.length === 0) throw new Error('DingTalk workflow router requires at least one allowed binding')
    this.routes = Object.freeze(routes.map(route => snapshotJsonValue(route) as unknown as DingTalkWorkflowRoute))
    for (const route of this.routes) {
      assertBindingRef(route.binding)
      if (route.command === undefined) continue
      if (!/^\/[a-z][a-z0-9-]{0,63}$/.test(route.command) || this.#commands.has(route.command)) {
        throw new Error(`invalid or duplicate DingTalk workflow command: ${route.command}`)
      }
      this.#commands.set(route.command, route)
    }
  }

  async route(envelope: WorkflowTriggerEnvelope, signal = new AbortController().signal): Promise<{
    readonly binding: { readonly id: string; readonly revision: number }
    readonly envelope: WorkflowTriggerEnvelope
  }> {
    if (envelope.source !== 'dingtalk') throw new Error('DingTalk router received another trigger source')
    const text = messageText(envelope.payload).trim()
    if (text.length === 0) throw new Error('DingTalk message text is empty')
    const [head, ...args] = text.split(/\s+/)
    const command = this.#commands.get(head!)
    if (command !== undefined) {
      return { binding: command.binding, envelope: withRouteMetadata(envelope, { kind: 'command', command: head!, arguments: args }) }
    }
    if (this.naturalLanguage === undefined) throw new Error('DingTalk message does not match an allowed workflow command')
    const principalRef = metadataString(envelope, 'principalRef')
    const candidates = this.routes.map(route => route.binding)
    const routed = await this.naturalLanguage.route({ text, principalRef, candidates, signal })
    if (!candidates.some(candidate => candidate.id === routed.id && candidate.revision === routed.revision)) {
      throw new Error('DingTalk natural-language route selected a binding outside the allowlist')
    }
    return {
      binding: { id: routed.id, revision: routed.revision },
      envelope: withRouteMetadata(envelope, { kind: 'natural-language', inputs: snapshotJsonObject(routed.inputs) }),
    }
  }
}

export class DingTalkWorkflowChannel {
  constructor(
    private readonly adapter: DingTalkTriggerAdapter,
    private readonly router: DingTalkWorkflowRouter,
    private readonly ingress: WorkflowTriggerIngress,
    private readonly resolveBinding: (id: string, revision: number) => Promise<WorkflowTriggerBinding>,
    private readonly delivery?: WorkflowResultDeliveryService,
  ) {}

  async receive(request: { readonly timestamp: string; readonly sign: string; readonly body: JsonObject }, signal?: AbortSignal): Promise<WorkflowIngressRecord> {
    const routed = await this.router.route(this.adapter.accept(request), signal)
    const binding = await this.resolveBinding(routed.binding.id, routed.binding.revision)
    const record = await this.ingress.ingest(binding, routed.envelope)
    if (record.runId !== undefined && binding.spec.deliveryRef !== undefined && this.delivery !== undefined) {
      await this.delivery.deliver({
        runId: record.runId,
        deliveryRef: binding.spec.deliveryRef,
        phase: 'accepted',
        payload: { status: 'accepted', runId: record.runId },
      })
    }
    return record
  }

  async deliverTerminal(binding: WorkflowTriggerBinding, result: WorkflowRunResult): Promise<void> {
    if (binding.spec.deliveryRef === undefined || this.delivery === undefined) return
    await this.delivery.deliver({
      runId: result.runId,
      deliveryRef: binding.spec.deliveryRef,
      phase: 'terminal',
      payload: result.status === 'completed'
        ? { status: result.status, outputs: result.outputs }
        : { status: result.status, error: result.error, ...(result.needsAttention === undefined ? {} : { needsAttention: result.needsAttention }) },
    })
  }
}

function withRouteMetadata(envelope: WorkflowTriggerEnvelope, route: JsonObject): WorkflowTriggerEnvelope {
  return snapshotJsonValue({ ...envelope, metadata: { ...(envelope.metadata ?? {}), route } }) as unknown as WorkflowTriggerEnvelope
}
function messageText(body: JsonObject): string {
  if (typeof body.content === 'string') return body.content
  const text = body.text
  if (isJsonObject(text) && typeof text.content === 'string') return text.content
  throw new Error('DingTalk message text is missing')
}
function metadataString(envelope: WorkflowTriggerEnvelope, name: string): string {
  const value = envelope.metadata?.[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`DingTalk trusted metadata is missing: ${name}`)
  return value
}
function assertBindingRef(value: { readonly id: string; readonly revision: number }): void {
  if (!/^[a-z][a-z0-9-]*$/.test(value.id) || !Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error('DingTalk route binding is invalid')
}
function stringField(object: JsonObject, name: string): string {
  const value = object[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`DingTalk field is required: ${name}`)
  return value
}
