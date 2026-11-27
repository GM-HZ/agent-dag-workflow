import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const workspace = await mkdtemp(join(tmpdir(), 'agent-dag-workflow-pack-'))

try {
  const networkInstall = process.env.CI === 'true' || process.env.AGENT_DAG_VERIFY_NETWORK_INSTALL === '1'
  command('npm', ['pack', root, '--ignore-scripts', '--pack-destination', workspace], root)
  const tarballs = (await readdir(workspace)).filter(filename => filename.endsWith('.tgz'))
  if (tarballs.length !== 1) throw new Error(`npm pack produced ${tarballs.length} tarballs`)
  const [filename] = tarballs
  const tarball = join(workspace, filename)
  await writeFile(join(workspace, 'package.json'), '{"private":true,"type":"module"}\n')
  if (networkInstall) {
    command('npm', [
      'install', '--ignore-scripts', '--omit=peer', '--no-audit', '--no-fund', '--package-lock=false',
      '--prefix', workspace, tarball,
    ], workspace)
  } else {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      const destination = join(workspace, 'node_modules', dependency)
      await mkdir(resolve(destination, '..'), { recursive: true })
      await symlink(join(root, 'node_modules', dependency), destination, 'junction')
    }
  }
  const packageDirectory = join(workspace, 'node_modules', '@gm-hz', 'agent-dag-workflow')
  if (!networkInstall) {
    await mkdir(packageDirectory, { recursive: true })
    command('tar', ['-xzf', tarball, '--strip-components=1', '-C', packageDirectory], workspace)
  }
  const packedManifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'))
  if (packedManifest.bin?.adw !== 'lib/cli.js' || packedManifest.bin?.['agent-workflow'] !== 'lib/cli.js') {
    throw new Error('packed manifest does not expose equivalent adw and agent-workflow CLI entries')
  }
  if (!(await readFile(join(packageDirectory, 'lib', 'cli.js'), 'utf8')).startsWith('#!/usr/bin/env node\n')) {
    throw new Error('packed CLI entry is missing its Node shebang')
  }
  if (existsSync(join(packageDirectory, 'docs', '.vitepress'))) {
    throw new Error('packed artifact contains VitePress cache, build output, or site-only sources')
  }
  if (existsSync(join(workspace, 'node_modules', '@deepseek-ai'))) throw new Error('clean consumer unexpectedly installed a DSH/Cordis peer')
  await writeFile(join(workspace, 'smoke.mjs'), `
    import * as root from '@gm-hz/agent-dag-workflow'
    import * as runtime from '@gm-hz/agent-dag-workflow/runtime'
    import * as sqlite from '@gm-hz/agent-dag-workflow/sqlite'
    import * as mcp from '@gm-hz/agent-dag-workflow/mcp'
    import * as triggers from '@gm-hz/agent-dag-workflow/triggers'
    import * as cli from '@gm-hz/agent-dag-workflow/cli'
    const required = [
      root.WorkflowRuntime, runtime.WorkflowRuntime, sqlite.SqliteWorkflowRunStore,
      sqlite.SqliteWorkflowBindingRepository, mcp.createMcpGateway,
      triggers.WorkflowBindingCatalog, cli.runWorkflowCli,
    ]
    if (required.some(value => typeof value !== 'function')) throw new Error('one or more host-neutral package exports are unavailable')
  `)
  command(process.execPath, [join(workspace, 'smoke.mjs')], workspace)
  const cliOutput = command(process.execPath, [
    join(packageDirectory, 'lib', 'cli.js'), 'search', '--db', join(workspace, 'workflow.db'),
  ], workspace)
  const cliEnvelope = JSON.parse(cliOutput)
  if (cliEnvelope.protocolVersion !== 'agent-workflow.cli/v1' || cliEnvelope.ok !== true
    || !Array.isArray(cliEnvelope.data?.items)) throw new Error('packed CLI did not return a valid v1 search envelope')

  const cliPath = join(packageDirectory, 'lib', 'cli.js')
  const demo = JSON.parse(command(process.execPath, [cliPath, 'demo', '--db', join(workspace, 'demo.db')], workspace))
  if (demo.protocolVersion !== 'agent-workflow.cli/v1' || demo.ok !== true || demo.data?.status !== 'completed'
    || demo.data.outputs?.total !== 100 || !Array.isArray(demo.data.traceCommand)) {
    throw new Error('packed CLI did not run the bundled demo from the consumer workspace')
  }
  const trace = JSON.parse(command(process.execPath, [cliPath, ...demo.data.traceCommand.slice(1)], workspace))
  if (trace.data?.run?.runId !== demo.data.runId || !trace.data.events?.some(event => event.type === 'run.completed')) {
    throw new Error('packed CLI could not read the bundled demo trace in a second process')
  }
  const history = JSON.parse(command(process.execPath, [cliPath, 'runs', '--status', 'completed', '--db', join(workspace, 'demo.db')], workspace))
  if (history.data?.items?.[0]?.runId !== demo.data.runId) throw new Error('packed CLI could not rediscover the demo run from history')
  const journal = command(process.execPath, [cliPath, 'trace', demo.data.runId, '--all', '--limit', '2', '--db', join(workspace, 'demo.db')], workspace)
    .split('\n').map(line => JSON.parse(line))
  if (journal[0]?.format !== 'agent-dag-workflow.journal/v1' || journal[0].type !== 'run.snapshot'
    || journal.length !== journal[0].checkpointSeq + 1 || journal.at(-1)?.seq !== journal[0].checkpointSeq) {
    throw new Error('packed CLI did not export the complete demo Journal')
  }
  const demoDatabase = join(workspace, 'demo.db')
  const journalFile = join(workspace, 'demo.jsonl')
  command(process.execPath, [cliPath, 'trace', demo.data.runId, '--all', '--output', journalFile, '--db', demoDatabase], workspace)
  const checkedJournal = JSON.parse(command(process.execPath, [cliPath, 'verify-log', journalFile], workspace))
  if (checkedJournal.data?.checkpointSeq !== journal[0].checkpointSeq) throw new Error('packed CLI could not verify the exported Journal')
  const sample = join(workspace, 'demo.case.json')
  const template = join(packageDirectory, 'examples', 'script-transform.workflow.json')
  command(process.execPath, [cliPath, 'case', 'from-run', demo.data.runId, '--output', sample, '--db', demoDatabase], workspace)
  const compared = JSON.parse(command(process.execPath, [cliPath, 'case', 'compare', sample, '--base', template, '--candidate', template, '--db', demoDatabase], workspace))
  if (compared.data?.passed !== true || compared.data.results?.[0]?.candidate?.outputs?.total !== 100) {
    throw new Error('packed CLI could not run an offline regression from persisted history')
  }

  const project = join(workspace, 'orders-workflow')
  command(process.execPath, [cliPath, 'init', project], workspace)
  const child = join(project, 'reports')
  await mkdir(child)
  const doctor = JSON.parse(command(process.execPath, [cliPath, 'doctor'], child))
  const projectConfig = JSON.parse(await readFile(join(project, '.agent-dag-workflow.json'), 'utf8'))
  if (doctor.data?.state !== 'missing' || doctor.data?.database !== join(await realpath(project), projectConfig.database)) {
    throw new Error('packed CLI could not resolve the new project database from a subdirectory')
  }
  const workflowFile = join(project, 'workflow.json')
  const inputFile = join(project, 'input.json')
  command(process.execPath, [cliPath, 'validate', workflowFile, '--input', inputFile, '--strict'], child)
  command(process.execPath, [cliPath, 'draft', 'put', workflowFile], child)
  command(process.execPath, [cliPath, 'publish', 'orders', '--expected', '1'], child)
  const orderRun = JSON.parse(command(process.execPath, [cliPath, 'run', 'orders@1', '--input', inputFile], child))
  if (orderRun.data?.status !== 'completed' || orderRun.data.outputs.total !== 100) throw new Error('packed CLI orders starter did not complete')
  const latest = JSON.parse(command(process.execPath, [cliPath, 'trace', '--latest', '--workflow', 'orders', '--stats'], child))
  if (latest.data?.runId !== orderRun.data.runId || latest.data.totals?.attempts !== 3) throw new Error('packed CLI latest Trace selected the wrong run')
  const installedSkill = JSON.parse(command(process.execPath, [cliPath, 'skill', 'install'], project))
  const skillPath = join(project, '.agents', 'skills', 'workflow-builder', 'SKILL.md')
  if (installedSkill.data?.created !== true || (await realpath(installedSkill.data.path)) !== await realpath(skillPath)
    || !(await readFile(skillPath, 'utf8')).includes('npm exec --no -- adw')) {
    throw new Error('packed CLI could not install the project Skill')
  }
  const mcpDoctor = JSON.parse(command(process.execPath, [join(packageDirectory, 'lib', 'mcp-cli.js'), '--config', join(project, '.agent-dag-workflow.json'), '--doctor'], workspace))
  if (mcpDoctor.authorityRef !== 'cli:local' || await realpath(mcpDoctor.database) !== await realpath(doctor.data.database)) {
    throw new Error('packed MCP did not select the same project database and execution identity as the CLI')
  }
  const relocated = await mkdtemp(join(tmpdir(), 'adw-plugin-relocated-'))
  try {
    const wrapper = join(relocated, 'agent-workflow.mjs')
    await writeFile(wrapper, await readFile(join(packageDirectory, 'integrations', 'codex', 'agent-dag-workflow', 'scripts', 'agent-workflow.mjs')))
    const wrapped = JSON.parse(command(process.execPath, [wrapper, 'search', 'orders'], project))
    if (wrapped.data?.items?.[0]?.ref !== 'orders@1') throw new Error('relocated Plugin wrapper could not resolve the npm-local CLI')
  } finally { await rm(relocated, { recursive: true, force: true }) }
  const evidence = join(workspace, 'orders.evidence.json')
  command(process.execPath, [cliPath, 'evidence', orderRun.data.runId, '--artifacts', '--redact', 'customer', '--output', evidence], child)
  command(process.execPath, [cliPath, 'verify-evidence', evidence], child)

  if (networkInstall) {
    const aliasOutput = command(join(workspace, 'node_modules', '.bin', 'adw'), [
      'search', '--db', join(workspace, 'workflow-alias.db'),
    ], workspace)
    const aliasEnvelope = JSON.parse(aliasOutput)
    if (aliasEnvelope.protocolVersion !== 'agent-workflow.cli/v1' || aliasEnvelope.ok !== true
      || !Array.isArray(aliasEnvelope.data?.items)) throw new Error('installed adw alias did not return a valid v1 search envelope')
    const latestThroughNpm = JSON.parse(command('npm', ['exec', '--no', '--', 'adw', 'trace', '--latest', '--workflow', 'orders'], project))
    if (latestThroughNpm.data?.run?.runId !== orderRun.data.runId) throw new Error('npm-local adw command could not recover the project trace')
  }
  process.stdout.write(`verified ${networkInstall ? 'clean network' : 'isolated local'} tarball install: ${filename}\n`)
} finally {
  await rm(workspace, { recursive: true, force: true })
}

function command(executable, args, cwd) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_config_cache: join(workspace, '.npm-cache'),
      npm_config_update_notifier: 'false',
    },
  })
  if (result.status !== 0) throw new Error(`${executable} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`)
  return result.stdout.trim()
}
