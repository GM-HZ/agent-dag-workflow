import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const baseline = process.env.ADW_UPGRADE_FROM ?? '1.0.2'
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(baseline)) throw new Error('ADW_UPGRADE_FROM must be an exact version')
const workspace = await mkdtemp(join(tmpdir(), 'agent-dag-upgrade-'))
const database = join(workspace, 'workflow.db')
const host = join(workspace, 'upgrade-host.mjs')
const registry = 'https://registry.npmjs.org'
try {
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
    'install', '--ignore-scripts', '--omit=peer', '--no-audit', '--no-fund', '--package-lock=false', '--prefix', workspace,
    '--registry', registry, `@gm-hz/agent-dag-workflow@${baseline}`,
  ])
  await writeFile(host, `export default {
    authorityRef: 'cli:upgrade', authority: { type: 'upgrade-test' },
    authorityResolver: { async resolve(ref) { return ref === 'cli:upgrade' ? { type: 'upgrade-test' } : undefined } }
  }\n`)
  const previous = join(workspace, 'node_modules', '@gm-hz', 'agent-dag-workflow', 'lib', 'cli.js')
  const current = new URL('../lib/cli.js', import.meta.url)
  const template = new URL('../examples/script-transform.workflow.json', import.meta.url)
  const inputs = new URL('../examples/inputs/script-transform.json', import.meta.url)
  const args = ['--db', database, '--host', host]
  const from = (entry, ...command) => JSON.parse(run(process.execPath, [entry, ...command, ...args])).data
  from(previous, 'draft', 'put', fileURLToPath(template))
  from(previous, 'publish', 'script-transform-demo', '--expected', '1')
  const complete = from(previous, 'run', 'script-transform-demo@1', '--input', fileURLToPath(inputs))
  const unfinished = from(previous, 'run', 'script-transform-demo@1', '--input', fileURLToPath(inputs), '--detach')
  assert.equal(complete.outputs.total, 100)
  assert.equal(unfinished.status, 'accepted')

  const cli = fileURLToPath(current)
  const before = from(cli, 'doctor')
  const snapshot = join(workspace, 'before-upgrade.db')
  const rollback = join(workspace, 'rollback.db')
  from(cli, 'backup', snapshot)
  const backup = JSON.parse(run(process.execPath, [cli, 'backup-verify', snapshot])).data
  assert.equal(backup.schemaVersion, before.schemaVersion)
  assert.equal(backup.integrity, 'ok')
  const resumed = from(cli, 'worker', '--once')
  const after = from(cli, 'doctor')
  assert.equal(resumed.runId, unfinished.runId)
  assert.equal(resumed.status, 'completed')
  assert.equal(resumed.outputs.total, complete.outputs.total)
  assert(after.currentSchemaVersion >= before.schemaVersion)
  assert.equal(after.schemaVersion, after.currentSchemaVersion)
  const trace = from(cli, 'trace', complete.runId, '--events')
  assert(trace.events.some(event => event.type === 'run.completed'))
  const replay = from(cli, 'replay', complete.runId, '--mode', 'recorded')
  assert.deepEqual(replay.outputs, complete.outputs)
  const restored = JSON.parse(run(process.execPath, [cli, 'restore', snapshot, '--db', rollback])).data
  assert.equal(restored.schemaVersion, before.schemaVersion)
  const rollbackTrace = JSON.parse(run(process.execPath, [previous, 'trace', complete.runId, '--events', '--db', rollback, '--host', host])).data
  assert.deepEqual(rollbackTrace.events, trace.events)
  process.stdout.write(`Verified npm ${baseline} database upgrade (${before.schemaVersion} → ${after.schemaVersion}), old Journal, unfinished Run recovery and backup rollback.\n`)
} finally {
  await rm(workspace, { recursive: true, force: true })
}

function run(executable, args) {
  const result = spawnSync(executable, args, { encoding: 'utf8', env: {
    ...process.env, npm_config_cache: join(workspace, '.npm-cache'), npm_config_update_notifier: 'false',
  } })
  if (result.status !== 0) throw new Error(`${executable} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`)
  return result.stdout.trim()
}
