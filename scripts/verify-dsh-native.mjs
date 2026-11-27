import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { nativeCanvasSmoke } from './native-dsh/browser.mjs'

const version = process.env.AGENT_DAG_DSH_VERSION ?? '0.2.2-rc.5'
const cordisByDsh = new Map([['0.2.0-rc.2', '4.0.4'], ['0.2.2-rc.5', '4.1.0']])
const cordis = cordisByDsh.get(version)
assert(cordis !== undefined, 'Unsupported native DSH regression target: ' + version)
const root = resolve(import.meta.dirname, '..')
const playwright = join(root, 'node_modules', '.bin', 'playwright-cli')
assert(existsSync(join(root, 'lib', 'canvas', 'index.js')), 'Run pnpm build before verifying native DSH')
assert(existsSync(playwright), 'Install workspace dependencies before verifying native DSH')

const temp = await mkdtemp(join(tmpdir(), 'agent-dag-native-dsh-'))
const home = join(temp, 'profile')
const workspace = join(temp, 'workspace')
const runtime = join(temp, 'runtime')
const session = 'agent-dag-native-' + process.pid
const outputFile = join(temp, 'journal.jsonl')
const evidenceFile = join(temp, 'evidence.json')
const env = {
  ...process.env,
  PATH: [dirname(process.execPath), process.env.PATH ?? ''].join(delimiter),
  DSH_HOME: home, DO_NOT_TRACK: '1', NO_UPDATE_NOTIFIER: '1',
  npm_config_registry: 'https://registry.npmjs.org',
  npm_config_cache: process.env.AGENT_DAG_DSH_NPM_CACHE ?? join(temp, 'npm-cache'),
  npm_config_userconfig: join(temp, 'npmrc'),
}
delete env.DEEPSEEK_API_KEY
delete env.DEEPSEEK_AUTH_TOKEN
delete env.NODE_AUTH_TOKEN
delete env.NPM_TOKEN

let server
let serverLog = ''
let authUrl
let browserOpened = false
try {
  await Promise.all([
    mkdir(workspace), mkdir(runtime), writeFile(env.npm_config_userconfig, ''),
    mkdir(join(home, 'profiles', 'web', 'node_modules', '@gm-hz'), { recursive: true }),
  ])
  const patch = join(temp, 'fixture.patch.yml')
  const fixture = join(import.meta.dirname, 'native-dsh', 'workspace.mjs')
  await writeFile(patch, '- insert:\n    - id: agent-dag-workflow-native-smoke\n      name: ' + JSON.stringify(fixture) + '\n')
  const override = process.env.AGENT_DAG_DSH_BINARY
  if (override === undefined) {
    const [major, minor] = process.versions.node.split('.').map(Number)
    assert(major > 24 || (major === 24 && minor >= 9), 'Native npm DSH smoke requires Node 24.9 or newer, or supply AGENT_DAG_DSH_BINARY')
  }
  execute('npm', ['pack', root, '--ignore-scripts', '--pack-destination', temp], { timeout: 120_000 })
  const [filename, ...others] = (await readdir(temp)).filter(name => name.endsWith('.tgz'))
  assert(filename !== undefined && others.length === 0, 'Expected one workflow tarball')
  const candidates = [join(temp, filename), ...(override === undefined ? ['@deepseek-ai/dsh@' + version]
    : ['@deepseek-ai/cordis@' + cordis, '@deepseek-ai/dsh-typert-protocol@' + version])]
  execute('npm', [
    'install', '--prefix', runtime, '--ignore-scripts', '--prefer-offline', '--no-audit', '--no-fund', '--package-lock=false', ...candidates,
  ], { timeout: 600_000 })
  const packagePath = join(runtime, 'node_modules', '@gm-hz', 'agent-dag-workflow')
  const profilePackage = join(home, 'profiles', 'web', 'node_modules', '@gm-hz', 'agent-dag-workflow')
  await symlink(packagePath, profilePackage, 'junction')
  const binary = override ?? join(runtime, 'node_modules', '.bin', 'dsh')
  assert.equal(execute(binary, ['--version']).trim(), version, 'Unexpected native DSH version')

  server = spawn(binary, [
    'web', '--patch', join(packagePath, 'cordis.patch.yml'), '--patch', patch, '--host', '127.0.0.1', '--port', '0', '--no-open',
  ], { cwd: workspace, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  server.on('error', error => { serverLog += error.message + '\n' })
  for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => { serverLog += chunk.toString() })
  authUrl = await waitForNativeHost()
  browserOpened = true
  runBrowser('open', authUrl)
  runBrowser('snapshot')
  runBrowser('run-code', 'async page => (' + nativeCanvasSmoke.toString() + ')(page, ' + [outputFile, evidenceFile].map(value => JSON.stringify(value)).join(', ') + ')')
  await verifySavedJournal()
} catch (error) {
  if (serverLog !== '') console.error('Native DSH diagnostics:\n' + redact(serverLog).slice(-6_000))
  throw error
} finally {
  if (browserOpened) {
    try { runBrowser('close') } catch { /* preserve the smoke error */ }
  }
  if (server !== undefined) await stopServer(server)
  if (process.env.AGENT_DAG_DSH_KEEP_SMOKE === '1') console.log('Native DSH smoke files: ' + temp)
  else await rm(temp, { recursive: true, force: true })
}

async function waitForNativeHost() {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null || server.pid === undefined) {
      throw new Error('Native DSH exited before the workflow fixture loaded')
    }
    const match = /^dsh web: (http:\/\/\S+)/m.exec(serverLog)
    if (match?.[1] !== undefined && existsSync(join(home, 'fixture-ready.json'))) {
      const url = new URL(match[1])
      assert.equal(url.hostname, '127.0.0.1', 'Native DSH smoke must stay on loopback')
      return url.href
    }
    await delay(200)
  }
  throw new Error('Timed out waiting for native DSH and the fixture workspace')
}

async function verifySavedJournal() {
  const fixture = JSON.parse(await readFile(join(home, 'fixture-ready.json'), 'utf8'))
  const [header, ...downloaded] = (await readFile(outputFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const db = new DatabaseSync(join(home, 'agent-dag-workflow', 'workflows.db'), { readOnly: true })
  try {
    const rows = db.prepare('SELECT run_id, status, checkpoint_json, execution_json FROM workflow_runs ORDER BY run_id').all()
    assert.equal(rows.length, 2)
    assert(rows.some(row => row.run_id === fixture.hiddenRunId))
    const shown = rows.find(row => row.run_id === header.runId)
    assert(shown, 'Browser journal run was not stored in SQLite')
    assert.equal(shown.status, 'completed')
    assert.equal(JSON.parse(shown.execution_json).authorityRef, 'dsh-session:' + fixture.owner)
    assert.deepEqual(JSON.parse(shown.checkpoint_json).resultOutputs, { message: 'Native DSH package smoke' })
    const events = db.prepare('SELECT event_json FROM workflow_run_events WHERE run_id = ? ORDER BY seq')
      .all(header.runId).map(row => JSON.parse(row.event_json))
    assert(events.some(event => event.type === 'run.completed'))
    assert.equal(header.format, 'agent-dag-workflow.journal/v1')
    assert.equal(header.type, 'run.snapshot')
    assert.equal(header.status, 'completed')
    assert.equal(header.checkpointSeq, events.at(-1).seq)
    assert.deepEqual(downloaded, events)
    const evidence = JSON.parse(await readFile(evidenceFile, 'utf8'))
    const { verifyWorkflowEvidence } = await import('../lib/journal/index.js')
    verifyWorkflowEvidence(evidence)
    assert.equal(evidence.run.runId, header.runId)
    assert.equal(evidence.run.inputs.message, '[REDACTED]')
    assert(evidence.artifacts.some(artifact => artifact.status === 'redacted'))
    console.log('DSH ' + version + ' package smoke passed: Canvas launch, scoped history, redacted evidence and ' + events.length + ' stored journal events')
  } finally { db.close() }
}

function execute(binary, args, { timeout = 45_000 } = {}) {
  const result = spawnSync(binary, args, { cwd: temp, env, timeout, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
  if (result.status !== 0) {
    throw new Error(redact([binary + ' ' + args[0] + ' failed', result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n')))
  }
  return result.stdout
}

function runBrowser(...args) {
  const output = execute(playwright, ['--session', session, ...args], { timeout: 120_000 })
  if (/^### Error|^Error:|^TimeoutError:/m.test(output)) throw new Error(redact(output))
}

function redact(text) {
  return (authUrl === undefined ? text : text.replaceAll(authUrl, new URL(authUrl).origin))
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s"']+/gu, '$1?<redacted>')
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return
  const exited = once(child, 'exit').catch(() => {})
  const signal = name => {
    try { process.kill(-child.pid, name) } catch { /* group already stopped */ }
  }
  signal('SIGTERM')
  await Promise.race([exited, delay(2_000, undefined, { ref: false })])
  if (child.exitCode === null && child.signalCode === null) {
    signal('SIGKILL')
    await Promise.race([exited, delay(2_000, undefined, { ref: false })])
  }
}
