#!/usr/bin/env node
import { createWorkflowCliApplication, loadWorkflowCliHost, type WorkflowCliHost } from './adapters/cli/application.js'
import { resolveWorkflowCliOptions, type ResolvedWorkflowCliOptions } from './adapters/cli/workspace.js'
import { createMcpGateway, serveWorkflowMcpStdio, type WorkflowMcpProfile } from './adapters/mcp/index.js'

try { await main(process.argv.slice(2)) }
catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}

async function main(argv: readonly string[]): Promise<void> {
  if (argv.length === 1 && argv[0] === '--help') {
    console.log('Usage: agent-workflow-mcp [--config FILE] [--db PATH] [--host MODULE] [--authority REF] [--profile invoke|author] [--doctor]')
    return
  }
  const { flags, doctor } = parseArgs(argv)
  const profile = mcpProfile(flags.get('--profile') ?? 'invoke')
  // An MCP client owns the launch context. A checked-out project is only read
  // when the client explicitly designates its config file.
  const options = await resolveWorkflowCliOptions({
    database: flags.get('--db'), host: flags.get('--host'), authority: flags.get('--authority'),
    config: flags.get('--config'), discoverConfig: false,
  })
  if (doctor) {
    const host = await loadWorkflowCliHost(options.hostModulePath)
    try {
      const identity = effectiveIdentity(options, host)
      console.log(JSON.stringify({ database: options.databasePath, databaseSource: options.databaseSource, profile,
        authorityRef: identity.authorityRef, authoritySource: identity.authoritySource,
        ...(options.hostModulePath === undefined ? {} : { hostModule: options.hostModulePath }),
        ...(options.configPath === undefined ? {} : { config: options.configPath }),
      }))
    } finally { await host.dispose?.() }
    return
  }
  const application = await createWorkflowCliApplication(options)
  try {
    const { authorityRef, authority } = effectiveIdentity(options, application.host)
    const server = await serveWorkflowMcpStdio(createMcpGateway(application.runtime, { profile }), {
      context: ({ signal }) => ({ authorityRef, authority, signal }),
    })
    server.onclose = () => { void application.close() }
  } catch (error: unknown) {
    await application.close()
    throw error
  }
}

function effectiveIdentity(options: ResolvedWorkflowCliOptions, host: WorkflowCliHost) {
  const sharedProject = options.configSource === 'explicit'
  return {
    authorityRef: options.authorityRef ?? host.authorityRef ?? (sharedProject ? 'cli:local' : 'mcp:local'),
    authority: host.authority ?? { type: sharedProject ? 'cli-local' : 'mcp-local' },
    authoritySource: options.authoritySource ?? (host.authorityRef === undefined ? 'default' : 'host'),
  }
}

function parseArgs(argv: readonly string[]): { readonly flags: ReadonlyMap<string, string>; readonly doctor: boolean } {
  const flags = new Map<string, string>()
  const valueFlags = new Set(['--config', '--db', '--host', '--authority', '--profile'])
  let doctor = false
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!
    if (flag === '--doctor' && !doctor) { doctor = true; continue }
    if (!valueFlags.has(flag) || flags.has(flag)) throw new Error(`Unknown or repeated MCP option: ${flag}`)
    const value = argv[++index]
    if (value === undefined || value.length === 0 || value.startsWith('--')) throw new Error(`${flag} requires a value`)
    flags.set(flag, value)
  }
  return { flags, doctor }
}

function mcpProfile(value: string): WorkflowMcpProfile {
  if (value === 'invoke' || value === 'author') return value
  throw new Error('--profile must be invoke or author')
}
