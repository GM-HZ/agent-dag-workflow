import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runWorkflowCli, type WorkflowCliIo } from '../../src/adapters/cli/index.js'
import { toolWorkflowTemplate } from './fixtures.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('agent-workflow CLI protocol', () => {
  it('summarizes each authorized attempt across Journal pages and excludes recorded Host usage', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adw-trace-stats-'))
    roots.push(root)
    const database = join(root, 'workflow.db')
    const template = join(root, 'audit.workflow.json')
    const host = join(root, 'audit-host.mjs')
    const base = toolWorkflowTemplate()
    const marker = 'private-stats-input'
    writeFileSync(template, JSON.stringify({ ...base, spec: { ...base.spec, requires: [],
      nodes: base.spec.nodes.map(node => node.id === 'call'
        ? { ...node, uses: 'fixture.audit-tool@1', with: {}, policy: { retry: { maxAttempts: 2 } } } : node),
    } }))
    writeFileSync(host, `let attempts = 0
export default { registerNodes(registry) {
  registry.register({ type: 'fixture.audit-tool', version: 1, title: 'Audit Tool', description: 'Retry fixture',
    configSchema: { type: 'object' }, inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
    outputPorts: ['success'], capabilities: [], effects: 'external', retry: 'safe', implementationDigest: 'audit-fixture-v1',
    async execute({ inputs, reportEvidence }) {
      const first = ++attempts === 1
      reportEvidence?.(first
        ? { modelId: 'fixture/model-v3', toolVersion: 'audit-tool@3.0.0', durationMs: 3.25, usage: { inputTokens: 2 } }
        : { modelId: 'fixture/model-v4', toolVersion: 'audit-tool@4.0.0', durationMs: 8.75, usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 } })
      if (first) throw new Error('transient upstream error')
      return { outputs: { result: { echo: inputs.message } } }
    },
  })
} }
`)
    const lines: string[] = []
    const cli = (...args: string[]) => runWorkflowCli([...args, '--db', database], line => lines.push(line))
    const hostArgs = ['--host', host]
    expect(await cli('draft', 'put', template, ...hostArgs)).toBe(0)
    lines.pop()
    expect(await cli('publish', 'tool-flow', '--expected', '1', ...hostArgs)).toBe(0)
    lines.pop()
    expect(await cli('run', 'tool-flow@1', '--input-json', JSON.stringify({ message: marker }), ...hostArgs)).toBe(0)
    const { runId } = data(lines.pop()!) as { readonly runId: string }

    expect(await cli('trace', runId, '--stats', '--limit', '1')).toBe(0)
    const source = lines.pop()!
    expect(source).not.toContain(marker)
    const hostMetrics = {
      requested: 2, completed: 1, failed: 1, replayed: 0,
      modelIds: ['fixture/model-v3', 'fixture/model-v4'], toolVersions: ['audit-tool@3.0.0', 'audit-tool@4.0.0'],
      duration: { samples: 2, totalMs: 12, maxMs: 8.75 }, usageSamples: 2,
      usage: { inputTokens: 5, outputTokens: 5, totalTokens: 8 },
    }
    expect(data(source)).toMatchObject({ format: 'agent-dag-workflow.trace-stats/v1', runId, status: 'completed', ref: 'tool-flow@1',
      totals: { attempts: 4, failures: 1, retries: 1, duration: { samples: 4 }, host: hostMetrics },
      nodes: expect.arrayContaining([expect.objectContaining({ nodeId: 'call', uses: 'fixture.audit-tool@1', status: 'succeeded',
        attempts: 2, failures: 1, retries: 1, duration: { samples: 2, totalMs: expect.any(Number), maxMs: expect.any(Number) }, host: hostMetrics })]),
    })

    expect(await cli('replay', runId, '--mode', 'recorded', ...hostArgs)).toBe(0)
    const replayId = (data(lines.pop()!) as { readonly runId: string }).runId
    expect(await cli('trace', replayId, '--stats', '--limit', '1')).toBe(0)
    const replayStats = data(lines.pop()!) as { readonly totals: { readonly host: object } }
    expect(replayStats).toMatchObject({ runId: replayId, totals: { attempts: 3, failures: 0, retries: 0, host: {
      completed: 0, failed: 0, replayed: 1, modelIds: ['fixture/model-v4'], toolVersions: ['audit-tool@4.0.0'],
      duration: { samples: 0, totalMs: 0, maxMs: 0 }, usageSamples: 0,
    } } })
    expect(replayStats.totals.host).not.toHaveProperty('usage')
    expect(await cli('trace', runId, '--stats', '--authority', 'cli:other')).toBe(4)
    expect(JSON.parse(lines.pop()!)).toMatchObject({ error: { code: 'WORKFLOW_AUTHORITY_DENIED' } })
    expect(await cli('trace', runId, '--stats', '--format', 'jsonl')).toBe(2)
    expect(JSON.parse(lines.pop()!)).toMatchObject({ error: { code: 'WORKFLOW_REQUEST_INVALID' } })
  })

  it('verifies an atomic Journal export, builds a failed offline case, and restores a local backup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adw-audit-and-restore-'))
    roots.push(root)
    const database = join(root, 'original.db')
    const databaseArgs = ['--db', database]
    const lines: string[] = []
    const run = (...args: string[]) => runWorkflowCli(args, line => lines.push(line))
    const workflow = join(process.cwd(), 'examples', 'tool-echo.workflow.yaml')
    expect(await run('help', 'trace')).toBe(0)
    expect(lines.pop()).toContain('trace RUN_ID')
    expect(await run('doctor', ...databaseArgs)).toBe(0)
    expect(data(lines.pop()!)).toMatchObject({ state: 'missing', database })
    expect(existsSync(database)).toBe(false)
    expect(await run('draft', 'put', workflow, ...databaseArgs)).toBe(0)
    lines.pop()
    expect(await run('publish', 'tool-echo', '--expected', '1', ...databaseArgs)).toBe(0)
    lines.pop()
    expect(await run('validate', workflow, '--input-json', '{}', '--strict', ...databaseArgs)).toBe(3)
    expect(JSON.parse(lines.pop()!)).toMatchObject({ error: { code: 'WORKFLOW_VALIDATION_FAILED' } })
    expect(await run('run', 'tool-echo@1', '--input-json', '{"message":"personal-example"}', ...databaseArgs)).toBe(5)
    const { runId } = data(lines.pop()!) as { readonly runId: string }

    expect(await run('trace', runId, '--events', '--format', 'jsonl', '--limit', '2', ...databaseArgs)).toBe(0)
    expect(lines.splice(0).map(data)).toMatchObject([{ seq: 1 }, { seq: 2 }])
    const journal = join(root, 'journal.jsonl')
    expect(await run('trace', runId, '--all', '--output', journal, '--limit', '2', ...databaseArgs)).toBe(0)
    expect(data(lines.pop()!)).toMatchObject({ runId, path: journal })
    const originalJournal = readFileSync(journal, 'utf8')
    expect(await run('trace', runId, '--all', '--output', journal, ...databaseArgs)).not.toBe(0)
    lines.pop()
    expect(readFileSync(journal, 'utf8')).toBe(originalJournal)
    expect(await run('verify-log', journal)).toBe(0)
    expect(data(lines.pop()!)).toMatchObject({ runId })
    writeFileSync(journal, originalJournal.trimEnd().split('\n').slice(0, -1).join('\n'))
    expect(await run('verify-log', journal)).not.toBe(0)
    lines.pop()

    const evidence = join(root, 'evidence.json')
    expect(await run('evidence', runId, '--output', evidence, '--artifacts', '--redact', 'message', ...databaseArgs)).toBe(0)
    const { sha256 } = data(lines.pop()!) as { readonly sha256: string }
    expect(readFileSync(evidence, 'utf8')).not.toContain('personal-example')
    expect(await run('verify-evidence', evidence)).toBe(0)
    expect(data(lines.pop()!)).toEqual({ sha256 })

    const sample = join(root, 'failure.case.json')
    expect(await run('case', 'from-run', runId, '--output', sample, ...databaseArgs)).toBe(0)
    lines.pop()
    expect(JSON.parse(readFileSync(sample, 'utf8'))).toMatchObject({ expected: { status: 'failed', failedNode: 'echo' } })
    expect(await run('case', 'compare', sample, '--base', 'tool-echo@1', '--candidate', workflow, ...databaseArgs)).toBe(0)
    expect(data(lines.pop()!)).toMatchObject({ passed: true, results: [{ classification: 'passed', baseline: { passed: true }, candidate: { passed: true } }] })
    const changed = join(root, 'changed.case.json')
    const fixture = JSON.parse(readFileSync(sample, 'utf8'))
    writeFileSync(changed, JSON.stringify({ ...fixture, expected: { status: 'completed' } }))
    const report = join(root, 'comparison.json')
    expect(await run('case', 'compare', changed, '--base', 'tool-echo@1', '--candidate', workflow, '--output', report, ...databaseArgs)).toBe(5)
    expect(data(lines.pop()!)).toMatchObject({ passed: false, path: report, cases: 1 })
    expect(JSON.parse(readFileSync(report, 'utf8'))).toMatchObject({
      format: 'agent-dag-workflow.case-report/v1', baseline: { ref: 'tool-echo@1' },
      results: [{ classification: 'baseline-drift', candidate: { passed: false, status: 'failed' } }],
    })

    const unbound = join(root, 'unbound.case.json')
    delete fixture.recorded.echo.expectedInputs
    writeFileSync(unbound, JSON.stringify(fixture))
    expect(await run('case', 'compare', unbound, '--base', 'tool-echo@1', '--candidate', workflow, ...databaseArgs)).toBe(5)
    expect(data(lines.pop()!)).toMatchObject({ passed: false, results: [{ classification: 'insufficient-fixtures', phase: 'baseline',
      baseline: { status: 'failed', passed: false, errorCode: 'RECORDED_OUTPUT_MISSING' },
    }] })

    const host = join(root, 'review-host.mjs')
    writeFileSync(host, `export default { services: { agents: { async execute(request) {
      request.reportEvidence?.({ modelId: 'fixture-model', childRunId: 'fixture-review' })
      return { runId: 'fixture-review', content: [], structured: { approved: true, reason: 'reviewed' } }
    } } } }\n`)
    expect(await run('case', 'compare', sample, '--base', 'tool-echo@1', '--candidate', workflow, '--host', host, '--review', ...databaseArgs)).toBe(0)
    const reviewed = data(lines.pop()!) as { readonly results: readonly { readonly review: { readonly runId: string } }[] }
    expect(reviewed).toMatchObject({ passed: true, results: [{ review: { approved: true, reason: 'reviewed' } }] })
    expect(await run('trace', reviewed.results[0]!.review.runId, '--events', ...databaseArgs)).toBe(0)
    expect(data(lines.pop()!)).toMatchObject({ events: expect.arrayContaining([expect.objectContaining({
      type: 'capability.completed', hostEvidence: { modelId: 'fixture-model', childRunId: 'fixture-review' },
    })]) })

    const snapshot = join(root, 'backup.db')
    expect(await run('archive', '--before', String(Date.now() + 1000), ...databaseArgs)).toBe(0)
    expect(data(lines.pop()!)).toMatchObject({ preview: true, runIds: expect.arrayContaining([runId, reviewed.results[0]!.review.runId]) })
    expect(await run('backup', snapshot, ...databaseArgs)).toBe(0)
    expect(data(lines.pop()!)).toMatchObject({ runs: 2 })
    expect(await run('backup-verify', snapshot)).toBe(0)
    expect(data(lines.pop()!)).toMatchObject({ integrity: 'ok', runs: 2 })
    const restored = join(root, 'restored.db')
    expect(await run('restore', snapshot, '--db', restored)).toBe(0)
    lines.pop()
    expect(await run('runs', '--db', restored, '--latest', '--query', 'tool')).toBe(0)
    expect(data(lines.pop()!)).toMatchObject({ items: [{ runId, status: 'failed' }] })
    const archived = join(root, 'archive.db')
    expect(await run('archive', '--before', String(Date.now() + 1000), '--apply', '--output', archived, ...databaseArgs)).toBe(0)
    expect(data(lines.pop()!)).toMatchObject({ runIds: expect.arrayContaining([runId]), backup: { runs: 2 } })
    expect(await run('runs', ...databaseArgs)).toBe(0)
    expect(data(lines.pop()!)).toEqual({ items: [] })
    expect(await run('runs', '--db', archived, '--query', 'tool')).toBe(0)
    expect(data(lines.pop()!)).toMatchObject({ items: [{ runId, status: 'failed' }] })
  })

  it('evaluates both expectations, separates baseline drift from an approved correction, and retains every case result', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adw-case-compare-'))
    roots.push(root)
    const cases = join(root, 'cases')
    mkdirSync(cases)
    const database = join(root, 'workflow.db')
    const lines: string[] = []
    const run = (...args: string[]) => runWorkflowCli([...args, '--db', database], line => lines.push(line))
    const baseline = join(process.cwd(), 'examples', 'script-transform.workflow.json')
    const source = JSON.parse(readFileSync(baseline, 'utf8'))
    const candidate = join(root, 'candidate.workflow.json')
    const normalize = source.spec.nodes.find((node: { readonly id: string }) => node.id === 'normalize')
    normalize.with.source = normalize.with.source.replace('sum(mapGet(input.orders, "amount"))', 'sum(mapGet(input.orders, "amount")) + 1')
    writeFileSync(candidate, JSON.stringify(source))
    expect(await run('demo')).toBe(0)
    const demo = data(lines.pop()!) as { readonly runId: string; readonly outputs: Record<string, unknown> }
    expect(await run('case', 'from-run', demo.runId)).toBe(0)
    const sample = data(lines.pop()!) as { readonly expected: { readonly status: 'completed'; readonly outputs: Record<string, unknown> } }
    const desired = { ...sample.expected, outputs: { ...demo.outputs, total: 101 } }
    writeFileSync(join(cases, '01-drift.json'), JSON.stringify({ ...sample, expected: desired }))
    const correction = join(cases, '02-correction.json')
    writeFileSync(correction, JSON.stringify({ ...sample, baselineExpected: sample.expected, expected: desired }))
    writeFileSync(join(cases, '03-broken.json'), '{')
    writeFileSync(join(cases, '04-regression.json'), JSON.stringify(sample))
    writeFileSync(join(cases, '05-typo.json'), JSON.stringify({ ...sample, expected: { status: 'completed', requiredNode: 'normalize' } }))
    const compare = ['--base', baseline, '--candidate', candidate]
    const reportPath = join(root, 'report.json')

    expect(await run('case', 'compare', cases, ...compare, '--output', reportPath)).toBe(5)
    const summary = { total: 5, passed: 1, failed: 4,
      byClassification: { 'baseline-drift': 1, 'expected-correction': 1, 'invalid-case': 2, 'candidate-regression': 1 } }
    expect(data(lines.pop()!)).toMatchObject({ passed: false, summary, cases: 5, path: reportPath })
    expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toMatchObject({ summary, results: [
      { classification: 'baseline-drift', phase: 'baseline', baseline: { passed: false }, candidate: { passed: true } },
      { classification: 'expected-correction', baseline: { outputs: { total: 100 } }, candidate: { outputs: { total: 101 } } },
      { classification: 'invalid-case', error: expect.any(String) },
      { classification: 'candidate-regression', phase: 'candidate', baseline: { passed: true }, candidate: { passed: false } },
      { classification: 'invalid-case', error: 'invalid expected assertions in workflow regression case' },
    ] })
    expect(await run('case', 'compare', correction, ...compare)).toBe(0)
    expect(data(lines.pop()!)).toMatchObject({ passed: true, results: [{ classification: 'expected-correction' }] })
  })

  it('runs the bundled demo inline and preserves its trace without modifying the catalog', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-workflow-cli-demo-'))
    roots.push(root)
    const database = join(root, 'workflow with spaces.db')
    const config = join(root, 'cli.json')
    writeFileSync(config, JSON.stringify({ schemaVersion: 1, database: 'workflow with spaces.db', authorityRef: 'cli:demo-test' }))
    const lines: string[] = []
    const capture = (line: string) => lines.push(line)
    const existingTemplate = JSON.parse(readFileSync(join(process.cwd(), 'examples', 'script-transform.workflow.json'), 'utf8'))
    existingTemplate.metadata.name = 'Existing orders workflow'
    const existingPath = join(root, 'existing.workflow.json')
    writeFileSync(existingPath, JSON.stringify(existingTemplate))

    expect(await runWorkflowCli(['draft', 'put', existingPath, '--config', config], capture)).toBe(0)
    const draft = data(lines.pop()!)
    expect(await runWorkflowCli(['demo', '--config', config], capture)).toBe(0)
    const demo = data(lines.pop()!) as { readonly runId: string; readonly traceCommand: readonly string[] }
    expect(demo).toMatchObject({
      templateId: 'script-transform-demo', status: 'completed',
      outputs: { customer: 'GM-HZ', orderCount: 3, total: 100, approvedIds: ['A-100', 'A-102'] },
    })
    expect(demo.traceCommand).toEqual(['adw', 'trace', demo.runId, '--events', '--db', database, '--authority', 'cli:demo-test'])
    expect(await runWorkflowCli(demo.traceCommand.slice(1), capture)).toBe(0)
    expect(data(lines.pop()!)).toMatchObject({
      run: { runId: demo.runId, ref: 'script-transform-demo', status: 'completed' },
      events: expect.arrayContaining([expect.objectContaining({ type: 'run.completed' })]),
    })
    expect(await runWorkflowCli(['run-get', demo.runId, '--db', database], capture)).toBe(4)
    expect(JSON.parse(lines.pop()!)).toMatchObject({ error: { code: 'WORKFLOW_AUTHORITY_DENIED' } })
    expect(await runWorkflowCli(['runs', '--db', database], capture)).toBe(0)
    expect(data(lines.pop()!)).toEqual({ items: [] })
    expect(await runWorkflowCli(['runs', '--workflow', demo.runId, '--config', config], capture)).toBe(0)
    expect(data(lines.pop()!)).toEqual({ items: [] })
    expect(await runWorkflowCli(['runs', '--status', 'completed', '--config', config], capture)).toBe(0)
    expect(data(lines.pop()!)).toEqual({ items: [expect.objectContaining({ runId: demo.runId, needsAttention: false })] })
    expect(await runWorkflowCli(['draft', 'get', 'script-transform-demo', '--view', 'summary', '--config', config], capture)).toBe(0)
    expect(data(lines.pop()!)).toEqual(draft)
    expect(await runWorkflowCli(['search', '--config', config], capture)).toBe(0)
    expect(data(lines.pop()!)).toEqual({ items: [] })
  })

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
    const trace = data(lines.pop()!) as { readonly events: readonly { readonly runId: string }[]; readonly nextAfterSeq?: number }
    expect(trace.events.map(event => event.runId)).toContain(result.runId)
    expect(trace.nextAfterSeq).toBeDefined()

    expect(await runWorkflowCli(['trace', result.runId, '--events', '--limit', '1000', '--db', database], line => lines.push(line))).toBe(0)
    const completeTrace = data(lines.pop()!) as { readonly events: readonly unknown[] }
    expect(await runWorkflowCli(['trace', result.runId, '--follow', '--limit', '5', '--db', database], line => lines.push(line))).toBe(0)
    expect(lines.splice(0).map(data)).toEqual(completeTrace.events)

    expect(await runWorkflowCli(['trace', result.runId, '--all', '--limit', '3', '--db', database], line => lines.push(line))).toBe(0)
    const [snapshot, ...exported] = lines.splice(0).map(line => JSON.parse(line))
    expect(snapshot).toMatchObject({
      format: 'agent-dag-workflow.journal/v1', type: 'run.snapshot',
      ref: 'script-transform-demo@1', runId: result.runId, checkpointSeq: completeTrace.events.length,
    })
    expect(exported).toEqual(completeTrace.events)

    expect(await runWorkflowCli(['replay', result.runId, '--mode', 'recorded', '--db', database], line => lines.push(line))).toBe(0)
    const replay = data(lines.pop()!) as { runId: string; status: string }
    expect(replay.status).toBe('completed')
    expect(replay.runId).not.toBe(result.runId)
    expect(await runWorkflowCli(['runs', '--limit', '1', '--db', database], line => lines.push(line))).toBe(0)
    const latest = data(lines.pop()!) as { readonly nextAfter: string; readonly items: readonly { readonly runId: string }[] }
    expect(latest.items).toEqual([expect.objectContaining({ runId: replay.runId })])
    expect(await runWorkflowCli(['runs', '--after', latest.nextAfter, '--db', database], line => lines.push(line))).toBe(0)
    expect(data(lines.pop()!)).toEqual({ items: [expect.objectContaining({ runId: result.runId })] })
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

  it('validates sample inputs before executing a workflow and only reads one source from stdin', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-workflow-cli-preflight-'))
    roots.push(root)
    const database = join(root, 'workflow.db')
    const template = join(process.cwd(), 'examples', 'script-transform.workflow.json')
    const sample = join(process.cwd(), 'examples', 'inputs', 'script-transform.json')
    const output: string[] = []
    let stdinReads = 0
    const io: WorkflowCliIo = {
      stdout: line => output.push(line),
      stderr: () => {},
      async readStdin() { stdinReads++; return readFileSync(sample, 'utf8') },
    }

    expect(await runWorkflowCli(['validate', template, '--input', sample, '--db', database], io)).toBe(0)
    expect(data(output.pop()!)).toEqual({ diagnostics: [] })
    expect(await runWorkflowCli(['validate', template, '--input-json', '{}', '--db', database], io)).toBe(0)
    expect(data(output.pop()!)).toMatchObject({
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'WORKFLOW_INPUT_INVALID', severity: 'error' })]),
    })
    expect(await runWorkflowCli(['validate', '-', '--input', '-', '--db', database], io)).toBe(2)
    expect(JSON.parse(output.pop()!)).toMatchObject({ error: { code: 'WORKFLOW_REQUEST_INVALID', message: 'validate cannot read both template and inputs from stdin' } })
    expect(stdinReads).toBe(0)
    expect(await runWorkflowCli(['validate', template, '--input', '-', '--db', database], io)).toBe(0)
    expect(data(output.pop()!)).toEqual({ diagnostics: [] })
    expect(stdinReads).toBe(1)
    expect(await runWorkflowCli(['search', '--db', database], io)).toBe(0)
    expect(data(output.pop()!)).toEqual({ items: [] })
  })

  it('returns a stable error envelope and exit code for a missing exact revision', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-workflow-cli-error-'))
    roots.push(root)
    const output: string[] = []
    const diagnostics: string[] = []
    const io: WorkflowCliIo = { stdout: line => output.push(line), stderr: line => diagnostics.push(line), async readStdin() { return '' } }
    expect(await runWorkflowCli(['run', 'script-transform-demo', '--db', join(root, 'workflow.db')], io)).toBe(2)
    const envelope = JSON.parse(output.pop()!) as { readonly ok: boolean; readonly error: { readonly code: string; readonly hints?: readonly string[] } }
    expect(envelope).toMatchObject({ protocolVersion: 'agent-workflow.cli/v1', ok: false, error: { code: 'WORKFLOW_REVISION_REQUIRED' } })
    expect(envelope.error.hints?.join('\n')).toContain('exact published id@revision')
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

    await runWorkflowCli([
      'run', 'script-transform-demo@1', '--input-json', JSON.stringify({ customer: ' cancel ', orders: [] }),
      '--detach', '--idempotency-key', 'background-cancel', '--db', database, '--host', host,
    ], line => lines.push(line))
    const cancellable = data(lines.pop()!) as { readonly runId: string }
    expect(await runWorkflowCli(['cancel', cancellable.runId, '--reason', 'operator stop', '--db', database, '--host', host], line => lines.push(line))).toBe(5)
    expect(data(lines.pop()!)).toMatchObject({ status: 'cancelled', error: 'operator stop' })
    expect(await runWorkflowCli(['runs', '--status', 'cancelled', '--db', database, '--host', host], line => lines.push(line))).toBe(0)
    expect(data(lines.pop()!)).toEqual({ items: [expect.objectContaining({ runId: cancellable.runId, status: 'cancelled' })] })
    expect(await runWorkflowCli(['trace', cancellable.runId, '--all', '--db', database, '--host', host], line => lines.push(line))).toBe(0)
    const [snapshot, ...journal] = lines.splice(0).map(line => JSON.parse(line))
    expect(snapshot).toMatchObject({ type: 'run.snapshot', status: 'cancelled', error: 'operator stop' })
    expect(journal).toContainEqual(expect.objectContaining({ type: 'run.cancelled' }))
    expect(journal.at(-1)).toMatchObject({ seq: snapshot.checkpointSeq })
  })

  it('projects live progress as bounded JSONL while Journal remains the authoritative recovery source', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-workflow-cli-live-'))
    roots.push(root)
    const database = join(root, 'workflow.db')
    const host = join(root, 'host.mjs')
    writeFileSync(host, `export default {
      authorityRef: 'cli:live-test',
      authorityResolver: { async resolve(ref) { return ref === 'cli:live-test' ? { kind: 'worker-authority' } : undefined } }
    }\n`)
    const template = join(process.cwd(), 'examples', 'script-transform.workflow.json')
    const setup: string[] = []
    await runWorkflowCli(['draft', 'put', template, '--db', database, '--host', host], line => setup.push(line)); setup.pop()
    await runWorkflowCli(['publish', 'script-transform-demo', '--expected', '1', '--db', database, '--host', host], line => setup.push(line)); setup.pop()
    await runWorkflowCli([
      'run', 'script-transform-demo@1', '--input-json', JSON.stringify({ customer: ' live ', orders: [] }),
      '--detach', '--db', database, '--host', host,
    ], line => setup.push(line))
    const accepted = data(setup.pop()!) as { readonly runId: string }
    const stream: string[] = []
    const [followCode, workerCode] = await Promise.all([
      runWorkflowCli(['trace', accepted.runId, '--follow', '--db', database, '--host', host], line => stream.push(line)),
      new Promise<number>(resolve => setTimeout(() => {
        void runWorkflowCli(['worker', '--once', '--db', database, '--host', host], () => {}).then(resolve)
      }, 25)),
    ])
    expect(followCode).toBe(0)
    expect(workerCode).toBe(0)
    const events = stream.map(line => data(line) as { readonly seq: number; readonly type: string })
    expect(events.map(event => event.type)).toEqual(expect.arrayContaining(['run.accepted', 'run.started', 'node.completed', 'run.completed']))
    expect(events.map(event => event.seq)).toEqual([...events.map(event => event.seq)].sort((left, right) => left - right))
  })
})

function data(source: string): unknown {
  const envelope = JSON.parse(source) as { readonly protocolVersion: string; readonly ok: boolean; readonly data?: unknown; readonly error?: unknown }
  expect(envelope.protocolVersion).toBe('agent-workflow.cli/v1')
  if (!envelope.ok) throw new Error(`CLI failed: ${JSON.stringify(envelope.error)}`)
  return envelope.data
}
