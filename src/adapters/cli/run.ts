import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  WorkflowAccessError,
  normalizeWorkflowAccessError,
  parsePublishedWorkflowRef,
  type AgentAccessContext,
  type WorkflowAgentAccessApi,
  type WorkflowRunProjection,
} from '../../access/index.js'
import { materializeWorkflowTemplate, parseWorkflowTemplate, snapshotJsonObject, snapshotJsonValue, type JsonObject, type JsonValue, type WorkflowEvent, type WorkflowRunHistoryCursor } from '../../core/index.js'
import { createWorkflowEvidence, verifyWorkflowEvidence } from '../../journal/index.js'
import { createWorkflowCliApplication, loadWorkflowCliHost, type WorkflowCliApplication } from './application.js'
import { verifyWorkflowJournal, writeWorkflowLines } from './files.js'
import { copyWorkflowDatabase, inspectWorkflowDatabase } from './storage.js'
import { caseFromRun, compareWorkflowCase, readWorkflowCase, reviewWorkflowComparison, type WorkflowCaseClassification, type WorkflowCaseComparison } from './regression.js'
import { runPersonalScheduleCommand, runPersonalWorker } from './schedule.js'
import { installProjectWorkflowSkill } from './skill.js'
import { createTraceStats } from './trace-stats.js'
import { workflowCliExitCode, workflowCliFailure, workflowCliRunHints, workflowCliSuccess } from './protocol.js'
import { initWorkflowWorkspace, readBundledOrdersExample, resolveWorkflowCliOptions, type ResolvedWorkflowCliOptions } from './workspace.js'

export interface WorkflowCliIo {
  readonly stdout: (line: string) => void
  readonly stderr: (line: string) => void
  readonly readStdin: () => Promise<string>
  readonly confirmLiveReplay?: (runId: string) => Promise<boolean>
  readonly signal?: AbortSignal
}

export async function runWorkflowCli(
  argv = process.argv.slice(2),
  ioOrOutput: WorkflowCliIo | ((line: string) => void) = defaultIo(),
): Promise<number> {
  const io = normalizeIo(ioOrOutput)
  const startedAt = Date.now()
  const command = commandLabel(argv)
  let application: WorkflowCliApplication | undefined
  try {
    const args = argv.slice(1)
    if (argv[0] === '--help' || argv[0] === 'help' || args.includes('--help')) {
      io.stdout(usage(argv[0] === 'help' ? argv[1] : argv[0] === '--help' ? undefined : argv[0]))
      return 0
    }
    validateCommandArguments(argv[0], args)
    if (argv[0] === 'init') {
      const result = await initWorkflowWorkspace(positional(args, 0) ?? 'workflow-project')
      io.stdout(JSON.stringify(workflowCliSuccess(command, Date.now() - startedAt, result)))
      return 0
    }
    if (argv[0] === 'skill') {
      const result = await installProjectWorkflowSkill()
      io.stdout(JSON.stringify(workflowCliSuccess(command, Date.now() - startedAt, result)))
      return 0
    }
    if (argv[0] === 'verify-log') {
      const result = await verifyWorkflowJournal(requiredPositional(args, 0, 'verify-log requires a JSONL path'))
      io.stdout(JSON.stringify(workflowCliSuccess(command, Date.now() - startedAt, result)))
      return 0
    }
    if (argv[0] === 'verify-evidence') {
      const result = verifyWorkflowEvidence(JSON.parse(await readFile(requiredPositional(args, 0, 'verify-evidence requires a JSON path'), 'utf8')))
      io.stdout(JSON.stringify(workflowCliSuccess(command, Date.now() - startedAt, result)))
      return 0
    }
    const resolved = await resolveWorkflowCliOptions({
      config: option(args, '--config'), database: option(args, '--db'),
      host: option(args, '--host'), authority: option(args, '--authority'),
    })
    if (argv[0] === 'doctor' || argv[0] === 'backup' || argv[0] === 'backup-verify' || argv[0] === 'restore') {
      const result = await localStorageCommand(argv[0], args, resolved)
      io.stdout(JSON.stringify(workflowCliSuccess(command, Date.now() - startedAt, result)))
      return 0
    }
    if (resolved.hostRequiresExplicitSelection) {
      invalid(`The discovered config defines a Host module. Use --config ${JSON.stringify(resolved.configPath)} or pass --host explicitly to load it.`)
    }
    if (argv[0] === 'trace' && hasFlag(args, '--latest') && !existsSync(resolved.databasePath)) {
      throw noVisibleTraceRun(option(args, '--workflow'))
    }
    application = await createWorkflowCliApplication({
      databasePath: resolved.databasePath,
      ...(resolved.hostModulePath === undefined ? {} : { hostModulePath: resolved.hostModulePath }),
    })
    const context: AgentAccessContext = {
      authorityRef: resolved.authorityRef ?? application.host.authorityRef ?? 'cli:local',
      ...(application.host.authority === undefined ? { authority: { type: 'cli-local' } } : { authority: application.host.authority }),
      origin: { type: 'cli', source: command },
      ...(io.signal === undefined ? {} : { signal: io.signal }),
    }
    const result = await executeCommand(argv[0], args, application, context, io, resolved)
    if (result.streamed) return result.exitCode
    io.stdout(JSON.stringify(workflowCliSuccess(command, Date.now() - startedAt, snapshotJsonValue(result.data))))
    return result.exitCode
  } catch (error: unknown) {
    io.stdout(JSON.stringify(workflowCliFailure(command, Date.now() - startedAt, error)))
    if (normalizeWorkflowAccessError(error).code === 'WORKFLOW_REQUEST_INVALID') io.stderr(usage())
    return workflowCliExitCode(error)
  } finally {
    await application?.close()
  }
}

async function executeCommand(
  command: string | undefined,
  args: readonly string[],
  application: WorkflowCliApplication,
  context: AgentAccessContext,
  io: WorkflowCliIo,
  options: ResolvedWorkflowCliOptions,
): Promise<{ readonly data: JsonValue; readonly exitCode: number; readonly streamed?: boolean }> {
  const access = application.access
  switch (command) {
    case 'demo': return runDemo(application.runtime, context, options)
    case 'search': {
      const query = positional(args, 0)
      const limit = optionalInteger(args, '--limit')
      const after = option(args, '--after')
      return success(await access.search({
        ...(query === undefined ? {} : { query }),
        ...(limit === undefined ? {} : { limit }),
        ...(after === undefined ? {} : { after }),
      }, context))
    }
    case 'describe': return success(await access.describe({
      ref: requiredPositional(args, 0, 'describe requires workflow id@revision'),
      view: describeView(option(args, '--view') ?? 'summary'),
    }, context))
    case 'run': return runWorkflow(access, args, context, io)
    case 'runs': {
      const templateId = option(args, '--workflow')
      const status = option(args, '--status')
      if (status !== undefined && status !== 'running' && status !== 'completed' && status !== 'failed' && status !== 'cancelled' && status !== 'paused') {
        invalid('--status must be running, completed, failed, cancelled or paused')
      }
      const limit = optionalInteger(args, '--limit')
      if (limit !== undefined && (limit < 1 || limit > 100)) invalid('--limit must be between 1 and 100')
      const after = readHistoryCursor(option(args, '--after'))
      const query = option(args, '--query')
      const revision = optionalInteger(args, '--revision')
      const origin = option(args, '--origin')
      const from = optionalInteger(args, '--from')
      const through = optionalInteger(args, '--through')
      const table = option(args, '--format')
      if (table !== undefined && table !== 'table' && table !== 'json') invalid('--format must be table or json')
      if (hasFlag(args, '--latest') && limit !== undefined) invalid('--latest and --limit cannot be combined')
      const page = await access.listRuns({
        ...(templateId === undefined ? {} : { templateId }),
        ...(status === undefined ? {} : { status }),
        ...(hasFlag(args, '--latest') ? { limit: 1 } : limit === undefined ? {} : { limit }),
        ...(after === undefined ? {} : { after }),
        ...(query === undefined ? {} : { query }),
        ...(revision === undefined ? {} : { revision }),
        ...(origin === undefined ? {} : { origin }),
        ...(from === undefined ? {} : { from }),
        ...(through === undefined ? {} : { through }),
      }, context)
      const nextAfter = page.nextAfter === undefined ? undefined : Buffer.from(JSON.stringify(page.nextAfter)).toString('base64url')
      if (table === 'table') {
        io.stdout(['STATUS\tUPDATED (UTC)\tWORKFLOW\tRUN ID', ...page.items.map(item =>
          `${item.status}\t${new Date(item.updatedAt).toISOString()}\t${item.templateId}${item.revision === undefined ? '' : `@${item.revision}`}\t${item.runId}`),
        ...(nextAfter === undefined ? [] : [`Next page: --after ${nextAfter}`]),
        ].join('\n'))
        return { data: {}, exitCode: 0, streamed: true }
      }
      return success({ items: page.items, ...(nextAfter === undefined ? {} : { nextAfter }) })
    }
    case 'archive': {
      const terminalBefore = optionalInteger(args, '--before')
      if (terminalBefore === undefined) invalid('archive requires --before TIME_MS')
      const limit = optionalInteger(args, '--limit')
      const selection = { terminalBefore, authorityRef: context.authorityRef, ...(limit === undefined ? {} : { limit }) }
      const preview = await application.runStore.previewPrune(selection)
      if (!hasFlag(args, '--apply')) return success({ preview: true, ...preview })
      const output = option(args, '--output')
      if (output === undefined) invalid('archive --apply requires --output to preserve a SQLite snapshot')
      if (preview.runIds.length === 0) return success({ runIds: [] })
      const backup = await copyWorkflowDatabase(options.databasePath, output)
      return success({ ...await application.runStore.prune({ ...selection, runIds: preview.runIds }), backup })
    }
    case 'run-get': return success(await access.getRun(requiredPositional(args, 0, 'run-get requires runId'), context))
    case 'trace': return traceWorkflow(access, args, context, io)
    case 'evidence': {
      const runId = requiredPositional(args, 0, 'evidence requires a Run ID')
      const record = await readAuthorizedRun(application, runId, context)
      const bundle = await createWorkflowEvidence(record, { redactFields: redactFieldNames(args),
        ...(hasFlag(args, '--artifacts') ? { artifactStore: application.artifactStore } : {}),
      })
      const output = option(args, '--output')
      return output === undefined ? success(bundle) : success({ path: await writeJsonFile(output, bundle), sha256: bundle.sha256 })
    }
    case 'case': return regressionCommand(application, args, context, io)
    case 'schedule':
    case 'delivery': return success(await runPersonalScheduleCommand(command, args, application, context, options.databasePath, io))
    case 'replay': {
      const runId = requiredPositional(args, 0, 'replay requires runId')
      const mode = replayMode(option(args, '--mode') ?? 'inspect')
      if (mode === 'live' && !hasFlag(args, '--yes') && io.confirmLiveReplay !== undefined && !await io.confirmLiveReplay(runId)) {
        throw new WorkflowAccessError('WORKFLOW_REQUEST_INVALID', 'Live replay was not confirmed')
      }
      const result = await access.replay(runId, mode, context)
      return workflowResult(result)
    }
    case 'resume': {
      const result = await access.resume(requiredPositional(args, 0, 'resume requires runId'), context, await readResolutions(option(args, '--resolutions'), io))
      return workflowResult(result)
    }
    case 'cancel': return workflowResult(await access.cancel(
      requiredPositional(args, 0, 'cancel requires runId'), context, option(args, '--reason'),
    ))
    case 'nodes': {
      if (positional(args, 0) !== 'search') invalid('nodes requires the search subcommand')
      const query = positional(args, 1)
      const limit = optionalInteger(args, '--limit')
      return success(await access.listNodes({
        ...(query === undefined ? {} : { query }),
        ...(limit === undefined ? {} : { limit }),
      }, context))
    }
    case 'validate': {
      const templateFile = requiredPositional(args, 0, 'validate requires template file or -')
      if (templateFile === '-' && option(args, '--input') === '-') invalid('validate cannot read both template and inputs from stdin')
      const inputs = await readInputs('validate', args, io)
      const template = await readTemplateSource(templateFile, io)
      const result = await access.validate(template, context, inputs)
      if (hasFlag(args, '--strict') && result.diagnostics.some(item => item.severity === 'error')) {
        throw new WorkflowAccessError('WORKFLOW_VALIDATION_FAILED', 'Workflow validation reported errors', { diagnostics: result.diagnostics })
      }
      return success(result)
    }
    case 'draft': return draftCommand(access, args, context, io)
    case 'diff': return success(await access.diff(
      requiredPositional(args, 0, 'diff requires workflow id'),
      await readTemplateSource(requiredPositional(args, 1, 'diff requires candidate file or -'), io),
      context,
    ) as unknown as JsonValue)
    case 'publish': return success(await access.publish(
      requiredPositional(args, 0, 'publish requires workflow id'),
      requiredInteger(args, '--expected'),
      context,
    ))
    case 'worker': {
      if (!hasFlag(args, '--once')) invalid('worker currently requires --once')
      const workerId = option(args, '--worker-id') ?? `cli-worker:${process.pid}`
      const result = await runPersonalWorker(application, context, options.databasePath, {
        workerId,
        leaseMs: optionalInteger(args, '--lease-ms') ?? 30_000,
        ...(io.signal === undefined ? {} : { signal: io.signal }),
      })
      return success(result === undefined ? { status: 'idle' } : result)
    }
    default: invalid('unknown or missing command')
  }
}

async function readAuthorizedRun(application: WorkflowCliApplication, runId: string, context: AgentAccessContext) {
  await application.access.getRun(runId, context)
  const record = await application.runStore.loadRun(runId)
  if (record === undefined) throw new WorkflowAccessError('WORKFLOW_RUN_NOT_FOUND', `workflow run not found: ${runId}`)
  if (record.execution.authorityRef !== context.authorityRef) throw new WorkflowAccessError('WORKFLOW_AUTHORITY_DENIED', 'workflow run belongs to another authority')
  return record
}

async function regressionCommand(application: WorkflowCliApplication, args: readonly string[], context: AgentAccessContext, io: WorkflowCliIo) {
  const kind = positional(args, 0)
  const source = requiredPositional(args, 1, 'case requires a Run ID, file or directory')
  if (kind === 'from-run') {
    const sample = caseFromRun(await readAuthorizedRun(application, source, context), application.nodes, redactFieldNames(args))
    const output = option(args, '--output')
    return output === undefined ? success(sample) : success({ path: await writeJsonFile(output, sample) })
  }
  const baseArg = option(args, '--base')
  const candidateArg = option(args, '--candidate')
  if (baseArg === undefined || candidateArg === undefined) invalid('case compare requires --base and --candidate')
  if (baseArg === '-' && candidateArg === '-') invalid('case compare cannot read both templates from stdin')
  const [base, candidate] = await Promise.all([resolveCaseTemplate(baseArg, application, io), resolveCaseTemplate(candidateArg, application, io)])
  const files = (await stat(source)).isDirectory()
    ? (await readdir(source, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => join(source, entry.name)).sort()
    : [source]
  if (files.length === 0) invalid('case directory must contain at least one JSON case')
  const results: Array<{ file: string } & (WorkflowCaseComparison & { name: string } | { classification: 'invalid-case'; error: string })> = []
  const reviewRequested = hasFlag(args, '--review')
  if (reviewRequested && application.host.services?.agents === undefined) invalid('case compare --review requires a Host Agent gateway')
  const options = {
    registry: application.nodes,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    ...(reviewRequested ? { review: (inputs: JsonObject) => reviewWorkflowComparison(application.runtime, inputs, context) } : {}),
  }
  for (const file of files) {
    context.signal?.throwIfAborted()
    let sample: ReturnType<typeof readWorkflowCase>
    try { sample = readWorkflowCase(JSON.parse(await readFile(file, 'utf8'))) }
    catch (error: unknown) {
      results.push({ file, classification: 'invalid-case', error: renderError(error) })
      continue
    }
    results.push({ file, name: sample.name, ...await compareWorkflowCase(sample, base, candidate, options) })
  }
  const byClassification: Partial<Record<WorkflowCaseClassification, number>> = {}
  for (const { classification } of results) byClassification[classification] = (byClassification[classification] ?? 0) + 1
  const passedCases = (byClassification.passed ?? 0) + (byClassification['expected-correction'] ?? 0)
  const summary = { total: results.length, passed: passedCases, failed: results.length - passedCases, byClassification }
  const passed = summary.failed === 0
  const report = {
    format: 'agent-dag-workflow.case-report/v1', evaluatedAt: Date.now(), passed, summary,
    baseline: { ref: baseArg, semanticHash: materializeWorkflowTemplate(base).semanticHash },
    candidate: { ref: candidateArg, semanticHash: materializeWorkflowTemplate(candidate).semanticHash }, results,
  }
  const output = option(args, '--output')
  const data = output === undefined ? report : { passed, summary, path: await writeJsonFile(output, report), cases: results.length }
  return { data: snapshotJsonValue(data as unknown as JsonValue), exitCode: passed ? 0 : 5 }
}

async function resolveCaseTemplate(ref: string, application: WorkflowCliApplication, io: WorkflowCliIo) {
  if (!/^[a-z][a-z0-9-]*@[1-9][0-9]*$/.test(ref) || existsSync(ref)) return readTemplateSource(ref, io)
  const { id, revision } = parsePublishedWorkflowRef(ref)
  return (await application.catalog.getPublished(id, revision)).template
}

function redactFieldNames(args: readonly string[]): readonly string[] {
  const value = option(args, '--redact')
  if (value === undefined) return []
  const fields = value.split(',').map(field => field.trim())
  if (fields.some(field => field.length === 0)) invalid('--redact must be a comma-separated list of field names')
  return fields
}

async function writeJsonFile(path: string, value: unknown): Promise<string> {
  return writeWorkflowLines(path, async write => { await write(JSON.stringify(value, null, 2)) })
}

async function localStorageCommand(command: 'doctor' | 'backup' | 'backup-verify' | 'restore', args: readonly string[], options: ResolvedWorkflowCliOptions) {
  if (command === 'doctor') {
    const host = options.hostRequiresExplicitSelection ? undefined : await loadWorkflowCliHost(options.hostModulePath)
    try {
      const authorityRef = options.authorityRef ?? host?.authorityRef ?? (options.hostRequiresExplicitSelection ? null : 'cli:local')
      return {
        ...(existsSync(options.databasePath) ? inspectWorkflowDatabase(options.databasePath) : { database: options.databasePath, state: 'missing' }),
        databaseSource: options.databaseSource,
        authorityRef,
        authoritySource: options.authoritySource ?? (host?.authorityRef !== undefined ? 'host' : authorityRef === null ? 'unresolved' : 'default'),
        hostState: options.hostRequiresExplicitSelection ? 'requires-explicit-selection' : options.hostModulePath === undefined ? 'unconfigured' : 'loaded',
        ...(options.hostModulePath === undefined ? {} : { hostModule: options.hostModulePath }),
        ...(options.configPath === undefined ? {} : { config: options.configPath, configSource: options.configSource }),
      }
    } finally { await host?.dispose?.() }
  }
  const path = requiredPositional(args, 0, `${command} requires a SQLite file path`)
  if (command === 'backup-verify') return inspectWorkflowDatabase(path, true)
  if (command === 'restore') {
    if (options.databaseSource !== 'flag' && options.configSource !== 'explicit') invalid('restore requires an explicit destination --db PATH or --config FILE')
    return copyWorkflowDatabase(path, options.databasePath)
  }
  return copyWorkflowDatabase(options.databasePath, path)
}

async function runDemo(runtime: WorkflowCliApplication['runtime'], context: AgentAccessContext, options: ResolvedWorkflowCliOptions) {
  const { template, inputSource } = await readBundledOrdersExample()
  const handle = await runtime.launch({
    target: { type: 'inline', template },
    inputs: parseJsonObject(inputSource, 'demo inputs'),
    authorityRef: context.authorityRef,
    authority: context.authority,
    origin: context.origin,
    ...(context.signal === undefined ? {} : { interruptionSignal: context.signal }),
  })
  const result = await handle.result
  const demoResult = {
    runId: result.runId,
    templateId: template.metadata.id,
    status: result.status,
    ...(result.status === 'completed' ? { outputs: result.outputs } : { error: result.error }),
    traceCommand: [
      'adw', 'trace', result.runId, '--events', '--db', options.databasePath, '--authority', context.authorityRef,
      ...(options.hostModulePath === undefined ? [] : ['--host', options.hostModulePath]),
    ],
  }
  return workflowResult(demoResult)
}

async function runWorkflow(access: WorkflowAgentAccessApi, args: readonly string[], context: AgentAccessContext, io: WorkflowCliIo) {
  const inputs = await readInputs('run', args, io) ?? {}
  const idempotencyKey = option(args, '--idempotency-key')
  const result = await access.run({
    ref: requiredPositional(args, 0, 'run requires exact workflow id@revision'),
    inputs,
    mode: hasFlag(args, '--detach') ? 'background' : 'foreground',
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  }, context)
  return workflowResult(result)
}

function workflowResult(result: { readonly runId: string; readonly status: string; readonly error?: string }): { readonly data: JsonValue; readonly exitCode: number } {
  const hints = workflowCliRunHints(result)
  return {
    data: snapshotJsonValue({ ...result, ...(hints.length === 0 ? {} : { hints }) }),
    exitCode: result.status === 'failed' || result.status === 'cancelled' ? 5 : 0,
  }
}

async function traceWorkflow(access: WorkflowCliApplication['access'], args: readonly string[], context: AgentAccessContext, io: WorkflowCliIo) {
  const runId = hasFlag(args, '--latest') ? await latestTraceRunId(access, args, context) : requiredPositional(args, 0, 'trace requires a Run ID or --latest')
  const follow = hasFlag(args, '--follow')
  const all = hasFlag(args, '--all')
  const stats = hasFlag(args, '--stats')
  const output = option(args, '--output')
  const requestedView = option(args, '--view')
  if (requestedView !== undefined && requestedView !== 'summary' && requestedView !== 'events') invalid('trace --view must be summary or events')
  const events = hasFlag(args, '--events') || follow || all || requestedView === 'events'
  const format = option(args, '--format') ?? (follow || all ? 'jsonl' : 'json')
  if (format !== 'json' && format !== 'jsonl') invalid('--format must be json or jsonl')
  if (stats) {
    if (events || requestedView !== undefined || output !== undefined || format !== 'json' || option(args, '--after') !== undefined) {
      invalid('trace --stats requires JSON and reads from the first event. It cannot be combined with --events, --view, --follow, --all, --after or --output')
    }
    const summary = createTraceStats()
    const run = await readTraceSnapshot(access, runId, tracePageLimit(args), context, summary.append)
    return success(summary.finish(run))
  }
  if (output !== undefined && !all) invalid('trace --output requires --all')
  if (follow && format !== 'jsonl') invalid('trace --follow requires --format jsonl')
  if (all) {
    if (follow || format !== 'jsonl' || requestedView === 'summary' || option(args, '--after') !== undefined) {
      invalid('trace --all exports a JSONL snapshot from the first event and cannot be combined with --follow, --after, or --view summary')
    }
    const limit = tracePageLimit(args)
    if (output === undefined) {
      await exportTrace(access, runId, limit, context, io.stdout)
      return { data: {}, exitCode: 0, streamed: true }
    }
    const written = await writeWorkflowLines(output, line => exportTrace(access, runId, limit, context, line))
    return success({ path: written, ...await verifyWorkflowJournal(written) })
  }
  if (!follow) {
    const afterSeq = optionalInteger(args, '--after')
    const limit = optionalInteger(args, '--limit')
    const page = await access.trace({
      runId,
      view: events ? 'events' : 'summary',
      ...(afterSeq === undefined ? {} : { afterSeq }),
      ...(limit === undefined ? {} : { limit }),
    }, context)
    if (format === 'jsonl') {
      if (events) for (const event of page.events ?? []) io.stdout(JSON.stringify(workflowCliSuccess('trace', 0, event)))
      else io.stdout(JSON.stringify(workflowCliSuccess('trace', 0, page.run)))
      return { data: {}, exitCode: 0, streamed: true }
    }
    return success(page)
  }
  let afterSeq = optionalInteger(args, '--after') ?? 0
  const limit = optionalInteger(args, '--limit') ?? 100
  for (;;) {
    context.signal?.throwIfAborted()
    const page = await access.trace({ runId, view: 'events', afterSeq, limit }, context)
    for (const event of page.events ?? []) {
      io.stdout(JSON.stringify(workflowCliSuccess('trace', 0, event)))
      afterSeq = event.seq
    }
    if (page.nextAfterSeq !== undefined) continue
    if (page.run.status !== 'running') return { data: {}, exitCode: page.run.status === 'failed' || page.run.status === 'cancelled' ? 5 : 0, streamed: true }
    await delay(250, undefined, context.signal === undefined ? {} : { signal: context.signal })
  }
}

async function latestTraceRunId(access: WorkflowCliApplication['access'], args: readonly string[], context: AgentAccessContext): Promise<string> {
  const templateId = option(args, '--workflow')
  const { items } = await access.listRuns({ limit: 1, ...(templateId === undefined ? {} : { templateId }) }, context)
  const run = items[0]
  if (run === undefined) throw noVisibleTraceRun(templateId)
  return run.runId
}

function noVisibleTraceRun(templateId: string | undefined) {
  return new WorkflowAccessError('WORKFLOW_RUN_NOT_FOUND', templateId === undefined
    ? 'No saved runs are visible in this database and execution identity.'
    : `No saved runs for workflow ${templateId} are visible in this database and execution identity.`)
}

async function exportTrace(access: WorkflowAgentAccessApi, runId: string, limit: number, context: AgentAccessContext, write: (line: string) => Promise<void> | void): Promise<void> {
  await readTraceSnapshot(access, runId, limit, context, event => write(JSON.stringify(event)), run => write(JSON.stringify({
    format: 'agent-dag-workflow.journal/v1', type: 'run.snapshot',
    runId: run.runId, ref: run.ref, semanticHash: run.semanticHash, status: run.status,
    createdAt: run.createdAt, updatedAt: run.updatedAt, checkpointSeq: run.checkpointSeq,
    ...(run.outputs === undefined ? {} : { outputs: run.outputs }),
    ...(run.error === undefined ? {} : { error: run.error }),
  })))
}

function tracePageLimit(args: readonly string[]): number {
  const limit = optionalInteger(args, '--limit') ?? 200
  if (limit < 1 || limit > 1000) invalid('--limit must be between 1 and 1000')
  return limit
}

async function readTraceSnapshot(
  access: WorkflowAgentAccessApi, runId: string, limit: number, context: AgentAccessContext,
  visit: (event: WorkflowEvent) => Promise<void> | void,
  onSnapshot?: (run: WorkflowRunProjection) => Promise<void> | void,
): Promise<WorkflowRunProjection> {
  context.signal?.throwIfAborted()
  let page = await access.trace({ runId, view: 'events', limit }, context)
  const run = page.run
  const throughSeq = run.checkpointSeq
  await onSnapshot?.(run)
  let afterSeq = 0
  for (;;) {
    for (const event of page.events ?? []) {
      if (event.seq !== afterSeq + 1 || event.seq > throughSeq) {
        throw new WorkflowAccessError('WORKFLOW_TRACE_INCOMPLETE', `run ${runId} has a Journal gap after sequence ${afterSeq}`)
      }
      if (event.runId !== run.runId || event.workflow.semanticHash !== run.semanticHash || event.eventId !== `${runId}:${event.seq}`) {
        throw new WorkflowAccessError('WORKFLOW_TRACE_INCOMPLETE', `run ${runId} has mismatched Journal identity at sequence ${event.seq}`)
      }
      await visit(event)
      afterSeq = event.seq
    }
    if (afterSeq === throughSeq) return run
    if (afterSeq === 0 || page.nextAfterSeq !== afterSeq) {
      throw new WorkflowAccessError('WORKFLOW_TRACE_INCOMPLETE', `run ${runId} ended at Journal sequence ${afterSeq}, expected ${throughSeq}`)
    }
    context.signal?.throwIfAborted()
    page = await access.trace({ runId, view: 'events', limit, afterSeq, throughSeq }, context)
  }
}

function readHistoryCursor(value: string | undefined): WorkflowRunHistoryCursor | undefined {
  if (value === undefined) return undefined
  if (value.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(value)) invalid('--after must be the nextAfter value returned by runs')
  const { updatedAt, runId } = parseJsonObject(Buffer.from(value, 'base64url').toString('utf8'), '--after')
  if (typeof updatedAt !== 'number' || !Number.isSafeInteger(updatedAt) || updatedAt < 0 || typeof runId !== 'string' || runId.length === 0) {
    invalid('--after must be the nextAfter value returned by runs')
  }
  return { updatedAt, runId }
}

async function draftCommand(access: WorkflowAgentAccessApi, args: readonly string[], context: AgentAccessContext, io: WorkflowCliIo) {
  const subcommand = positional(args, 0)
  if (subcommand === 'get') {
    const view = option(args, '--view') ?? 'template'
    if (view !== 'summary' && view !== 'template') invalid('draft get --view must be summary or template')
    return success(await access.getDraft(requiredPositional(args, 1, 'draft get requires workflow id'), context, view === 'template'))
  }
  if (subcommand === 'put') {
    const template = await readTemplateSource(requiredPositional(args, 1, 'draft put requires template file or -'), io)
    return success(await access.putDraft(template, context, optionalInteger(args, '--expected')))
  }
  invalid('draft requires get or put subcommand')
}

async function readTemplateSource(path: string, io: WorkflowCliIo) {
  try { return parseWorkflowTemplate(path === '-' ? await io.readStdin() : await readFile(resolve(path), 'utf8')) }
  catch (error: unknown) { invalid(`template must be valid WorkflowTemplate JSON/YAML: ${renderError(error)}`) }
}

async function readInputs(command: 'run' | 'validate', args: readonly string[], io: WorkflowCliIo): Promise<JsonObject | undefined> {
  const inputFile = option(args, '--input')
  const inputJson = option(args, '--input-json')
  if (inputFile !== undefined && inputJson !== undefined) invalid(`${command} accepts only one of --input or --input-json`)
  if (inputJson !== undefined) return parseJsonObject(inputJson, '--input-json')
  if (inputFile !== undefined) return readJsonObjectSource(inputFile, io)
  return undefined
}

async function readJsonObjectSource(path: string, io: WorkflowCliIo): Promise<JsonObject> {
  let source: string
  try { source = path === '-' ? await io.readStdin() : await readFile(resolve(path), 'utf8') }
  catch (error: unknown) { invalid(`could not read JSON from ${path}: ${renderError(error)}`) }
  return parseJsonObject(source, path)
}

async function readResolutions(path: string | undefined, io: WorkflowCliIo): Promise<Readonly<Record<string, 'retry' | 'fail'>> | undefined> {
  if (path === undefined) return undefined
  const value = await readJsonObjectSource(path, io)
  for (const [nodeId, resolution] of Object.entries(value)) if (resolution !== 'retry' && resolution !== 'fail') invalid(`resolution for ${nodeId} must be retry or fail`)
  return value as unknown as Readonly<Record<string, 'retry' | 'fail'>>
}

function parseJsonObject(source: string, label: string): JsonObject {
  try { return snapshotJsonObject(JSON.parse(source)) } catch (error: unknown) { invalid(`${label} must contain a lossless JSON object: ${renderError(error)}`) }
}

function describeView(value: string): 'summary' | 'schema' | 'template' {
  if (value === 'summary' || value === 'schema' || value === 'template') return value
  invalid('--view must be summary, schema, or template')
}

function replayMode(value: string): 'inspect' | 'recorded' | 'live' {
  if (value === 'inspect' || value === 'recorded' || value === 'live') return value
  invalid('--mode must be inspect, recorded, or live')
}

const GLOBAL_VALUE_OPTIONS = ['--db', '--host', '--config', '--authority'] as const

function validateCommandArguments(command: string | undefined, args: readonly string[]): void {
  switch (command) {
    case 'init': {
      assertArguments(args, [], [], 0, 1)
      if (GLOBAL_VALUE_OPTIONS.some(flag => args.includes(flag))) invalid('init accepts only a new workspace directory')
      return
    }
    case 'skill': {
      const [action] = assertArguments(args, [], [], 1, 1)
      if (action !== 'install' || GLOBAL_VALUE_OPTIONS.some(flag => args.includes(flag))) invalid('skill accepts only the install subcommand')
      return
    }
    case 'demo': assertArguments(args, [], [], 0, 0); return
    case 'search': assertArguments(args, ['--limit', '--after'], [], 0, 1); return
    case 'describe': assertArguments(args, ['--view'], [], 1, 1); return
    case 'run': assertArguments(args, ['--input', '--input-json', '--idempotency-key'], ['--detach'], 1, 1); return
    case 'runs': assertArguments(args, ['--workflow', '--status', '--limit', '--after', '--query', '--origin', '--revision', '--from', '--through', '--format'], ['--latest'], 0, 0); return
    case 'doctor': assertArguments(args, [], [], 0, 0); return
    case 'backup':
    case 'backup-verify':
    case 'restore': assertArguments(args, [], [], 1, 1); return
    case 'archive': assertArguments(args, ['--before', '--limit', '--output'], ['--apply'], 0, 0); return
    case 'run-get': assertArguments(args, [], [], 1, 1); return
    case 'trace': {
      const latest = hasFlag(args, '--latest')
      assertArguments(args, ['--view', '--format', '--after', '--limit', '--output', ...(latest ? ['--workflow'] : [])],
        ['--follow', '--events', '--all', '--stats', '--latest'], latest ? 0 : 1, latest ? 0 : 1)
      return
    }
    case 'verify-log': assertArguments(args, [], [], 1, 1); return
    case 'verify-evidence': assertArguments(args, [], [], 1, 1); return
    case 'evidence': assertArguments(args, ['--redact', '--output'], ['--artifacts'], 1, 1); return
    case 'case': {
      const positionals = assertArguments(args, ['--redact', '--output', '--base', '--candidate'], ['--review'], 2, 2)
      if (positionals[0] === 'from-run') assertArguments(args, ['--redact', '--output'], [], 2, 2)
      else if (positionals[0] === 'compare') assertArguments(args, ['--base', '--candidate', '--output'], ['--review'], 2, 2)
      else invalid('case requires from-run or compare subcommand')
      return
    }
    case 'replay': assertArguments(args, ['--mode'], ['--yes'], 1, 1); return
    case 'resume': assertArguments(args, ['--resolutions'], [], 1, 1); return
    case 'cancel': assertArguments(args, ['--reason'], [], 1, 1); return
    case 'nodes': {
      const positionals = assertArguments(args, ['--limit'], [], 1, 2)
      if (positionals[0] !== 'search') invalid('nodes requires the search subcommand')
      return
    }
    case 'validate': assertArguments(args, ['--input', '--input-json'], ['--strict'], 1, 1); return
    case 'draft': {
      const positionals = assertArguments(args, ['--view', '--expected'], [], 2, 2)
      if (positionals[0] === 'get') assertArguments(args, ['--view'], [], 2, 2)
      else if (positionals[0] === 'put') assertArguments(args, ['--expected'], [], 2, 2)
      else invalid('draft requires get or put subcommand')
      return
    }
    case 'diff': assertArguments(args, [], [], 2, 2); return
    case 'publish': assertArguments(args, ['--expected'], [], 1, 1); return
    case 'worker': assertArguments(args, ['--worker-id', '--lease-ms'], ['--once'], 0, 0); return
    case 'schedule': {
      const values = ['--workflow', '--cron', '--timezone', '--expected', '--input', '--input-json', '--misfire', '--overlap', '--day-match', '--delivery']
      const positionals = assertArguments(args, [...values, '--limit'], [], 1, 2)
      if (positionals[0] === 'publish') assertArguments(args, values, [], 2, 2)
      else if (positionals[0] === 'enable' || positionals[0] === 'disable') assertArguments(args, ['--expected'], [], 2, 2)
      else if (positionals[0] === 'list' || positionals[0] === 'tick') assertArguments(args, ['--limit'], [], 1, 1)
      else if (positionals[0] === 'status' || positionals[0] === 'run-now') assertArguments(args, [], [], 2, 2)
      else invalid('schedule requires list, status, publish, enable, disable, tick or run-now')
      return
    }
    case 'delivery': {
      const positionals = assertArguments(args, ['--limit'], [], 1, 2)
      if (positionals[0] === 'list' || positionals[0] === 'retry-due') assertArguments(args, ['--limit'], [], 1, 1)
      else if (positionals[0] === 'retry') assertArguments(args, [], [], 2, 2)
      else invalid('delivery requires list, retry or retry-due')
      return
    }
    default: invalid('unknown or missing command')
  }
}

function assertArguments(
  args: readonly string[],
  commandValueOptions: readonly string[],
  commandFlags: readonly string[],
  minimumPositionals: number,
  maximumPositionals: number,
): readonly string[] {
  const valueOptions = new Set<string>([...GLOBAL_VALUE_OPTIONS, ...commandValueOptions])
  const flags = new Set(commandFlags)
  const seen = new Set<string>()
  const positionals: string[] = []
  for (let offset = 0; offset < args.length; offset++) {
    const value = args[offset]!
    if (!value.startsWith('--')) {
      positionals.push(value)
      continue
    }
    if (!valueOptions.has(value) && !flags.has(value)) invalid(`unknown option: ${value}`)
    if (seen.has(value)) invalid(`option may only be supplied once: ${value}`)
    seen.add(value)
    if (flags.has(value)) continue
    const optionValue = args[++offset]
    if (optionValue === undefined || optionValue.length === 0 || optionValue.startsWith('--')) invalid(`${value} requires a value`)
  }
  if (positionals.length < minimumPositionals || positionals.length > maximumPositionals) {
    const expected = minimumPositionals === maximumPositionals ? String(minimumPositionals) : `${minimumPositionals}-${maximumPositionals}`
    invalid(`command expects ${expected} positional argument(s), received ${positionals.length}`)
  }
  return positionals
}

function success(value: unknown): { readonly data: JsonValue; readonly exitCode: 0 } {
  return { data: snapshotJsonValue(value), exitCode: 0 }
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) invalid(`${name} requires a value`)
  return value
}

function hasFlag(args: readonly string[], name: string): boolean { return args.includes(name) }

function positional(args: readonly string[], index: number): string | undefined {
  const values: string[] = []
  const flags = new Set(['--detach', '--follow', '--events', '--all', '--once', '--strict', '--latest', '--apply', '--artifacts', '--yes', '--review'])
  for (let offset = 0; offset < args.length; offset++) {
    const value = args[offset]!
    if (value.startsWith('--')) { if (!flags.has(value)) offset++; continue }
    values.push(value)
  }
  return values[index]
}

function requiredPositional(args: readonly string[], index: number, message: string): string {
  const value = positional(args, index)
  if (value === undefined) invalid(message)
  return value
}

function optionalInteger(args: readonly string[], name: string): number | undefined {
  const value = option(args, name)
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) invalid(`${name} must be a non-negative safe integer`)
  return parsed
}

function requiredInteger(args: readonly string[], name: string): number {
  const value = optionalInteger(args, name)
  if (value === undefined || value < 1) invalid(`${name} must be a positive safe integer`)
  return value
}

function commandLabel(argv: readonly string[]): string {
  if (['draft', 'nodes', 'case', 'schedule', 'delivery', 'skill'].includes(argv[0] ?? '')) return `${argv[0]} ${argv[1] ?? ''}`.trim()
  return argv[0] ?? 'unknown'
}

function normalizeIo(value: WorkflowCliIo | ((line: string) => void)): WorkflowCliIo {
  return typeof value === 'function'
    ? { stdout: value, stderr: () => {}, readStdin: readProcessStdin }
    : value
}

function defaultIo(): WorkflowCliIo {
  return { stdout: line => console.log(line), stderr: line => console.error(line), readStdin: readProcessStdin }
}

async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function invalid(message: string): never { throw new WorkflowAccessError('WORKFLOW_REQUEST_INVALID', message) }
function renderError(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function usage(command?: string): string {
  const commands: Readonly<Record<string, string>> = {
    init: 'init [NEW_DIRECTORY]                Create an editable orders workflow and a project config',
    skill: 'skill install                       Install the packaged workflow-builder Skill in this project',
    demo: 'demo                                Run the bundled orders example',
    search: 'search [query] [--limit N] [--after ID]',
    describe: 'describe ID@REV [--view summary|schema|template]',
    validate: 'validate TEMPLATE [--input FILE | --input-json JSON] [--strict]',
    draft: 'draft get ID [--view summary|template] | draft put TEMPLATE [--expected REV]',
    diff: 'diff ID TEMPLATE',
    publish: 'publish ID --expected DRAFT_REV',
    nodes: 'nodes search [query] [--limit N]',
    run: 'run ID@REV [--input FILE | --input-json JSON] [--detach] [--idempotency-key KEY]',
    runs: 'runs [--workflow ID] [--query TEXT] [--status STATUS] [--revision REV] [--origin TYPE] [--from TIME_MS] [--through TIME_MS] [--limit N | --latest] [--after CURSOR] [--format json|table]',
    'run-get': 'run-get RUN_ID',
    trace: 'trace RUN_ID or trace --latest [--workflow ID] [--events | --follow | --all | --stats] [--limit N] [--format json|jsonl] [--output FILE]',
    'verify-log': 'verify-log FILE                     Check a Journal export and its checkpoint sequence',
    evidence: 'evidence RUN_ID [--output FILE] [--redact FIELD,FIELD] [--artifacts]',
    'verify-evidence': 'verify-evidence FILE          Check an evidence bundle checksum',
    case: 'case from-run RUN_ID [--output FILE] [--redact FIELD,FIELD] | case compare CASE_OR_DIR --base TEMPLATE_OR_REF --candidate TEMPLATE_OR_REF [--output FILE] [--review]',
    replay: 'replay RUN_ID [--mode inspect|recorded|live] [--yes]',
    resume: 'resume RUN_ID [--resolutions FILE]',
    cancel: 'cancel RUN_ID [--reason TEXT]',
    doctor: 'doctor                              Show the active database, config and authority',
    backup: 'backup FILE                         Create a consistent SQLite snapshot',
    'backup-verify': 'backup-verify FILE                  Check the integrity of a SQLite snapshot',
    restore: 'restore SNAPSHOT --db NEW_DATABASE  Restore into a fresh SQLite file',
    archive: 'archive --before TIME_MS [--limit N] [--apply --output SNAPSHOT]',
    worker: 'worker --once [--worker-id ID] [--lease-ms N]',
    schedule: 'schedule list | status ID | publish ID --workflow ID@REV --cron EXPR --timezone TZ | enable ID | disable ID | tick | run-now ID',
    delivery: 'delivery list | retry-due | retry INVOCATION_ID',
  }
  const entries = command === undefined || commands[command] === undefined ? Object.values(commands) : [commands[command]!]
  return ['Usage: adw <command> [options]', ...entries.map(entry => `  ${entry}`),
    'Global options: --db PATH --authority REF --host MODULE --config FILE',
  ].join('\n')
}
