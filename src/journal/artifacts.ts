import { createHash } from 'node:crypto'

export interface WorkflowArtifactRef {
  readonly digest: string
  readonly size: number
  readonly mediaType: string
  readonly redacted: boolean
}

export interface WorkflowArtifact extends WorkflowArtifactRef {
  readonly content: Uint8Array
}

export interface WorkflowCapturePolicy {
  readonly mode: 'metadata' | 'standard' | 'replayable'
  readonly maxArtifactBytes: number
  readonly retentionDays?: number
  readonly encryptArtifacts?: boolean
}

export interface WorkflowArtifactStore {
  readonly capabilities?: {
    /** True only when the concrete deployment encrypts artifact bytes at rest. */
    readonly encryptionAtRest: boolean
    /** True only when the store enforces automatic retention expiry. */
    readonly retentionPolicy: boolean
  }
  put(content: Uint8Array, options: { readonly mediaType: string; readonly redacted?: boolean }): Promise<WorkflowArtifactRef>
  read(refs: readonly WorkflowArtifactRef[]): Promise<readonly WorkflowArtifact[]>
}

export class InMemoryWorkflowArtifactStore implements WorkflowArtifactStore {
  readonly capabilities = Object.freeze({ encryptionAtRest: false, retentionPolicy: false })
  readonly #artifacts = new Map<string, WorkflowArtifact>()

  async put(content: Uint8Array, options: { readonly mediaType: string; readonly redacted?: boolean }): Promise<WorkflowArtifactRef> {
    const snapshot = Uint8Array.from(content)
    const ref = artifactRef(snapshot, options.mediaType, options.redacted ?? false)
    this.#artifacts.set(ref.digest, Object.freeze({ ...ref, content: snapshot }))
    return ref
  }

  async read(refs: readonly WorkflowArtifactRef[]): Promise<readonly WorkflowArtifact[]> {
    return refs.map(ref => {
      const artifact = this.#artifacts.get(ref.digest)
      if (artifact === undefined || !sameRef(artifact, ref)) throw new Error(`workflow artifact missing or metadata mismatch: ${ref.digest}`)
      verifyArtifact(artifact)
      return Object.freeze({ ...artifact, content: Uint8Array.from(artifact.content) })
    })
  }
}

export function artifactRef(content: Uint8Array, mediaType: string, redacted: boolean): WorkflowArtifactRef {
  if (mediaType.length === 0) throw new Error('artifact mediaType is required')
  return Object.freeze({ digest: digest(content), size: content.byteLength, mediaType, redacted })
}

export function verifyArtifact(artifact: WorkflowArtifact): void {
  if (artifact.content.byteLength !== artifact.size || digest(artifact.content) !== artifact.digest) {
    throw new Error(`workflow artifact digest mismatch: ${artifact.digest}`)
  }
}

function digest(content: Uint8Array): string { return createHash('sha256').update(content).digest('hex') }
function sameRef(left: WorkflowArtifactRef, right: WorkflowArtifactRef): boolean {
  return left.digest === right.digest && left.size === right.size && left.mediaType === right.mediaType && left.redacted === right.redacted
}
