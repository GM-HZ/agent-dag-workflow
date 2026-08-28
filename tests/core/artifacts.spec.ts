import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { InMemoryWorkflowArtifactStore } from '../../src/journal/index.js'
import { SqliteWorkflowArtifactStore } from '../../src/storage/sqlite/index.js'

describe('content-addressed workflow artifacts', () => {
  it('verifies memory and SQLite artifacts by digest and metadata', async () => {
    const content = new TextEncoder().encode('{"answer":42}')
    const memory = new InMemoryWorkflowArtifactStore()
    const ref = await memory.put(content, { mediaType: 'application/json' })
    expect((await memory.read([ref]))[0]?.content).toEqual(content)
    await expect(memory.read([{ ...ref, size: ref.size + 1 }])).rejects.toThrow(/metadata/)

    const directory = mkdtempSync(join(tmpdir(), 'workflow-artifact-'))
    try {
      const sqlite = new SqliteWorkflowArtifactStore({ path: join(directory, 'workflow.sqlite') })
      const sqliteRef = await sqlite.put(content, { mediaType: 'application/json', redacted: true })
      expect(await sqlite.read([sqliteRef])).toMatchObject([{ digest: sqliteRef.digest, redacted: true, content }])
      sqlite.close()
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
