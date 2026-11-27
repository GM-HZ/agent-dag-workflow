import { createHash } from 'node:crypto'
import { isJsonObject, snapshotJsonObject, snapshotJsonValue, stableJsonStringify, type JsonObject, type JsonValue, type WorkflowRunRecord } from '../core/index.js'
import { isPersistedWorkflowRunStatus } from '../core/run-store.js'
import { verifyArtifact, type WorkflowArtifactRef, type WorkflowArtifactStore } from './artifacts.js'

export const WORKFLOW_EVIDENCE_FORMAT = 'agent-dag-workflow.evidence/v1'
const digestPattern = /^[a-f0-9]{64}$/u

/** Field-name redaction applies throughout the copy, including event payloads. */
export function redactWorkflowFields(value: JsonValue, fields: ReadonlySet<string>): JsonValue {
  if (fields.size === 0) return value
  if (Array.isArray(value)) return value.map(item => redactWorkflowFields(item, fields))
  if (!isJsonObject(value)) return value
  return redactFieldsExcept(value, fields, [])
}

function redactFieldsExcept(value: JsonObject, fields: ReadonlySet<string>, preserved: readonly string[]): JsonObject {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    preserved.includes(key) ? item : fields.has(key) ? '[REDACTED]' : redactWorkflowFields(item, fields)]))
}

export function normalizeWorkflowRedactionFields(fields: readonly string[] = []): readonly string[] {
  if (!Array.isArray(fields) || fields.length > 100 || fields.some(field =>
    typeof field !== 'string' || field.length === 0 || field.length > 128 || /[\u0000-\u001f\u007f]/u.test(field))) {
    throw new Error('redaction requires at most 100 nonempty field names of up to 128 characters')
  }
  return [...new Set(fields)].sort()
}

export async function createWorkflowEvidence(
  record: WorkflowRunRecord,
  options: { readonly artifactStore?: WorkflowArtifactStore; readonly redactFields?: readonly string[] } = {},
): Promise<JsonObject & { readonly sha256: string }> {
  const redactFields = normalizeWorkflowRedactionFields(options.redactFields)
  const fields = new Set(redactFields)
  const source = snapshotJsonObject({
    runId: record.runId, semanticHash: record.semanticHash, plan: record.plan, inputs: record.inputs,
    origin: record.execution.origin, ...(record.execution.traceContext === undefined ? {} : { traceContext: record.execution.traceContext }),
    createdAt: record.createdAt, checkpoint: record.checkpoint, events: record.events,
  })
  const refs = journalReferences(source)
  const artifacts = []
  for (const ref of refs.values()) {
    artifacts.push(await captureArtifact(ref, fields, options.artifactStore))
  }
  const checkpoint = object(source.checkpoint, 'checkpoint')
  const plan = object(source.plan, 'plan')
  const events = array(source.events, 'Journal')
  const run = {
    ...redactFieldsExcept(source, fields, ['runId', 'semanticHash', 'createdAt', 'plan', 'checkpoint', 'events']),
    plan: {
      ...plan,
      root: redactFieldsExcept(object(plan.root, 'root'), fields, ['id', 'revision', 'semanticHash']),
      dependencies: array(plan.dependencies, 'plan dependencies').map(entry =>
        redactFieldsExcept(object(entry, 'dependency'), fields, ['id', 'revision', 'semanticHash'])),
    },
    checkpoint: redactFieldsExcept(checkpoint, fields, ['version', 'runId', 'semanticHash', 'seq', 'status']),
    events: events.map(raw => {
      const event = object(raw, 'event')
      return {
        ...redactFieldsExcept(event, fields, ['schemaVersion', 'eventId', 'runId', 'type', 'seq', 'workflow', 'payload', 'artifact', 'checkpointSeq']),
        payload: redactFieldsExcept(object(event.payload, 'event payload'), fields, ['artifact', 'checkpointSeq']),
      }
    }),
  }
  const payload = snapshotJsonObject({ format: WORKFLOW_EVIDENCE_FORMAT, redactFields, run, artifacts })
  return { ...payload, sha256: evidenceHash(payload) }
}

async function captureArtifact(ref: WorkflowArtifactRef, fields: ReadonlySet<string>, store?: WorkflowArtifactStore) {
  if (store === undefined) return { ref, status: 'not-included' }
  try {
    const [artifact] = await store.read([ref])
    if (artifact === undefined || !sameRef(ref, artifact)) return { ref, status: 'unavailable' }
    verifyArtifact(artifact)
    if (!artifact.redacted && fields.size === 0) return { ref, status: 'included', base64: Buffer.from(artifact.content).toString('base64') }
    if (artifact.mediaType !== 'application/json') return { ref, status: 'not-included' }
    const value = snapshotJsonValue(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(artifact.content)))
    return { ref, status: 'redacted', value: redactWorkflowFields(value, fields) }
  } catch { return { ref, status: 'unavailable' } }
}

export function verifyWorkflowEvidence(value: unknown): { readonly sha256: string } {
  const envelope = snapshotJsonObject(value)
  if (envelope.format !== WORKFLOW_EVIDENCE_FORMAT || !isDigest(envelope.sha256)) throw new Error('Invalid workflow evidence envelope')
  const { sha256, ...payload } = envelope
  if (evidenceHash(payload) !== sha256) throw new Error('Workflow evidence checksum mismatch')
  const fields = array(envelope.redactFields, 'redactFields')
  if (!fields.every(field => typeof field === 'string')) throw new Error('Invalid workflow evidence redactFields')
  normalizeWorkflowRedactionFields(fields)
  const refs = journalReferences(object(envelope.run, 'run'))
  for (const value of array(envelope.artifacts, 'artifacts')) {
    const entry = object(value, 'artifact entry')
    const ref = requiredRef(entry.ref)
    const expected = refs.get(ref.digest)
    if (expected === undefined || !sameRef(expected, ref)) throw new Error(`Unexpected evidence artifact reference: ${ref.digest}`)
    refs.delete(ref.digest)
    if (entry.status === 'included' && typeof entry.base64 === 'string' && entry.value === undefined && !ref.redacted && fields.length === 0) {
      const content = Buffer.from(entry.base64, 'base64')
      if (content.toString('base64') !== entry.base64) throw new Error(`Invalid artifact encoding: ${ref.digest}`)
      verifyArtifact({ ...ref, content })
    } else if (entry.status === 'redacted' && entry.value !== undefined && entry.base64 === undefined && ref.mediaType === 'application/json'
      && (ref.redacted || fields.length > 0)) {
      // The original byte digest cannot cover the redacted representation; the bundle checksum does.
    } else if ((entry.status !== 'not-included' && entry.status !== 'unavailable') || entry.value !== undefined || entry.base64 !== undefined) {
      throw new Error(`Invalid artifact state: ${ref.digest}`)
    }
  }
  if (refs.size > 0) throw new Error(`Evidence is missing ${refs.size} artifact reference(s)`)
  return { sha256 }
}

function journalReferences(run: JsonObject): Map<string, WorkflowArtifactRef> {
  const plan = object(run.plan, 'plan')
  const root = object(plan.root, 'root')
  const checkpoint = object(run.checkpoint, 'checkpoint')
  const events = array(run.events, 'Journal')
  if (typeof run.runId !== 'string' || run.runId.length === 0 || !isDigest(run.semanticHash)
    || typeof root.id !== 'string' || root.id.length === 0 || root.semanticHash !== run.semanticHash
    || typeof plan.engineVersion !== 'string' || plan.engineVersion.length === 0 || !isDigest(plan.nodeDefinitionSetHash)
    || (root.revision !== undefined && (!Number.isSafeInteger(root.revision) || Number(root.revision) < 1))
    || checkpoint.version !== 1 || !isPersistedWorkflowRunStatus(checkpoint.status)
    || checkpoint.runId !== run.runId || checkpoint.semanticHash !== run.semanticHash || checkpoint.seq !== events.length || events.length === 0) {
    throw new Error('Workflow evidence run, plan or checkpoint identity is inconsistent')
  }
  const refs = new Map<string, WorkflowArtifactRef>()
  for (const [index, raw] of events.entries()) {
    const seq = index + 1
    const event = object(raw, 'event')
    const workflow = object(event.workflow, 'event workflow')
    const payload = object(event.payload, 'event payload')
    if (event.schemaVersion !== 1 || event.seq !== seq || event.runId !== run.runId || event.eventId !== `${run.runId}:${seq}`
      || workflow.id !== root.id || workflow.revision !== root.revision || workflow.semanticHash !== run.semanticHash
      || workflow.engineVersion !== plan.engineVersion || workflow.nodeDefinitionSetHash !== plan.nodeDefinitionSetHash
      || typeof event.type !== 'string'
      || (seq === events.length && event.type !== 'checkpoint.committed')
      || (event.type === 'checkpoint.committed' && payload.checkpointSeq !== seq)) {
      throw new Error(`Workflow evidence contains an invalid Journal event at seq ${seq}`)
    }
    if (payload.artifact === undefined && event.artifact === undefined) continue
    const ref = requiredRef(payload.artifact)
    if (event.artifact !== undefined && !sameRef(ref, requiredRef(event.artifact))) throw new Error(`Conflicting Journal artifact at seq ${seq}`)
    const previous = refs.get(ref.digest)
    if (previous !== undefined && !sameRef(previous, ref)) throw new Error(`Conflicting Journal artifact: ${ref.digest}`)
    refs.set(ref.digest, ref)
  }
  return refs
}

function requiredRef(raw: JsonValue | undefined): WorkflowArtifactRef {
  const ref = object(raw, 'artifact reference')
  if (!isDigest(ref.digest) || typeof ref.size !== 'number' || !Number.isSafeInteger(ref.size) || ref.size < 0
    || typeof ref.mediaType !== 'string' || ref.mediaType.length === 0 || typeof ref.redacted !== 'boolean') throw new Error('Invalid workflow evidence artifact reference')
  return { digest: ref.digest, size: ref.size, mediaType: ref.mediaType, redacted: ref.redacted }
}

function sameRef(lhs: WorkflowArtifactRef, rhs: WorkflowArtifactRef): boolean {
  return lhs.digest === rhs.digest && lhs.size === rhs.size && lhs.mediaType === rhs.mediaType && lhs.redacted === rhs.redacted
}
function isDigest(value: unknown): value is string { return typeof value === 'string' && digestPattern.test(value) }
function object(value: JsonValue | undefined, label: string): JsonObject {
  if (!isJsonObject(value)) throw new Error(`Invalid workflow evidence ${label}`)
  return value
}
function array(value: JsonValue | undefined, label: string): readonly JsonValue[] {
  if (!Array.isArray(value)) throw new Error(`Invalid workflow evidence ${label}`)
  return value
}
function evidenceHash(payload: JsonValue): string { return createHash('sha256').update(stableJsonStringify(payload)).digest('hex') }
