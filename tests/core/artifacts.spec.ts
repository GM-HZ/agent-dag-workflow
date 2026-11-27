import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { InMemoryWorkflowCatalogRepository, WorkflowTemplateCatalog } from '../../src/catalog/index.js'
import { InMemoryWorkflowRunStore, registerCoreNodes, stableJsonStringify, WorkflowNodeRegistry, type JsonObject } from '../../src/core/index.js'
import { createWorkflowEvidence, InMemoryWorkflowArtifactStore, verifyWorkflowEvidence } from '../../src/journal/index.js'
import { WorkflowRuntime } from '../../src/runtime/index.js'
import { SqliteWorkflowArtifactStore } from '../../src/storage/sqlite/index.js'
import { toolWorkflowTemplate } from './fixtures.js'

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

  it('verifies evidence Journal identity, referenced bytes and protected redaction fields under a valid checksum', async () => {
    const nodes = new WorkflowNodeRegistry()
    registerCoreNodes(nodes)
    const artifacts = new InMemoryWorkflowArtifactStore()
    const runs = new InMemoryWorkflowRunStore()
    const runtime = new WorkflowRuntime({ nodes, catalog: new WorkflowTemplateCatalog(new InMemoryWorkflowCatalogRepository(), nodes),
      runStore: runs, artifactStore: artifacts,
      capturePolicy: { mode: 'standard', maxArtifactBytes: 1024 }, services: { tools: { async execute() { return { echo: 'public' } } } },
    })
    const handle = await runtime.launch({ target: { type: 'inline', template: toolWorkflowTemplate() }, inputs: { message: 'private-input' },
      authorityRef: 'test', authority: {}, origin: { type: 'sdk' },
    })
    await expect(handle.result).resolves.toMatchObject({ status: 'completed' })
    const record = (await runs.loadRun(handle.runId))!
    const evidence = await createWorkflowEvidence(record, { artifactStore: artifacts })
    expect(verifyWorkflowEvidence(evidence)).toEqual({ sha256: evidence.sha256 })
    const redacted = await createWorkflowEvidence(record, { artifactStore: artifacts, redactFields: ['message', 'runId', 'seq', 'artifact'] })
    expect(verifyWorkflowEvidence(redacted)).toEqual({ sha256: redacted.sha256 })
    expect(JSON.stringify(redacted)).not.toContain('private-input')

    function reseal(change: (copy: JsonObject) => void) {
      const { sha256: _digest, ...payload } = structuredClone(evidence)
      change(payload)
      return { ...payload, sha256: createHash('sha256').update(stableJsonStringify(payload)).digest('hex') }
    }
    expect(() => verifyWorkflowEvidence(reseal(copy => { (copy.run as JsonObject).runId = 'elsewhere' }))).toThrow(/identity/)
    expect(() => verifyWorkflowEvidence(reseal(copy => { (copy.artifacts as JsonObject[]).pop() }))).toThrow(/missing.*artifact/)
    expect(() => verifyWorkflowEvidence(reseal(copy => { (copy.artifacts as JsonObject[])[0]!.base64 = Buffer.from('wrong').toString('base64') }))).toThrow(/digest mismatch/)
  })
})
import { createHash } from 'node:crypto'
