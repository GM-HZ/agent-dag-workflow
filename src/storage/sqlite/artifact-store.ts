import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import { artifactRef, verifyArtifact, type WorkflowArtifact, type WorkflowArtifactRef, type WorkflowArtifactStore } from '../../journal/index.js'
import { openWorkflowDatabase, transaction, type SqliteWorkflowOptions } from './database.js'

export type SqliteWorkflowArtifactStoreOptions = SqliteWorkflowOptions

export class SqliteWorkflowArtifactStore implements WorkflowArtifactStore {
  readonly #db: DatabaseSync

  constructor(options: SqliteWorkflowArtifactStoreOptions) { this.#db = openWorkflowDatabase(options) }
  close(): void { this.#db.close() }

  async put(content: Uint8Array, options: { readonly mediaType: string; readonly redacted?: boolean }): Promise<WorkflowArtifactRef> {
    const snapshot = Uint8Array.from(content)
    const ref = artifactRef(snapshot, options.mediaType, options.redacted ?? false)
    transaction(this.#db, () => {
      this.#db.prepare(`INSERT INTO workflow_artifacts (digest, size, media_type, redacted, content, created_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(digest) DO NOTHING`)
        .run(ref.digest, ref.size, ref.mediaType, ref.redacted ? 1 : 0, snapshot, Date.now())
    })
    return ref
  }

  async read(refs: readonly WorkflowArtifactRef[]): Promise<readonly WorkflowArtifact[]> {
    return refs.map(ref => {
      const row = this.#db.prepare('SELECT digest, size, media_type, redacted, content FROM workflow_artifacts WHERE digest = ?').get(ref.digest)
      if (row === undefined) throw new Error(`workflow artifact not found: ${ref.digest}`)
      const record = row as Record<string, SQLOutputValue>
      const content = record.content
      if (!(content instanceof Uint8Array)) throw new Error(`workflow artifact content is invalid: ${ref.digest}`)
      const artifact: WorkflowArtifact = {
        digest: text(record.digest),
        size: integer(record.size),
        mediaType: text(record.media_type),
        redacted: integer(record.redacted) === 1,
        content: Uint8Array.from(content),
      }
      if (artifact.digest !== ref.digest || artifact.size !== ref.size || artifact.mediaType !== ref.mediaType || artifact.redacted !== ref.redacted) {
        throw new Error(`workflow artifact metadata mismatch: ${ref.digest}`)
      }
      verifyArtifact(artifact)
      return artifact
    })
  }
}

function text(value: SQLOutputValue | undefined): string {
  if (typeof value !== 'string') throw new Error('workflow artifact text column is invalid')
  return value
}
function integer(value: SQLOutputValue | undefined): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('workflow artifact integer column is invalid')
  return value
}
