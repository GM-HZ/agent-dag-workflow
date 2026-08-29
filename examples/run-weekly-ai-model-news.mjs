import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWorkflowCliApplication } from '../lib/adapters/cli/index.js'
import { materializeWorkflowTemplate, parseWorkflowTemplate, snapshotJsonObject } from '../lib/core/index.js'

const examplesDirectory = fileURLToPath(new URL('./', import.meta.url))
const cliPath = fileURLToPath(new URL('../lib/cli.js', import.meta.url))
const defaults = {
  template: resolve(examplesDirectory, 'weekly-ai-model-news.workflow.json'),
  input: resolve(examplesDirectory, 'weekly-ai-model-news.inputs.json'),
  host: resolve(examplesDirectory, 'weekly-ai-model-news.mock-host.mjs'),
  database: resolve('.agent-dag-workflow.db'),
}

if (hasFlag('--help')) {
  console.log(`Run the AI model weekly-report workflow end to end.

Usage:
  node examples/run-weekly-ai-model-news.mjs [options]

Options:
  --db <path>       Persistent SQLite database (default: .agent-dag-workflow.db)
  --host <path>     Host gateway module (default: deterministic mock Host)
  --input <path>    Workflow JSON inputs
  --json            Emit one machine-readable JSON result
  --help            Show this help

The default Host is deterministic and offline. Pass a Host module that exposes
web_search and Agent gateways to run against real external capabilities.`)
  process.exit(0)
}

assertArguments()
const databasePath = resolve(option('--db') ?? defaults.database)
const hostModulePath = resolve(option('--host') ?? defaults.host)
const inputPath = resolve(option('--input') ?? defaults.input)
const jsonOutput = hasFlag('--json')
let application

try {
  application = await createWorkflowCliApplication({ databasePath, hostModulePath })
  const context = {
    authorityRef: application.host.authorityRef ?? 'example:weekly',
    authority: application.host.authority ?? { type: 'example-local' },
    origin: { type: 'cli', source: 'example:weekly' },
  }
  const template = parseWorkflowTemplate(await readFile(defaults.template, 'utf8'))
  const inputs = snapshotJsonObject(JSON.parse(await readFile(inputPath, 'utf8')))
  const diagnostics = (await application.access.validate(template, context)).diagnostics
  const errors = diagnostics.filter(item => item.severity === 'error')
  if (errors.length > 0) throw new Error(`workflow template validation failed:\n${JSON.stringify(errors, null, 2)}`)

  const materialized = materializeWorkflowTemplate(template)
  let draft
  try {
    const current = await application.runtime.readDraft(template.metadata.id)
    draft = current.contentHash === materialized.contentHash
      ? current
      : await application.runtime.updateDraft(current.id, current.revision, template)
  } catch (error) {
    if (!isCatalogNotFound(error)) throw error
    draft = await application.runtime.createDraft(template)
  }

  let published
  try {
    const latest = await application.runtime.getPublished(draft.id)
    published = latest.semanticHash === draft.semanticHash
      ? latest
      : await application.runtime.publish(draft.id, draft.revision)
  } catch (error) {
    if (!isCatalogNotFound(error)) throw error
    published = await application.runtime.publish(draft.id, draft.revision)
  }

  const result = await application.access.run({ ref: `${published.id}@${published.revision}`, inputs }, context)
  const trace = await application.access.trace({ runId: result.runId, view: 'events', limit: 1000 }, context)
  const events = trace.events ?? []
  const report = {
    mode: hostModulePath === defaults.host ? 'deterministic-offline' : 'host',
    workflowRef: `${published.id}@${published.revision}`,
    databasePath,
    hostModulePath,
    result,
    audit: {
      eventCount: events.length,
      completedNodes: events.filter(event => event.type === 'node.completed').length,
      externalInvocations: events.filter(event => event.type === 'capability.completed').length,
      lastSeq: events.at(-1)?.seq ?? 0,
    },
    traceCommand: [
      process.execPath, cliPath, 'trace', result.runId, '--events', '--limit', '1000',
      '--db', databasePath, '--host', hostModulePath,
    ],
  }

  if (jsonOutput) console.log(JSON.stringify(report))
  else printReport(report)
  if (result.status === 'failed' || result.status === 'cancelled') process.exitCode = 5
} catch (error) {
  if (jsonOutput) console.log(JSON.stringify({ ok: false, error: renderError(error) }))
  else console.error(`AI 模型周报运行失败：${renderError(error)}`)
  process.exitCode = 1
} finally {
  await application?.close()
}

function printReport(report) {
  const mode = report.mode === 'deterministic-offline' ? '离线确定性 Host' : '外部 Host'
  console.log(`AI 模型周报 · ${mode}`)
  console.log(`Workflow  ${report.workflowRef}`)
  console.log(`Run       ${report.result.runId} (${report.result.status})`)
  console.log(`Trace     ${report.audit.eventCount} events · ${report.audit.completedNodes} nodes · ${report.audit.externalInvocations} external calls`)
  if (report.result.status === 'completed') {
    const outputs = report.result.outputs
    console.log(`Result    ${outputs.candidateCount} candidates → ${outputs.items.length} selected`)
    for (const item of outputs.items) console.log(`${String(item.rank).padStart(2, ' ')}. [${item.importanceScore}] ${item.title} — ${item.digest}`)
  } else {
    console.log(`Error     ${report.result.error ?? 'workflow did not complete'}`)
  }
  console.log(`\n完整 Trace：\n${report.traceCommand.map(shellQuote).join(' ')}`)
}

function option(name) {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function hasFlag(name) { return process.argv.includes(name) }

function assertArguments() {
  const values = new Set(['--db', '--host', '--input'])
  const flags = new Set(['--json'])
  for (let offset = 2; offset < process.argv.length; offset++) {
    const argument = process.argv[offset]
    if (argument === '--') continue
    if (flags.has(argument)) continue
    if (!values.has(argument)) throw new Error(`unknown option: ${argument}`)
    const value = process.argv[++offset]
    if (value === undefined || value.startsWith('--')) throw new Error(`${argument} requires a value`)
  }
}

function isCatalogNotFound(error) { return error instanceof Error && 'code' in error && error.code === 'CATALOG_NOT_FOUND' }
function renderError(error) { return error instanceof Error ? error.message : String(error) }
function shellQuote(value) { return /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'` }
