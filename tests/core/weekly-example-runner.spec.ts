import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('weekly AI model example runner', () => {
  it('installs, publishes, runs, audits, and reuses the immutable revision', () => {
    const root = mkdtempSync(join(tmpdir(), 'weekly-example-runner-'))
    roots.push(root)
    const database = join(root, 'workflow.db')

    const first = runExample(database)
    expect(first.mode).toBe('deterministic-offline')
    expect(first.workflowRef).toBe('weekly-ai-model-news@1')
    expect(first.result.status).toBe('completed')
    expect(first.result.outputs).toMatchObject({ candidateCount: 100 })
    expect(first.result.outputs.items).toHaveLength(10)
    expect(first.audit).toMatchObject({ completedNodes: 21, externalInvocations: 17 })
    expect(first.traceCommand).toContain(first.result.runId)
    const traceEnvelope = JSON.parse(execFileSync(first.traceCommand[0], first.traceCommand.slice(1), {
      cwd: process.cwd(), encoding: 'utf8',
    }))
    expect(traceEnvelope).toMatchObject({ ok: true, data: { run: { runId: first.result.runId, status: 'completed' } } })
    expect(traceEnvelope.data.events).toHaveLength(first.audit.eventCount)

    const second = runExample(database)
    expect(second.workflowRef).toBe(first.workflowRef)
    expect(second.result.runId).not.toBe(first.result.runId)
    expect(second.result.outputs).toEqual(first.result.outputs)
  })
})

function runExample(database: string): any {
  const output = execFileSync(process.execPath, [
    'examples/run-weekly-ai-model-news.mjs', '--', '--db', database, '--json',
  ], { cwd: process.cwd(), encoding: 'utf8' })
  return JSON.parse(output)
}
