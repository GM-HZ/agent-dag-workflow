import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runWorkflowCli } from '../../src/adapters/cli/index.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('agent-workflow CLI', () => {
  it('persists runs and supports validate, trace, and recorded replay across invocations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-workflow-cli-'))
    roots.push(root)
    const database = join(root, 'workflow.db')
    const input = join(root, 'input.json')
    writeFileSync(input, JSON.stringify({ customer: ' acme ', orders: [{ id: '1', amount: 12, approved: true }] }))
    const template = join(process.cwd(), 'examples', 'script-transform.workflow.json')
    const lines: string[] = []
    expect(await runWorkflowCli(['validate', template, '--db', database], line => lines.push(line))).toBe(0)
    expect(JSON.parse(lines.pop()!)).toEqual({ diagnostics: [] })

    expect(await runWorkflowCli(['run', template, '--input', input, '--db', database], line => lines.push(line))).toBe(0)
    const result = JSON.parse(lines.pop()!) as { runId: string; status: string }
    expect(result.status).toBe('completed')

    expect(await runWorkflowCli(['trace', result.runId, '--limit', '5', '--db', database], line => lines.push(line))).toBe(0)
    expect(lines.splice(0).map(line => JSON.parse(line).runId)).toContain(result.runId)

    expect(await runWorkflowCli(['replay', result.runId, '--mode', 'recorded', '--db', database], line => lines.push(line))).toBe(0)
    const replay = JSON.parse(lines.pop()!) as { runId: string; status: string }
    expect(replay.status).toBe('completed')
    expect(replay.runId).not.toBe(result.runId)
  })
})
