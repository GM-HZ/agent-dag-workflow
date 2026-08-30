import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
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
  await mkdir(packageDirectory, { recursive: true })
  command('tar', ['-xzf', tarball, '--strip-components=1', '-C', packageDirectory], workspace)
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
