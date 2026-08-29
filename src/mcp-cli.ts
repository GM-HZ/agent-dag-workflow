#!/usr/bin/env node
import { resolve } from 'node:path'
import { createWorkflowCliApplication } from './adapters/cli/application.js'
import { createMcpGateway, serveWorkflowMcpStdio, type WorkflowMcpProfile } from './adapters/mcp/index.js'

const args = process.argv.slice(2)
const databasePath = resolve(option(args, '--db') ?? '.agent-dag-workflow.db')
const hostModule = option(args, '--host')
const profile = mcpProfile(option(args, '--profile') ?? 'invoke')
const application = await createWorkflowCliApplication({ databasePath, ...(hostModule === undefined ? {} : { hostModulePath: resolve(hostModule) }) })
const authorityRef = option(args, '--authority') ?? application.host.authorityRef ?? 'mcp:local'
const authority = application.host.authority ?? { type: 'mcp-local' }

try {
  const server = await serveWorkflowMcpStdio(createMcpGateway(application.runtime, { profile }), {
    context: ({ signal }) => ({ authorityRef, authority, signal }),
  })
  server.onclose = () => { void application.close() }
} catch (error: unknown) {
  await application.close()
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}

function option(values: readonly string[], name: string): string | undefined {
  const index = values.indexOf(name)
  if (index < 0) return undefined
  const value = values[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function mcpProfile(value: string): WorkflowMcpProfile {
  if (value === 'invoke' || value === 'author') return value
  throw new Error('--profile must be invoke or author')
}
