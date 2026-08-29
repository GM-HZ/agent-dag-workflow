import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runWorkflowCli, type WorkflowCliIo } from '../../src/adapters/cli/index.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('agent-workflow CLI protocol', () => {
  it('uses versioned envelopes and persists search, describe, run, trace, and replay across invocations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-workflow-cli-'))
    roots.push(root)
    const database = join(root, 'workflow.db')
    const input = join(root, 'input.json')
    writeFileSync(input, JSON.stringify({ customer: ' acme ', orders: [{ id: '1', amount: 12, approved: true }] }))
    const template = join(process.cwd(), 'examples', 'script-transform.workflow.json')
    const lines: string[] = []

    expect(await runWorkflowCli(['validate', template, '--db', database], line => lines.push(line))).toBe(0)
    expect(data(lines.pop()!)).toEqual({ diagnostics: [] })

    expect(await runWorkflowCli(['draft', 'put', template, '--db', database], line => lines.push(line))).toBe(0)
    const draft = data(lines.pop()!) as { readonly id: string; readonly revision: number; readonly template?: unknown }
    expect(draft).toMatchObject({ id: 'script-transform-demo', revision: 1 })
    expect(draft.template).toBeUndefined()

    expect(await runWorkflowCli(['publish', draft.id, '--expected', String(draft.revision), '--db', database], line => lines.push(line))).toBe(0)
    expect(data(lines.pop()!)).toMatchObject({ ref: 'script-transform-demo@1' })

    expect(await runWorkflowCli(['search', 'transform', '--db', database], line => lines.push(line))).toBe(0)
    expect(data(lines.pop()!)).toMatchObject({ items: [expect.objectContaining({ ref: 'script-transform-demo@1' })] })
    expect(await runWorkflowCli(['describe', 'script-transform-demo@1', '--view', 'schema', '--db', database], line => lines.push(line))).toBe(0)
    expect(data(lines.pop()!)).toMatchObject({ inputSchema: { required: ['customer', 'orders'] } })

    expect(await runWorkflowCli(['run', 'script-transform-demo@1', '--input', input, '--db', database], line => lines.push(line))).toBe(0)
    const result = data(lines.pop()!) as { runId: string; status: string }
    expect(result.status).toBe('completed')

    expect(await runWorkflowCli(['run-get', result.runId, '--db', database], line => lines.push(line))).toBe(0)
    const run = data(lines.pop()!) as Record<string, unknown>
    expect(run).toMatchObject({ runId: result.runId, ref: 'script-transform-demo@1', status: 'completed' })
    expect(run.plan).toBeUndefined()

    expect(await runWorkflowCli(['trace', result.runId, '--events', '--limit', '5', '--db', database], line => lines.push(line))).toBe(0)
    const trace = data(lines.pop()!) as { readonly events: readonly { readonly runId: string }[] }
    expect(trace.events.map(event => event.runId)).toContain(result.runId)

    expect(await runWorkflowCli(['replay', result.runId, '--mode', 'recorded', '--db', database], line => lines.push(line))).toBe(0)
    const replay = data(lines.pop()!) as { runId: string; status: string }
    expect(replay.status).toBe('completed')
    expect(replay.runId).not.toBe(result.runId)
  })

  it('reads a template and run inputs from stdin without mixing diagnostics into stdout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-workflow-cli-stdin-'))
    roots.push(root)
    const database = join(root, 'workflow.db')
    const templatePath = join(process.cwd(), 'examples', 'script-transform.workflow.json')
    const output: string[] = []
    const diagnostics: string[] = []
    let stdin = readFileSync(templatePath, 'utf8')
    const io: WorkflowCliIo = { stdout: line => output.push(line), stderr: line => diagnostics.push(line), async readStdin() { return stdin } }
    expect(await runWorkflowCli(['draft', 'put', '-', '--db', database], io)).toBe(0)
    expect(data(output.pop()!)).toMatchObject({ id: 'script-transform-demo' })
    expect(diagnostics).toEqual([])
    expect(await runWorkflowCli(['publish', 'script-transform-demo', '--expected', '1', '--db', database], io)).toBe(0)
    output.pop()
    stdin = JSON.stringify({ customer: ' stdin ', orders: [] })
    expect(await runWorkflowCli(['run', 'script-transform-demo@1', '--input', '-', '--db', database], io)).toBe(0)
    expect(data(output.pop()!)).toMatchObject({ status: 'completed', outputs: { customer: 'STDIN' } })
  })

  it('returns a stable error envelope and exit code for a missing exact revision', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-workflow-cli-error-'))
    roots.push(root)
    const output: string[] = []
    const diagnostics: string[] = []
    const io: WorkflowCliIo = { stdout: line => output.push(line), stderr: line => diagnostics.push(line), async readStdin() { return '' } }
    expect(await runWorkflowCli(['run', 'script-transform-demo', '--db', join(root, 'workflow.db')], io)).toBe(2)
    const envelope = JSON.parse(output.pop()!) as { readonly ok: boolean; readonly error: { readonly code: string } }
    expect(envelope).toMatchObject({ protocolVersion: 'agent-workflow.cli/v1', ok: false, error: { code: 'WORKFLOW_REVISION_REQUIRED' } })
  })

  it('fails closed on unknown, duplicate, or trailing command arguments', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-workflow-cli-arguments-'))
    roots.push(root)
    const database = join(root, 'workflow.db')
    const output: string[] = []
    const diagnostics: string[] = []
    const io: WorkflowCliIo = { stdout: line => output.push(line), stderr: line => diagnostics.push(line), async readStdin() { return '' } }

    expect(await runWorkflowCli(['search', '--limt', '1', '--db', database], io)).toBe(2)
    expect(JSON.parse(output.pop()!)).toMatchObject({ ok: false, error: { code: 'WORKFLOW_REQUEST_INVALID', message: 'unknown option: --limt' } })
    expect(await runWorkflowCli(['search', '--limit', '1', '--limit', '2', '--db', database], io)).toBe(2)
    expect(JSON.parse(output.pop()!)).toMatchObject({ ok: false, error: { message: 'option may only be supplied once: --limit' } })
    expect(await runWorkflowCli(['run-get', 'run-1', 'unexpected', '--db', database], io)).toBe(2)
    expect(JSON.parse(output.pop()!)).toMatchObject({ ok: false, error: { message: 'command expects 1 positional argument(s), received 2' } })
    expect(diagnostics).toHaveLength(3)
    expect(existsSync(database)).toBe(false)
  })

  it('persists a detached run and completes it through the leased CLI worker', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-workflow-cli-background-'))
    roots.push(root)
    const database = join(root, 'workflow.db')
    const host = join(root, 'host.mjs')
    writeFileSync(host, `export default {
      authorityRef: 'cli:background-test',
      authority: { kind: 'foreground-authority' },
      authorityResolver: { async resolve(ref) { return ref === 'cli:background-test' ? { kind: 'worker-authority' } : undefined } }
    }\n`)
    const template = join(process.cwd(), 'examples', 'script-transform.workflow.json')
    const lines: string[] = []
    await runWorkflowCli(['draft', 'put', template, '--db', database, '--host', host], line => lines.push(line))
    lines.pop()
    await runWorkflowCli(['publish', 'script-transform-demo', '--expected', '1', '--db', database, '--host', host], line => lines.push(line))
    lines.pop()
    expect(await runWorkflowCli([
      'run', 'script-transform-demo@1', '--input-json', JSON.stringify({ customer: ' detached ', orders: [] }),
      '--detach', '--idempotency-key', 'background-1', '--db', database, '--host', host,
    ], line => lines.push(line))).toBe(0)
    const accepted = data(lines.pop()!) as { readonly runId: string; readonly status: string }
    expect(accepted.status).toBe('accepted')
    expect(await runWorkflowCli([
      'run', 'script-transform-demo@1', '--input-json', JSON.stringify({ customer: ' detached ', orders: [] }),
      '--detach', '--idempotency-key', 'background-1', '--db', database, '--host', host,
    ], line => lines.push(line))).toBe(0)
    expect(data(lines.pop()!)).toEqual(accepted)
    expect(await runWorkflowCli(['worker', '--once', '--db', database, '--host', host], line => lines.push(line))).toBe(0)
    expect(data(lines.pop()!)).toMatchObject({ runId: accepted.runId, status: 'completed' })
    expect(await runWorkflowCli(['run-get', accepted.runId, '--db', database, '--host', host], line => lines.push(line))).toBe(0)
    expect(data(lines.pop()!)).toMatchObject({ status: 'completed', outputs: { customer: 'DETACHED' } })
  })
})

function data(source: string): unknown {
  const envelope = JSON.parse(source) as { readonly protocolVersion: string; readonly ok: boolean; readonly data?: unknown; readonly error?: unknown }
  expect(envelope.protocolVersion).toBe('agent-workflow.cli/v1')
  if (!envelope.ok) throw new Error(`CLI failed: ${JSON.stringify(envelope.error)}`)
  return envelope.data
}
