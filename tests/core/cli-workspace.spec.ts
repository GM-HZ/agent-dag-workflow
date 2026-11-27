import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { runWorkflowCli } from '../../src/adapters/cli/index.js'
import { resolveWorkflowCliOptions } from '../../src/adapters/cli/workspace.js'

const roots: string[] = []
const configName = '.agent-dag-workflow.json'
const databaseName = '.agent-dag-workflow.db'

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createTestDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-dag-cli-workspace-'))
  roots.push(root)
  return root
}

async function call(...args: string[]) {
  const output: string[] = []
  const exitCode = await runWorkflowCli(args, { stdout: line => { output.push(line) }, stderr() {}, async readStdin() { return '' } })
  return { exitCode, envelope: JSON.parse(output[0]!) }
}

it('initializes an editable project and uses its same database in a subdirectory', async () => {
  const directory = join(createTestDirectory(), 'orders with spaces')
  const config = join(directory, configName)
  const database = join(directory, databaseName)
  const template = join(directory, 'workflow.json')
  const inputs = join(directory, 'input.json')
  expect(await call('init', directory)).toMatchObject({ exitCode: 0, envelope: { data: { directory, config, database, template, inputs, workflowId: 'orders' } } })
  expect(existsSync(database)).toBe(false)
  expect(readFileSync(template, 'utf8')).toContain('"id": "orders"')

  const child = join(directory, 'reports')
  mkdirSync(child)
  vi.spyOn(process, 'cwd').mockReturnValue(child)
  expect(await call('doctor')).toMatchObject({ exitCode: 0, envelope: { data: {
    database, state: 'missing', databaseSource: 'config', config, configSource: 'discovered', authorityRef: 'cli:local',
  } } })
  expect(await call('trace', '--latest', '--workflow', 'orders')).toMatchObject({ envelope: { error: { code: 'WORKFLOW_RUN_NOT_FOUND' } } })
  expect(existsSync(database)).toBe(false)
  expect(await call('validate', '../workflow.json', '--input', '../input.json', '--strict')).toMatchObject({ exitCode: 0 })
  expect(await call('draft', 'put', '../workflow.json')).toMatchObject({ exitCode: 0 })
  expect(await call('publish', 'orders', '--expected', '1')).toMatchObject({ exitCode: 0 })
  const original = await call('run', 'orders@1', '--input', '../input.json')
  expect(original).toMatchObject({ exitCode: 0, envelope: { data: {
    status: 'completed', outputs: { total: 100, orderCount: 3 },
  } } })
  const other = await call('run', 'orders@1', '--input', '../input.json', '--authority', 'someone-else')
  expect(other).toMatchObject({ exitCode: 0, envelope: { data: { status: 'completed' } } })
  expect(await call('trace', '--latest', '--workflow', 'orders', '--stats')).toMatchObject({ exitCode: 0, envelope: { data: {
    runId: original.envelope.data.runId, ref: 'orders@1', totals: { attempts: 3 },
  } } })
  expect(await call('trace', '--latest', '--workflow', 'missing')).toMatchObject({ envelope: { error: { code: 'WORKFLOW_RUN_NOT_FOUND' } } })
  expect(await call('trace', original.envelope.data.runId, '--latest')).toMatchObject({ exitCode: 2 })
  expect(existsSync(database)).toBe(true)
  expect(existsSync(join(child, databaseName))).toBe(false)
  expect(await call('doctor')).toMatchObject({ exitCode: 0, envelope: { data: {
    database, state: 'readable', bytes: expect.any(Number), walBytes: expect.any(Number), totalBytes: expect.any(Number),
  } } })

  writeFileSync(inputs, '{}\n')
  expect(await call('init', directory)).toMatchObject({ exitCode: 2, envelope: { error: { code: 'WORKFLOW_REQUEST_INVALID' } } })
  expect(readFileSync(inputs, 'utf8')).toBe('{}\n')
})

it('installs the packaged Skill locally and preserves user changes', async () => {
  const directory = createTestDirectory()
  vi.spyOn(process, 'cwd').mockReturnValue(directory)
  const path = join(directory, '.agents', 'skills', 'workflow-builder', 'SKILL.md')
  expect(await call('skill', 'install')).toMatchObject({ exitCode: 0, envelope: { data: { skill: 'workflow-builder', path, created: true } } })
  expect(readFileSync(path, 'utf8')).toContain('npm exec --no -- adw')
  expect(await call('skill', 'install')).toMatchObject({ exitCode: 0, envelope: { data: { created: false } } })
  writeFileSync(path, 'existing user content')
  expect(await call('skill', 'install')).toMatchObject({ exitCode: 2, envelope: { error: { code: 'WORKFLOW_REQUEST_INVALID' } } })
  expect(readFileSync(path, 'utf8')).toBe('existing user content')
})

it('preserves explicit overrides, existing standalone databases, and Git worktree boundaries', async () => {
  const parent = createTestDirectory()
  const child = join(parent, 'nested')
  mkdirSync(child)
  writeFileSync(join(parent, configName), JSON.stringify({ schemaVersion: 1, database: 'parent.db', authorityRef: 'parent' }))
  await expect(resolveWorkflowCliOptions({ database: 'explicit.db' }, child)).resolves.toEqual({
    databasePath: join(child, 'explicit.db'), databaseSource: 'flag', hostRequiresExplicitSelection: false,
  })
  await expect(resolveWorkflowCliOptions({ config: '../.agent-dag-workflow.json', database: 'override.db', authority: 'override' }, child)).resolves.toMatchObject({
    databasePath: join(parent, 'override.db'), databaseSource: 'flag', configSource: 'explicit', authorityRef: 'override', authoritySource: 'flag',
  })
  writeFileSync(join(child, databaseName), '')
  await expect(resolveWorkflowCliOptions({}, child)).resolves.toMatchObject({ databaseSource: 'working-directory', databasePath: join(child, databaseName) })
  rmSync(join(child, databaseName))
  writeFileSync(join(child, '.git'), 'gitdir: /example')
  await expect(resolveWorkflowCliOptions({}, child)).resolves.toMatchObject({ databaseSource: 'working-directory', databasePath: join(child, databaseName) })
})

it('diagnoses a discovered Host without executing it and permits explicit selection', async () => {
  const directory = createTestDirectory()
  const executed = join(directory, 'loaded')
  const config = join(directory, configName)
  vi.spyOn(process, 'cwd').mockReturnValue(directory)
  writeFileSync(config, JSON.stringify({ schemaVersion: 1, hostModule: './host.mjs' }))
  writeFileSync(join(directory, 'host.mjs'), `import { writeFileSync } from 'node:fs'
writeFileSync(new URL('./loaded', import.meta.url), '')
export default { authorityRef: 'fixture:host' }`)
  expect(await call('doctor')).toMatchObject({ exitCode: 0, envelope: { data: {
    hostState: 'requires-explicit-selection', authorityRef: null, authoritySource: 'unresolved',
  } } })
  expect(await call('runs')).toMatchObject({ exitCode: 2, envelope: { error: { code: 'WORKFLOW_REQUEST_INVALID' } } })
  expect(existsSync(executed)).toBe(false)
  expect(await call('doctor', '--config', config)).toMatchObject({ exitCode: 0, envelope: { data: {
    configSource: 'explicit', hostState: 'loaded', authorityRef: 'fixture:host', authoritySource: 'host',
  } } })
  expect(existsSync(executed)).toBe(true)
})
