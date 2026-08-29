import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  WorkflowAccessError,
  normalizeWorkflowAccessError,
  type AgentAccessContext,
  type WorkflowAgentAccessApi,
} from '../../access/index.js'
import { parseWorkflowTemplate, snapshotJsonObject, snapshotJsonValue, type JsonObject, type JsonValue } from '../../core/index.js'
import { migrateLegacyWorkflowTemplate } from '../../migrations/index.js'
import { WorkflowRunWorker } from '../../triggers/core/index.js'
import { createWorkflowCliApplication, type WorkflowCliApplication } from './application.js'
import { workflowCliExitCode, workflowCliFailure, workflowCliSuccess } from './protocol.js'

export interface WorkflowCliIo {
  readonly stdout: (line: string) => void
  readonly stderr: (line: string) => void
  readonly readStdin: () => Promise<string>
  readonly signal?: AbortSignal
}

interface WorkflowCliConfig {
  readonly schemaVersion: 1
  readonly database?: string
  readonly hostModule?: string
  readonly authorityRef?: string
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
    validateCommandArguments(argv[0], args)
    const resolved = await resolveOptions(args)
    application = await createWorkflowCliApplication({
      databasePath: resolved.databasePath,
      ...(resolved.hostModulePath === undefined ? {} : { hostModulePath: resolved.hostModulePath }),
    })
    const context: AgentAccessContext = {
      authorityRef: option(args, '--authority') ?? resolved.authorityRef ?? application.host.authorityRef ?? 'cli:local',
      ...(application.host.authority === undefined ? { authority: { type: 'cli-local' } } : { authority: application.host.authority }),
      origin: { type: 'cli', source: command },
      ...(io.signal === undefined ? {} : { signal: io.signal }),
    }
    const result = await executeCommand(argv[0], args, application, context, io)
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
): Promise<{ readonly data: JsonValue; readonly exitCode: number; readonly streamed?: boolean }> {
  const access = application.access
  switch (command) {
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
    case 'run-get': return success(await access.getRun(requiredPositional(args, 0, 'run-get requires runId'), context))
    case 'trace': return traceWorkflow(access, args, context, io)
    case 'replay': {
      const result = await access.replay(requiredPositional(args, 0, 'replay requires runId'), replayMode(option(args, '--mode') ?? 'inspect'), context)
      return { data: result as unknown as JsonValue, exitCode: result.status === 'failed' || result.status === 'cancelled' ? 5 : 0 }
    }
    case 'resume': {
      const result = await access.resume(requiredPositional(args, 0, 'resume requires runId'), context, await readResolutions(option(args, '--resolutions'), io))
      return { data: result as unknown as JsonValue, exitCode: result.status === 'completed' || result.status === 'paused' ? 0 : 5 }
    }
    case 'nodes': {
      if (positional(args, 0) !== 'search') invalid('nodes requires the search subcommand')
      const query = positional(args, 1)
      const limit = optionalInteger(args, '--limit')
      return success(await access.listNodes({
        ...(query === undefined ? {} : { query }),
        ...(limit === undefined ? {} : { limit }),
      }, context))
    }
    case 'validate': return success(await access.validate(await readTemplateSource(requiredPositional(args, 0, 'validate requires template file or -'), io), context))
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
      const result = await new WorkflowRunWorker(application.runtime, application.coordinator).runOnce({
        workerId,
        leaseMs: optionalInteger(args, '--lease-ms') ?? 30_000,
        ...(io.signal === undefined ? {} : { signal: io.signal }),
      })
      return success(result === undefined ? { status: 'idle' } : result)
    }
    case 'migrate-template': {
      const source = requiredPositional(args, 0, 'migrate-template requires input file')
      const target = option(args, '--output')
      if (target === undefined) invalid('migrate-template requires --output')
      const legacy = snapshotJsonObject(JSON.parse(await readFile(resolve(source), 'utf8')))
      const migrated = migrateLegacyWorkflowTemplate(legacy)
      await writeFile(resolve(target), `${JSON.stringify(migrated, null, 2)}\n`, 'utf8')
      return success({ output: resolve(target), apiVersion: migrated.apiVersion })
    }
    default: invalid('unknown or missing command')
  }
}

async function runWorkflow(access: WorkflowAgentAccessApi, args: readonly string[], context: AgentAccessContext, io: WorkflowCliIo) {
  const inputFile = option(args, '--input')
  const inputJson = option(args, '--input-json')
  if (inputFile !== undefined && inputJson !== undefined) invalid('run accepts only one of --input or --input-json')
  const inputs = inputJson === undefined
    ? inputFile === undefined ? {} : await readJsonObjectSource(inputFile, io)
    : parseJsonObject(inputJson, '--input-json')
  const idempotencyKey = option(args, '--idempotency-key')
  const result = await access.run({
    ref: requiredPositional(args, 0, 'run requires exact workflow id@revision'),
    inputs,
    mode: hasFlag(args, '--detach') ? 'background' : 'foreground',
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  }, context)
  return { data: result as unknown as JsonValue, exitCode: result.status === 'failed' || result.status === 'cancelled' ? 5 : 0 }
}

async function traceWorkflow(access: WorkflowAgentAccessApi, args: readonly string[], context: AgentAccessContext, io: WorkflowCliIo) {
  const runId = requiredPositional(args, 0, 'trace requires runId')
  const follow = hasFlag(args, '--follow')
  const requestedView = option(args, '--view')
  if (requestedView !== undefined && requestedView !== 'summary' && requestedView !== 'events') invalid('trace --view must be summary or events')
  const events = hasFlag(args, '--events') || follow || requestedView === 'events'
  const format = option(args, '--format') ?? (follow ? 'jsonl' : 'json')
  if (format !== 'json' && format !== 'jsonl') invalid('--format must be json or jsonl')
  if (follow && format !== 'jsonl') invalid('trace --follow requires --format jsonl')
  if (!follow) {
    const afterSeq = optionalInteger(args, '--after')
    const limit = optionalInteger(args, '--limit')
    return success(await access.trace({
      runId,
      view: events ? 'events' : 'summary',
      ...(afterSeq === undefined ? {} : { afterSeq }),
      ...(limit === undefined ? {} : { limit }),
    }, context))
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
    if (page.run.status !== 'running') return { data: {}, exitCode: page.run.status === 'failed' || page.run.status === 'cancelled' ? 5 : 0, streamed: true }
    await wait(250, context.signal)
  }
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

async function resolveOptions(args: readonly string[]): Promise<{ readonly databasePath: string; readonly hostModulePath?: string; readonly authorityRef?: string }> {
  const configPath = option(args, '--config')
  const config = configPath === undefined ? undefined : await readConfig(resolve(configPath))
  const base = configPath === undefined ? process.cwd() : dirname(resolve(configPath))
  const database = option(args, '--db') ?? config?.database ?? '.agent-dag-workflow.db'
  const hostModule = option(args, '--host') ?? config?.hostModule
  return {
    databasePath: resolve(base, database),
    ...(hostModule === undefined ? {} : { hostModulePath: resolve(base, hostModule) }),
    ...(config?.authorityRef === undefined ? {} : { authorityRef: config.authorityRef }),
  }
}

async function readConfig(path: string): Promise<WorkflowCliConfig> {
  let value: unknown
  try { value = JSON.parse(await readFile(path, 'utf8')) } catch (error: unknown) { invalid(`CLI config must be valid JSON: ${renderError(error)}`) }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('CLI config must be a JSON object')
  const config = value as Record<string, unknown>
  if (config.schemaVersion !== 1) invalid('CLI config schemaVersion must be 1')
  for (const key of Object.keys(config)) if (!['schemaVersion', 'database', 'hostModule', 'authorityRef'].includes(key)) invalid(`unsupported CLI config field: ${key}`)
  for (const key of ['database', 'hostModule', 'authorityRef']) if (config[key] !== undefined && (typeof config[key] !== 'string' || config[key].length === 0)) invalid(`CLI config ${key} must be a non-empty string`)
  return config as unknown as WorkflowCliConfig
}

async function readTemplateSource(path: string, io: WorkflowCliIo) {
  try { return parseWorkflowTemplate(path === '-' ? await io.readStdin() : await readFile(resolve(path), 'utf8')) }
  catch (error: unknown) { invalid(`template must be valid WorkflowTemplate JSON/YAML: ${renderError(error)}`) }
}

async function readJsonObjectSource(path: string, io: WorkflowCliIo): Promise<JsonObject> {
  return parseJsonObject(path === '-' ? await io.readStdin() : await readFile(resolve(path), 'utf8'), path)
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
    case 'search': assertArguments(args, ['--limit', '--after'], [], 0, 1); return
    case 'describe': assertArguments(args, ['--view'], [], 1, 1); return
    case 'run': assertArguments(args, ['--input', '--input-json', '--idempotency-key'], ['--detach'], 1, 1); return
    case 'run-get': assertArguments(args, [], [], 1, 1); return
    case 'trace': assertArguments(args, ['--view', '--format', '--after', '--limit'], ['--follow', '--events'], 1, 1); return
    case 'replay': assertArguments(args, ['--mode'], [], 1, 1); return
    case 'resume': assertArguments(args, ['--resolutions'], [], 1, 1); return
    case 'nodes': {
      const positionals = assertArguments(args, ['--limit'], [], 1, 2)
      if (positionals[0] !== 'search') invalid('nodes requires the search subcommand')
      return
    }
    case 'validate': assertArguments(args, [], [], 1, 1); return
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
    case 'migrate-template': assertArguments(args, ['--output'], [], 1, 1); return
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
  const flags = new Set(['--detach', '--follow', '--events', '--once'])
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
  if (argv[0] === 'draft' || argv[0] === 'nodes') return `${argv[0] ?? 'unknown'} ${argv[1] ?? ''}`.trim()
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
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveWait, reject) => {
    const timer = setTimeout(resolveWait, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
  })
}

function usage(): string {
  return 'Usage: agent-workflow search|describe|run|run-get|trace|replay|resume|nodes search|validate|draft get|draft put|diff|publish|worker --once|migrate-template ... [--db path] [--host module.mjs] [--config file]'
}
