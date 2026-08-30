import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const examplesDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(examplesDirectory, '..')
const wrapper = resolve(repositoryRoot, 'integrations/codex/agent-dag-workflow/scripts/agent-workflow.mjs')
const manifest = JSON.parse(readFileSync(resolve(examplesDirectory, 'manifest.json'), 'utf8'))
const requestedDatabase = option('--db')
const temporaryRoot = requestedDatabase === undefined ? mkdtempSync(join(tmpdir(), 'agent-dag-codex-regression-')) : undefined
const database = resolve(requestedDatabase ?? join(temporaryRoot, 'workflow.db'))
const host = resolve(examplesDirectory, manifest.host)
const jsonOutput = hasFlag('--json')
const keep = hasFlag('--keep') || requestedDatabase !== undefined

assertArguments()

try {
  const installed = []
  for (const example of manifest.examples) {
    const workflow = resolve(examplesDirectory, example.workflow)
    invoke(['validate', workflow])
    const draft = invoke(['draft', 'put', workflow]).data
    let published
    for (let revision = 1; revision <= example.revision; revision++) {
      published = invoke(['publish', example.id, '--expected', String(draft.revision)]).data
    }
    if (published.ref !== `${example.id}@${example.revision}`) {
      throw new Error(`${example.id} published unexpected ref: ${published.ref}`)
    }
    installed.push(published.ref)
  }

  const results = []
  for (const example of manifest.examples) {
    const ref = `${example.id}@${example.revision}`
    const search = invoke(['search', example.id]).data
    if (!search.items.some(item => item.ref === ref)) throw new Error(`${ref} was not discoverable through Codex search`)
    const description = invoke(['describe', ref, '--view', 'schema']).data
    if (description.ref !== ref || description.inputSchema === undefined || description.outputSchema === undefined) {
      throw new Error(`${ref} did not expose its callable schema`)
    }
    const run = invoke(['run', ref, '--input', resolve(examplesDirectory, example.input)]).data
    if (run.status !== 'completed') throw new Error(`${ref} ${run.status}: ${run.error ?? 'unknown failure'}`)
    const expected = JSON.parse(readFileSync(resolve(examplesDirectory, example.expected), 'utf8'))
    assertSubset(run.outputs, expected, `${ref}.outputs`)
    const persisted = invoke(['run-get', run.runId]).data
    if (persisted.status !== 'completed') throw new Error(`${ref} persisted status is ${persisted.status}`)
    const trace = invoke(['trace', run.runId, '--events', '--limit', '1000']).data
    const lastSeq = trace.events.at(-1)?.seq ?? 0
    if (lastSeq < 1 || trace.run.status !== 'completed') throw new Error(`${ref} did not expose an authoritative completed Trace`)
    results.push({
      id: example.id,
      ref,
      title: example.title,
      runId: run.runId,
      status: run.status,
      events: trace.events.length,
      lastSeq,
    })
  }

  const report = {
    protocolVersion: 'agent-dag-workflow.examples/v1',
    accessPath: 'codex-plugin-wrapper',
    database,
    installed,
    passed: results.length,
    total: manifest.examples.length,
    results,
  }
  if (jsonOutput) console.log(JSON.stringify(report))
  else printReport(report)
} catch (error) {
  if (jsonOutput) console.log(JSON.stringify({ protocolVersion: 'agent-dag-workflow.examples/v1', ok: false, error: renderError(error) }))
  else console.error(`Example regression failed: ${renderError(error)}`)
  process.exitCode = 1
} finally {
  if (!keep && temporaryRoot !== undefined) rmSync(temporaryRoot, { recursive: true, force: true })
}

function invoke(args) {
  const result = spawnSync(process.execPath, [wrapper, ...args, '--db', database, '--host', host], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
  const output = result.stdout.trim()
  let envelope
  try { envelope = JSON.parse(output) } catch { throw new Error(`${args.join(' ')} returned non-JSON output: ${output || result.stderr}`) }
  if (result.status !== 0 || envelope.ok !== true) {
    throw new Error(`${args.join(' ')} failed: ${envelope.error?.code ?? result.status} ${envelope.error?.message ?? result.stderr}`)
  }
  return envelope
}

function assertSubset(actual, expected, path) {
  if (expected === null || typeof expected !== 'object') {
    if (!Object.is(actual, expected)) throw new Error(`${path} expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`)
    return
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) throw new Error(`${path} expected an array of length ${expected.length}`)
    expected.forEach((value, index) => assertSubset(actual[index], value, `${path}[${index}]`))
    return
  }
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) throw new Error(`${path} expected an object`)
  for (const [key, value] of Object.entries(expected)) assertSubset(actual[key], value, `${path}.${key}`)
}

function printReport(report) {
  console.log(`Codex Example Regression · ${report.passed}/${report.total} passed`)
  console.log(`Access     ${report.accessPath}`)
  console.log(`Database   ${keep ? report.database : 'ephemeral test database'}`)
  for (const result of report.results) {
    console.log(`✓ ${result.ref.padEnd(38)} ${String(result.events).padStart(3)} events · ${result.title}`)
  }
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
  const values = new Set(['--db'])
  const flags = new Set(['--json', '--keep'])
  for (let offset = 2; offset < process.argv.length; offset++) {
    const argument = process.argv[offset]
    if (argument === '--') continue
    if (flags.has(argument)) continue
    if (!values.has(argument)) throw new Error(`unknown option: ${argument}`)
    const value = process.argv[++offset]
    if (value === undefined || value.startsWith('--')) throw new Error(`${argument} requires a value`)
  }
}

function renderError(error) { return error instanceof Error ? error.message : String(error) }
