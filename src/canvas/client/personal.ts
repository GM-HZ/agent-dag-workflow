import type { CanvasJsonObject, CanvasRunStartRequest, CanvasWorkflowTemplate } from '../types.js'

export interface RunInputPreset {
  readonly name: string
  readonly inputs: CanvasJsonObject
}

export function parseJsonObject(source: string): CanvasJsonObject | undefined {
  try {
    const value: unknown = JSON.parse(source)
    return isObject(value) ? value : undefined
  } catch { return undefined }
}

export function isObject(value: unknown): value is CanvasJsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function key(sessionId: string, suffix: string) {
  return `agent-dag-workflow:personal:${encodeURIComponent(sessionId)}:${suffix}`
}

function readLocal(key: string): unknown {
  try { return JSON.parse(window.localStorage.getItem(key) ?? 'null') as unknown } catch { return undefined }
}

export function readInputPresets(sessionId: string, workflowId: string): RunInputPreset[] {
  const presets = readLocal(key(sessionId, `inputs:${encodeURIComponent(workflowId)}`))
  return Array.isArray(presets) ? presets.filter((item): item is RunInputPreset =>
    isObject(item) && typeof item.name === 'string' && isObject(item.inputs)) : []
}

export function writeInputPresets(sessionId: string, workflowId: string, presets: readonly RunInputPreset[]): void {
  const storageKey = key(sessionId, `inputs:${encodeURIComponent(workflowId)}`)
  if (presets.length === 0) { window.localStorage.removeItem(storageKey); return }
  const snapshot = JSON.stringify(presets)
  if (presets.length > 30 || snapshot.length > 500_000) throw new Error('Personal input presets exceed local storage limits.')
  window.localStorage.setItem(storageKey, snapshot)
}

export function readFavorites(sessionId: string): string[] {
  const favorites = readLocal(key(sessionId, 'favorites'))
  return Array.isArray(favorites) ? favorites.filter((item): item is string => typeof item === 'string') : []
}

export function writeFavorites(sessionId: string, favorites: readonly string[]): void {
  window.localStorage.setItem(key(sessionId, 'favorites'), JSON.stringify(favorites))
}

export function readLastDraft(sessionId: string): string | undefined {
  const value = readLocal(key(sessionId, 'last-draft'))
  return typeof value === 'string' ? value : undefined
}

export function rememberLastDraft(sessionId: string, workflowId: string): void {
  try { window.localStorage.setItem(key(sessionId, 'last-draft'), JSON.stringify(workflowId)) } catch { /* Recents still come from the host catalog. */ }
}

function publishedInputsKey(sessionId: string, workflowId: string, revision: number) {
  return key(sessionId, `published-inputs:${encodeURIComponent(workflowId)}@${revision}`)
}

export function readPublishedInputs(sessionId: string, workflowId: string, revision: number): CanvasJsonObject | undefined {
  const value = readLocal(publishedInputsKey(sessionId, workflowId, revision))
  return isObject(value) ? value : undefined
}

export function writePublishedInputs(sessionId: string, workflowId: string, revision: number, inputs?: CanvasJsonObject): void {
  const storageKey = publishedInputsKey(sessionId, workflowId, revision)
  if (inputs === undefined) { window.localStorage.removeItem(storageKey); return }
  const snapshot = JSON.stringify(inputs)
  if (snapshot.length > 500_000) throw new Error('Published run inputs exceed local storage limits.')
  window.localStorage.setItem(storageKey, snapshot)
}

interface PendingRunIdentity {
  readonly fingerprint: string
  readonly requestId: string
  readonly durable: boolean
}

export async function getPendingRunIdentity(
  sessionId: string,
  payload: Omit<CanvasRunStartRequest, 'requestId'>,
  recent?: PendingRunIdentity,
): Promise<PendingRunIdentity> {
  const serialized = canonicalRunRequest(payload)
  const digest = globalThis.crypto?.subtle === undefined ? undefined
    : await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized))
  const fingerprint = digest === undefined ? serialized : hex(new Uint8Array(digest))
  if (recent?.fingerprint === fingerprint) return recent
  const stored = digest === undefined ? [] : readPendingRuns(sessionId)
  const requestId = stored.find(item => item.fingerprint === fingerprint)?.requestId
    ?? (globalThis.crypto?.randomUUID?.() ?? hex(crypto.getRandomValues(new Uint8Array(16))))
  const identity = { fingerprint, requestId, durable: digest !== undefined }
  if (identity.durable) writePendingRuns(sessionId, [...stored.filter(item => item.fingerprint !== fingerprint), identity])
  return identity
}

export function clearPendingRunIdentity(sessionId: string, identity: PendingRunIdentity): void {
  if (identity.durable) writePendingRuns(sessionId, readPendingRuns(sessionId).filter(item => item.requestId !== identity.requestId))
}

function readPendingRuns(sessionId: string): readonly Omit<PendingRunIdentity, 'durable'>[] {
  const data = readLocal(key(sessionId, 'pending-run-starts'))
  if (!Array.isArray(data)) return []
  return data.filter((item): item is Omit<PendingRunIdentity, 'durable'> => isObject(item)
    && typeof item.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(item.fingerprint)
    && typeof item.requestId === 'string' && /^[a-f0-9-]{32,36}$/.test(item.requestId))
}

function writePendingRuns(sessionId: string, entries: readonly Omit<PendingRunIdentity, 'durable'>[]): void {
  try {
    const items = entries.slice(-20).map(({ fingerprint, requestId }) => ({ fingerprint, requestId }))
    window.localStorage.setItem(key(sessionId, 'pending-run-starts'), JSON.stringify(items))
  } catch { /* In-memory admission identity still covers an open Canvas. */ }
}

function canonicalRunRequest(value: unknown): string {
  return JSON.stringify(value, (_key, child: unknown) => !isObject(child)
    ? child : Object.fromEntries(Object.keys(child).sort().map(key => [key, child[key]])))
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

export function downloadCanvasFile(content: Blob, name: string): void {
  const url = URL.createObjectURL(content)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name.replace(/[^a-zA-Z0-9._-]/g, '_')
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

/** The Host performs complete schema and policy validation. This checks editor-safe structure. */
export function parseCanvasTemplate(source: string): CanvasWorkflowTemplate | undefined {
  const document = parseJsonObject(source)
  if (document?.apiVersion !== 'workflow.gm-hz.dev/v1' || document.kind !== 'WorkflowTemplate') return undefined
  const { metadata, spec, layout } = document
  if (!isObject(metadata) || typeof metadata.id !== 'string' || typeof metadata.name !== 'string'
    || (metadata.description !== undefined && typeof metadata.description !== 'string')
    || !isObject(spec) || !isObject(spec.inputSchema) || !isObject(spec.outputSchema) || !isObject(spec.outputs)
    || !Array.isArray(spec.nodes) || !Array.isArray(spec.edges)
    || (layout !== undefined && !isObject(layout))) return undefined
  if (!spec.nodes.every(node => isObject(node) && typeof node.id === 'string' && typeof node.uses === 'string'
    && (node.title === undefined || typeof node.title === 'string')
    && isObject(node.with) && isObject(node.inputs) && Object.values(node.inputs).every(isBinding))) return undefined
  if (!spec.edges.every(edge => isObject(edge) && typeof edge.id === 'string' && typeof edge.source === 'string'
    && typeof edge.target === 'string' && (edge.sourcePort === undefined || typeof edge.sourcePort === 'string'))
    || !Object.values(spec.outputs).every(isBinding)) return undefined
  if (spec.requires !== undefined && (!Array.isArray(spec.requires)
    || !spec.requires.every(item => isObject(item) && typeof item.kind === 'string' && typeof item.uses === 'string'))) return undefined
  return document as unknown as CanvasWorkflowTemplate
}

function isBinding(value: unknown): boolean {
  if (!isObject(value)) return false
  if (Object.hasOwn(value, 'literal')) return true
  if (isObject(value.input)) return isPath(value.input.path)
  return isObject(value.output) && typeof value.output.nodeId === 'string' && isPath(value.output.path)
}

function isPath(value: unknown): boolean {
  return Array.isArray(value) && value.every(item => typeof item === 'string' || Number.isSafeInteger(item))
}
