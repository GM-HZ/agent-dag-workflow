import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { WorkflowTemplateCatalog } from '../../catalog/index.js'
import { WorkflowNodeRegistry, parseWorkflowTemplate, registerCoreNodes, snapshotJsonObject, type WorkflowEngineServices } from '../../core/index.js'
import { migrateLegacyWorkflowTemplate } from '../../migrations/index.js'
import { WorkflowRuntime, type WorkflowRuntimeOptions } from '../../runtime/index.js'
import { SqliteWorkflowArtifactStore, SqliteWorkflowCatalogRepository, SqliteWorkflowRunStore } from '../../storage/sqlite/index.js'

export interface WorkflowCliHost {
  readonly authorityRef?: string
  readonly authority?: unknown
  readonly services?: WorkflowEngineServices
  readonly authorityResolver?: WorkflowRuntimeOptions['authorityResolver']
  registerNodes?(registry: WorkflowNodeRegistry): void | Promise<void>
}

export async function runWorkflowCli(argv = process.argv.slice(2), output: (line: string) => void = console.log): Promise<number> {
  const command = argv[0]
  const args = argv.slice(1)
  const databasePath = option(args, '--db') ?? resolve('.agent-dag-workflow.db')
  const host = await loadHost(option(args, '--host'))
  const nodes = new WorkflowNodeRegistry()
  registerCoreNodes(nodes)
  await host.registerNodes?.(nodes)
  const catalogRepository = new SqliteWorkflowCatalogRepository({ path: databasePath })
  const runStore = new SqliteWorkflowRunStore({ path: databasePath })
  const artifactStore = new SqliteWorkflowArtifactStore({ path: databasePath })
  const catalog = new WorkflowTemplateCatalog(catalogRepository, nodes)
  const runtime = new WorkflowRuntime({
    nodes,
    catalog,
    runStore,
    artifactStore,
    capturePolicy: { mode: 'standard', maxArtifactBytes: 1024 * 1024 },
    ...(host.services === undefined ? {} : { services: host.services }),
    ...(host.authorityResolver === undefined ? {} : { authorityResolver: host.authorityResolver }),
  })
  try {
    if (command === 'validate' && positional(args, 0) !== undefined) {
      output(JSON.stringify({ diagnostics: await runtime.validate(await readTemplate(positional(args, 0)!)) }, null, 2))
      return 0
    }
    if (command === 'draft-create' && positional(args, 0) !== undefined) {
      output(JSON.stringify(await runtime.createDraft(await readTemplate(positional(args, 0)!)), null, 2))
      return 0
    }
    if (command === 'publish' && positional(args, 0) !== undefined) {
      output(JSON.stringify(await runtime.publish(positional(args, 0)!, integerOption(args, '--expected')), null, 2))
      return 0
    }
    if (command === 'run') {
      const published = option(args, '--published')
      const file = positional(args, 0)
      if (published === undefined && file === undefined) return usage(output)
      const inputPath = option(args, '--input')
      const inputs = inputPath === undefined ? {} : snapshotJsonObject(JSON.parse(await readFile(resolve(inputPath), 'utf8')))
      const idempotencyKey = option(args, '--idempotency-key')
      const handle = await runtime.launch({
        target: published === undefined ? { type: 'inline', template: await readTemplate(file!) } : publishedTarget(published),
        inputs,
        authorityRef: option(args, '--authority') ?? host.authorityRef ?? 'cli:local',
        ...(host.authority === undefined ? { authority: { type: 'cli-local' } } : { authority: host.authority }),
        origin: { type: 'cli' },
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      })
      const result = await handle.result
      output(JSON.stringify(result, null, 2))
      return result.status === 'completed' ? 0 : 1
    }
    if (command === 'trace' && positional(args, 0) !== undefined) {
      const runId = positional(args, 0)!
      let afterSeq = optionalInteger(args, '--after') ?? 0
      const limit = optionalInteger(args, '--limit') ?? 100
      const follow = args.includes('--follow')
      for (;;) {
        const page = await runtime.readEvents(runId, { afterSeq, limit })
        for (const event of page.events) { output(JSON.stringify(event)); afterSeq = event.seq }
        const run = await runtime.getRun(runId)
        if (!follow || run === undefined || terminal(run.status)) return run === undefined ? 1 : 0
        await new Promise(resolveWait => setTimeout(resolveWait, 250))
      }
    }
    if (command === 'replay' && positional(args, 0) !== undefined) {
      const handle = await runtime.replay({
        runId: positional(args, 0)!,
        mode: replayMode(option(args, '--mode') ?? 'inspect'),
        authorityRef: option(args, '--authority') ?? host.authorityRef ?? 'cli:local',
        ...(host.authority === undefined ? { authority: { type: 'cli-local' } } : { authority: host.authority }),
      })
      const result = await handle.result
      output(JSON.stringify(result, null, 2))
      return result.status === 'completed' ? 0 : 1
    }
    if (command === 'resume' && positional(args, 0) !== undefined) {
      const handle = await runtime.resume({
        runId: positional(args, 0)!,
        authorityRef: option(args, '--authority') ?? host.authorityRef ?? 'cli:local',
        ...(host.authority === undefined ? { authority: { type: 'cli-local' } } : { authority: host.authority }),
      })
      const result = await handle.result
      output(JSON.stringify(result, null, 2))
      return result.status === 'completed' ? 0 : 1
    }
    if (command === 'migrate-template' && positional(args, 0) !== undefined) {
      const target = option(args, '--output')
      if (target === undefined) throw new Error('migrate-template requires --output')
      const legacy = snapshotJsonObject(JSON.parse(await readFile(resolve(positional(args, 0)!), 'utf8')))
      const migrated = migrateLegacyWorkflowTemplate(legacy)
      await writeFile(resolve(target), `${JSON.stringify(migrated, null, 2)}\n`, 'utf8')
      output(JSON.stringify({ output: resolve(target), apiVersion: migrated.apiVersion }))
      return 0
    }
    return usage(output)
  } catch (error: unknown) {
    output(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    return 1
  } finally {
    artifactStore.close()
    runStore.close()
    catalogRepository.close()
  }
}

async function readTemplate(path: string) { return parseWorkflowTemplate(await readFile(resolve(path), 'utf8')) }
function option(args: readonly string[], name: string): string | undefined { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
function positional(args: readonly string[], index: number): string | undefined {
  const values: string[] = []
  for (let offset = 0; offset < args.length; offset++) {
    if (args[offset]!.startsWith('--')) { if (args[offset] !== '--follow') offset++; continue }
    values.push(args[offset]!)
  }
  return values[index]
}
function optionalInteger(args: readonly string[], name: string): number | undefined { const value = option(args, name); if (value === undefined) return undefined; const parsed = Number(value); if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be an integer`); return parsed }
function integerOption(args: readonly string[], name: string): number { const value = optionalInteger(args, name); if (value === undefined) throw new Error(`${name} is required`); return value }
function publishedTarget(value: string): { readonly type: 'published'; readonly id: string; readonly revision: number } { const match = /^(?<id>[a-z][a-z0-9-]*)@(?<revision>[1-9][0-9]*)$/.exec(value); if (match?.groups === undefined) throw new Error('--published must be id@revision'); return { type: 'published', id: match.groups.id!, revision: Number(match.groups.revision) } }
function replayMode(value: string): 'inspect' | 'recorded' | 'live' { if (value === 'inspect' || value === 'recorded' || value === 'live') return value; throw new Error('--mode must be inspect, recorded, or live') }
function terminal(status: string): boolean { return status === 'completed' || status === 'failed' || status === 'cancelled' }
function usage(output: (line: string) => void): 2 { output('Usage: agent-workflow validate|draft-create|publish|run|trace|replay|resume|migrate-template ... [--db path] [--host module.mjs]'); return 2 }
async function loadHost(path: string | undefined): Promise<WorkflowCliHost> {
  if (path === undefined) return {}
  const loaded = await import(pathToFileURL(resolve(path)).href)
  const host = (loaded.default ?? loaded.host) as WorkflowCliHost | undefined
  if (host === undefined || host === null || typeof host !== 'object') throw new Error('CLI host module must export default or host object')
  return host
}
