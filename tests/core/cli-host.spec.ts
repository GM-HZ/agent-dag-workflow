import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  defineWorkflowCliHost,
  loadWorkflowCliHost,
  runWorkflowCli,
  validateWorkflowCliHost,
} from '../../src/adapters/cli/index.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('CLI Host Adapter experience', () => {
  it('defines and validates only the gateways a Host actually supplies', () => {
    const host = defineWorkflowCliHost({
      authorityRef: 'test:minimal',
      services: { tools: { async execute() { return { ok: true } } } },
    })
    expect(validateWorkflowCliHost(host)).toBe(host)
    expect(host.services.tools.execute).toBeTypeOf('function')
  })

  it('checks every optional Host seam without requiring unused gateways', () => {
    expect(() => validateWorkflowCliHost({ authorityRef: '' })).toThrow(expect.objectContaining({ code: 'WORKFLOW_HOST_INVALID' }))
    expect(() => validateWorkflowCliHost({ registerNodes: true })).toThrow(expect.objectContaining({ code: 'WORKFLOW_HOST_INVALID' }))
    expect(() => validateWorkflowCliHost({ authorityResolver: {} })).toThrow(expect.objectContaining({ code: 'WORKFLOW_HOST_INVALID' }))
    expect(() => validateWorkflowCliHost({ services: { agents: {}, approvals: {}, subworkflows: {}, capabilities: {} } }))
      .toThrow(expect.objectContaining({ code: 'WORKFLOW_HOST_INVALID' }))
    expect(validateWorkflowCliHost({ services: {} })).toEqual({ services: {} })
  })

  it('loads the checked-in minimal Host and runs the Tool workflow end to end', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-workflow-minimal-host-'))
    roots.push(root)
    const database = join(root, 'workflow.db')
    const host = join(process.cwd(), 'examples', 'minimal-host.mjs')
    const template = join(process.cwd(), 'examples', 'tool-echo.workflow.yaml')
    const output: string[] = []

    expect((await loadWorkflowCliHost(host)).services?.tools?.execute).toBeTypeOf('function')
    expect(await runWorkflowCli(['draft', 'put', template, '--db', database, '--host', host], line => output.push(line))).toBe(0)
    output.pop()
    expect(await runWorkflowCli(['publish', 'tool-echo', '--expected', '1', '--db', database, '--host', host], line => output.push(line))).toBe(0)
    output.pop()
    expect(await runWorkflowCli([
      'run', 'tool-echo@1', '--input-json', '{"message":"hello"}', '--db', database, '--host', host,
    ], line => output.push(line))).toBe(0)
    expect(JSON.parse(output.pop()!)).toMatchObject({ ok: true, data: { status: 'completed', outputs: { answer: 'hello' } } })
  })

  it('fails before opening SQLite when the Host contract is malformed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-workflow-invalid-host-'))
    roots.push(root)
    const host = join(root, 'host.mjs')
    const database = join(root, 'workflow.db')
    writeFileSync(host, 'export default { services: { tools: {} } }\n')
    const output: string[] = []

    expect(await runWorkflowCli(['search', '--db', database, '--host', host], line => output.push(line))).toBe(2)
    expect(JSON.parse(output.pop()!)).toMatchObject({
      ok: false,
      error: {
        code: 'WORKFLOW_HOST_INVALID',
        message: expect.stringContaining('tools.execute must be a function'),
        hints: expect.arrayContaining([expect.stringContaining('Provider layer is not required')]),
      },
    })
    expect(existsSync(database)).toBe(false)
  })

  it('distinguishes module loading failures from Host contract failures', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-workflow-missing-host-'))
    roots.push(root)
    const missing = join(root, 'missing.mjs')
    const output: string[] = []
    expect(await runWorkflowCli(['search', '--db', join(root, 'workflow.db'), '--host', missing], line => output.push(line))).toBe(2)
    expect(JSON.parse(output.pop()!)).toMatchObject({
      error: { code: 'WORKFLOW_HOST_LOAD_FAILED', hints: expect.arrayContaining([expect.stringContaining('--host')]) },
    })
  })

  it('adds Trace and Host next actions when a workflow node lacks its Gateway', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-workflow-host-hint-'))
    roots.push(root)
    const database = join(root, 'workflow.db')
    const template = join(process.cwd(), 'examples', 'tool-echo.workflow.yaml')
    const output: string[] = []
    await runWorkflowCli(['draft', 'put', template, '--db', database], line => output.push(line))
    output.pop()
    await runWorkflowCli(['publish', 'tool-echo', '--expected', '1', '--db', database], line => output.push(line))
    output.pop()
    expect(await runWorkflowCli(['run', 'tool-echo@1', '--input-json', '{"message":"hello"}', '--db', database], line => output.push(line))).toBe(5)
    const envelope = JSON.parse(output.pop()!)
    expect(envelope).toMatchObject({ ok: true, data: { status: 'failed', hints: expect.any(Array) } })
    expect(envelope.data.hints.join('\n')).toContain(`trace ${envelope.data.runId} --events`)
    expect(envelope.data.hints.join('\n')).toContain('--host <module.mjs>')
  })
})
