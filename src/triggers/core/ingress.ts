import { createHash } from 'node:crypto'
import { isJsonObject, snapshotJsonObject, snapshotJsonValue, stableJsonStringify, WORKFLOW_TEMPLATE_API_VERSION, type JsonObject, type JsonValue } from '../../core/index.js'
import type { WorkflowRuntimeApi } from '../../runtime/index.js'
import type { WorkflowIngressRecord, WorkflowIngressStore, WorkflowInputMappingValue, WorkflowTriggerBinding, WorkflowTriggerEnvelope } from './types.js'

export class WorkflowTriggerIngress {
  constructor(
    private readonly runtime: WorkflowRuntimeApi,
    private readonly store: WorkflowIngressStore,
    private readonly resolveBinding: (id: string, revision: number) => Promise<WorkflowTriggerBinding>,
  ) {}

  async ingest(binding: WorkflowTriggerBinding, envelope: WorkflowTriggerEnvelope): Promise<WorkflowIngressRecord> {
    validateEnvelope(envelope)
    validateBinding(binding, envelope.source)
    const dedupeKey = workflowIngressDedupeKey(binding, envelope)
    const initial: WorkflowIngressRecord = snapshotJsonValue({
      triggerId: envelope.triggerId,
      dedupeKey,
      binding: binding.metadata,
      source: envelope.source,
      sourceEventId: envelope.sourceEventId,
      status: 'received',
      receivedAt: envelope.receivedAt,
      envelope,
    }) as unknown as WorkflowIngressRecord
    const accepted = await this.store.acceptOrGet(initial)
    if (!accepted.accepted) return { ...accepted.record, status: 'deduplicated' }
    return this.#launch(binding, accepted.record)
  }

  async recoverPending(): Promise<readonly WorkflowIngressRecord[]> {
    const recovered: WorkflowIngressRecord[] = []
    for (const record of await this.store.listPending()) {
      const binding = await this.resolveBinding(record.binding.id, record.binding.revision)
      recovered.push(await this.#launch(binding, record))
    }
    return recovered
  }

  async #launch(binding: WorkflowTriggerBinding, record: WorkflowIngressRecord): Promise<WorkflowIngressRecord> {
    let inputs: JsonObject
    try {
      inputs = mapInputs(binding.spec.inputMapping, record.envelope)
    } catch (error: unknown) {
      await this.store.markRejected(record.triggerId, reasonCode(error))
      return (await this.store.get(record.triggerId))!
    }
    // Runtime/queue failures are infrastructure or deployment failures. Keep
    // the accepted ingress pending so recoverPending can retry the same
    // authority-scoped idempotent launch instead of misclassifying it as a
    // permanently rejected external event.
    const handle = await this.runtime.launch({
      target: { type: 'published', id: binding.spec.workflow.id, revision: binding.spec.workflow.revision },
      inputs,
      authorityRef: binding.spec.authorityRef,
      origin: { type: 'trigger', source: record.source, sourceRef: record.sourceEventId },
      idempotencyKey: record.dedupeKey,
      executionMode: 'background',
      ...(binding.spec.deliveryRef === undefined ? {} : { deliveryRef: binding.spec.deliveryRef }),
    })
    const runId = handle.runId
    try {
      await this.store.markLaunched(record.triggerId, runId)
    } catch (error: unknown) {
      const current = await this.store.get(record.triggerId)
      if (current?.status === 'launched' && current.runId === runId) return current
      // Keep a pre-commit failure in received state so recoverPending can close the launch gap.
      throw error
    }
    return (await this.store.get(record.triggerId))!
  }
}

export function workflowIngressDedupeKey(binding: WorkflowTriggerBinding, envelope: WorkflowTriggerEnvelope): string {
  const tuple = [binding.metadata.id, binding.metadata.revision, envelope.source, envelope.sourceEventId] as JsonValue
  return createHash('sha256').update(stableJsonStringify(tuple)).digest('hex')
}

export function mapInputs(mapping: Readonly<Record<string, WorkflowInputMappingValue>>, envelope: WorkflowTriggerEnvelope): JsonObject {
  const result: JsonObject = {}
  for (const [name, binding] of Object.entries(mapping)) {
    if ('literal' in binding) result[name] = snapshotJsonValue(binding.literal)
    else if ('payload' in binding) result[name] = readPath(envelope.payload, binding.payload.path)
    else result[name] = readPath(envelope.metadata ?? {}, binding.metadata.path)
  }
  return snapshotJsonObject(result)
}

function readPath(root: JsonValue, path: readonly (string | number)[]): JsonValue {
  let value: JsonValue | undefined = root
  for (const part of path) {
    value = typeof part === 'number'
      ? Array.isArray(value) ? value[part] : undefined
      : isJsonObject(value) ? value[part] : undefined
    if (value === undefined) throw new Error(`trigger input mapping path is missing: ${path.join('.')}`)
  }
  return snapshotJsonValue(value)
}

function validateEnvelope(value: WorkflowTriggerEnvelope): void {
  if (value.schemaVersion !== 1
    || value.triggerId.length === 0 || value.triggerId.length > 1024
    || value.source.length === 0 || value.source.length > 256
    || value.sourceEventId.length === 0 || value.sourceEventId.length > 4096
    || !Number.isSafeInteger(value.receivedAt)
    || (value.occurredAt !== undefined && !Number.isSafeInteger(value.occurredAt))) {
    throw new Error('invalid trusted workflow trigger envelope')
  }
}
function validateBinding(binding: WorkflowTriggerBinding, source: string): void {
  if (binding.apiVersion !== WORKFLOW_TEMPLATE_API_VERSION || binding.kind !== 'WorkflowBinding' || binding.spec.enabled === false
    || !/^[a-z][a-z0-9-]*$/.test(binding.metadata.id) || !Number.isSafeInteger(binding.metadata.revision) || binding.metadata.revision < 1
    || !/^[a-z][a-z0-9-]*$/.test(binding.spec.workflow.id) || !Number.isSafeInteger(binding.spec.workflow.revision) || binding.spec.workflow.revision < 1
    || binding.spec.authorityRef.length === 0 || binding.spec.authorityRef.length > 1024) throw new Error('workflow binding is invalid or disabled')
  const expected = binding.spec.trigger.uses.split('@', 1)[0]
  if (expected !== source) throw new Error(`trigger source ${source} does not match binding ${binding.spec.trigger.uses}`)
}
function reasonCode(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return `INGRESS_${text.toUpperCase().replaceAll(/[^A-Z0-9]+/g, '_').slice(0, 80)}`
}
