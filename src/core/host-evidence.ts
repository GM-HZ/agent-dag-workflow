import type { WorkflowHostEvidenceReporter, WorkflowHostInvocationEvidence, WorkflowHostUsage } from './types.js'

const identifierKeys = ['childRunId', 'traceId', 'spanId', 'modelId', 'toolVersion'] as const
const evidenceKeys = new Set<string>([...identifierKeys, 'durationMs', 'usage'])
const usageKeys = new Set<string>(['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens'])
const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]*$/u
const maxUsage = 1_000_000_000
const maxDurationMs = 7 * 24 * 60 * 60 * 1000

export function createHostEvidenceCollector(): {
  readonly report: WorkflowHostEvidenceReporter
  close(): WorkflowHostInvocationEvidence | undefined
} {
  let evidence: WorkflowHostInvocationEvidence | undefined
  let open = true
  return {
    report(value) {
      if (!open) return false
      const next = validateHostEvidence(value)
      if (next === undefined) return false
      if (identifierKeys.some(key => evidence?.[key] !== undefined && next[key] !== undefined && evidence[key] !== next[key])) return false
      if (Object.keys(next).length > 0) {
        const usage = next.usage === undefined ? {} : { usage: { ...evidence?.usage, ...next.usage } }
        evidence = { ...evidence, ...next, ...usage }
      }
      return true
    },
    close() {
      open = false
      return evidence
    },
  }
}

/** Validates without reading accessors or retaining original host objects. */
export function validateHostEvidence(value: unknown): WorkflowHostInvocationEvidence | undefined {
  try {
    const fields = dataFields(value, evidenceKeys)
    if (fields === undefined) return undefined
    const identifiers: Partial<Record<typeof identifierKeys[number], string>> = {}
    for (const key of identifierKeys) {
      if (!Object.hasOwn(fields, key)) continue
      const field = fields[key]
      if (typeof field !== 'string' || !validIdentifier(key, field)) return undefined
      identifiers[key] = key === 'traceId' || key === 'spanId' ? field.toLowerCase() : field
    }
    const durationMs = fields.durationMs
    if (Object.hasOwn(fields, 'durationMs') && (
      typeof durationMs !== 'number' || !Number.isFinite(durationMs) || Object.is(durationMs, -0) || durationMs < 0 || durationMs > maxDurationMs
    )) return undefined
    const usage = Object.hasOwn(fields, 'usage') ? readUsage(fields.usage) : undefined
    if (Object.hasOwn(fields, 'usage') && usage === undefined) return undefined
    return {
      ...identifiers,
      ...(typeof durationMs === 'number' ? { durationMs } : {}),
      ...(usage === undefined || Object.keys(usage).length === 0 ? {} : { usage }),
    }
  } catch {
    // Host extensions may return exotic objects. Reject those without copying them.
    return undefined
  }
}

function validIdentifier(key: typeof identifierKeys[number], value: string): boolean {
  if (key === 'traceId') return /^[a-f0-9]{32}$/iu.test(value) && !/^0+$/u.test(value)
  if (key === 'spanId') return /^[a-f0-9]{16}$/iu.test(value) && !/^0+$/u.test(value)
  return value.length <= (key === 'childRunId' ? 256 : 128) && identifierPattern.test(value)
}

function readUsage(value: unknown): WorkflowHostUsage | undefined {
  const fields = dataFields(value, usageKeys)
  if (fields === undefined) return undefined
  const usage: Record<string, number> = Object.create(null) as Record<string, number>
  for (const [name, count] of Object.entries(fields)) {
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || Object.is(count, -0) || count < 0 || count > maxUsage) return undefined
    usage[name] = count
  }
  return usage
}

function dataFields(value: unknown, allowed: ReadonlySet<string>): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return undefined
  const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) return undefined
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return undefined
    fields[key] = descriptor.value
  }
  return fields
}
