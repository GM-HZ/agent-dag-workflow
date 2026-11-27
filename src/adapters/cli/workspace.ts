import { existsSync } from 'node:fs'
import { mkdir, readFile, rmdir, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { WorkflowAccessError } from '../../access/index.js'
import { readBundledOrdersExample } from '../../examples/orders.js'
import { writeWorkflowLines } from './files.js'

export { readBundledOrdersExample } from '../../examples/orders.js'

const CONFIG_FILENAME = '.agent-dag-workflow.json'
const DATABASE_FILENAME = '.agent-dag-workflow.db'

interface WorkflowCliConfig {
  readonly schemaVersion: 1
  readonly database?: string
  readonly hostModule?: string
  readonly authorityRef?: string
}

export interface ResolvedWorkflowCliOptions {
  readonly databasePath: string
  readonly databaseSource: 'flag' | 'config' | 'working-directory'
  readonly hostModulePath?: string
  readonly hostRequiresExplicitSelection: boolean
  readonly authorityRef?: string
  readonly authoritySource?: 'flag' | 'config'
  readonly configPath?: string
  readonly configSource?: 'explicit' | 'discovered'
}

export async function resolveWorkflowCliOptions(flags: {
  readonly config?: string | undefined
  readonly database?: string | undefined
  readonly host?: string | undefined
  readonly authority?: string | undefined
  readonly discoverConfig?: boolean
}, cwd = process.cwd()): Promise<ResolvedWorkflowCliOptions> {
  const configPath = flags.config === undefined
    ? flags.discoverConfig !== false && flags.database === undefined ? findProjectConfig(cwd) : undefined
    : resolve(cwd, flags.config)
  const config = configPath === undefined ? undefined : await readConfig(configPath)
  const configBase = configPath === undefined ? cwd : dirname(configPath)
  // Explicit --config keeps the established meaning of relative overrides.
  const flagBase = flags.config === undefined ? cwd : configBase
  const hostModulePath = flags.host !== undefined ? resolve(flagBase, flags.host)
    : config?.hostModule === undefined ? undefined : resolve(configBase, config.hostModule)
  const authorityRef = flags.authority ?? config?.authorityRef
  return {
    databasePath: flags.database === undefined ? resolve(configBase, config?.database ?? DATABASE_FILENAME) : resolve(flagBase, flags.database),
    databaseSource: flags.database !== undefined ? 'flag' : configPath === undefined ? 'working-directory' : 'config',
    ...(hostModulePath === undefined ? {} : { hostModulePath }),
    hostRequiresExplicitSelection: flags.config === undefined && flags.host === undefined && hostModulePath !== undefined,
    ...(authorityRef === undefined ? {} : { authorityRef, authoritySource: flags.authority === undefined ? 'config' : 'flag' }),
    ...(configPath === undefined ? {} : { configPath, configSource: flags.config === undefined ? 'discovered' : 'explicit' }),
  }
}

function findProjectConfig(cwd: string): string | undefined {
  let directory = resolve(cwd)
  const currentDatabase = join(directory, DATABASE_FILENAME)
  for (;;) {
    const candidate = join(directory, CONFIG_FILENAME)
    if (existsSync(candidate)) return candidate
    // Preserve an existing standalone catalog in the directory of invocation.
    if (existsSync(currentDatabase) || existsSync(join(directory, '.git'))) return undefined
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

async function readConfig(path: string): Promise<WorkflowCliConfig> {
  let value: unknown
  try { value = JSON.parse(await readFile(path, 'utf8')) }
  catch (error: unknown) { invalid(`Could not read CLI config ${path}: ${error instanceof Error ? error.message : String(error)}`) }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(`CLI config ${path} must be a JSON object`)
  const config = value as Record<string, unknown>
  if (config.schemaVersion !== 1) invalid(`CLI config ${path} schemaVersion must be 1`)
  for (const key of Object.keys(config)) {
    if (!['schemaVersion', 'database', 'hostModule', 'authorityRef'].includes(key)) invalid(`Unsupported field ${key} in CLI config ${path}`)
  }
  for (const key of ['database', 'hostModule', 'authorityRef']) {
    const entry = config[key]
    if (entry !== undefined && (typeof entry !== 'string' || entry.length === 0)) invalid(`CLI config ${path}: ${key} must be a non-empty string`)
  }
  return config as unknown as WorkflowCliConfig
}

export async function initWorkflowWorkspace(path: string) {
  const directory = resolve(path)
  const { template, inputSource } = await readBundledOrdersExample()
  const workflowId = 'orders'
  const files = {
    config: join(directory, CONFIG_FILENAME),
    template: join(directory, 'workflow.json'),
    inputs: join(directory, 'input.json'),
    database: join(directory, DATABASE_FILENAME),
  }
  try { await mkdir(directory) }
  catch (error: unknown) {
    if (isPathAlreadyPresent(error)) invalid(`Workspace path already exists: ${directory}. Choose a new directory.`)
    throw error
  }
  const written: string[] = []
  try {
    const contents = [
      [files.template, JSON.stringify({ ...template, metadata: { ...template.metadata, id: workflowId } }, null, 2)],
      [files.inputs, inputSource.trimEnd()],
      [files.config, JSON.stringify({ schemaVersion: 1, database: DATABASE_FILENAME }, null, 2)],
    ] as const
    for (const [target, content] of contents) {
      written.push(await writeWorkflowLines(target, emit => emit(content)))
    }
  } catch (error: unknown) {
    for (const target of written) await unlink(target).catch(() => {})
    await rmdir(directory).catch(() => {})
    throw error
  }
  return { directory, ...files, workflowId }
}

function isPathAlreadyPresent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

function invalid(message: string): never { throw new WorkflowAccessError('WORKFLOW_REQUEST_INVALID', message) }
