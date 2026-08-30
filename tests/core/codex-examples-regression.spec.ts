import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('Codex Plugin example regression', () => {
  it('discovers, describes, runs, persists, and traces every manifest example', () => {
    const output = execFileSync(process.execPath, [
      'examples/run-codex-examples.mjs', '--json',
    ], { cwd: process.cwd(), encoding: 'utf8', timeout: 90_000 })
    const report = JSON.parse(output)
    expect(report).toMatchObject({
      protocolVersion: 'agent-dag-workflow.examples/v1',
      accessPath: 'codex-plugin-wrapper',
      passed: 9,
      total: 9,
    })
    expect(report.results).toHaveLength(9)
    expect(report.results.every((result: { status: string; events: number }) => result.status === 'completed' && result.events > 0)).toBe(true)
  }, 95_000)
})
