import { pathToFileURL } from 'node:url'
import { WorkflowAccessError, WorkflowAgentAccess } from '../../access/index.js'
import { WorkflowTemplateCatalog } from '../../catalog/index.js'
import { WorkflowNodeRegistry, registerCoreNodes, type WorkflowEngineServices } from '../../core/index.js'
import { WorkflowRuntime, type WorkflowRuntimeOptions } from '../../runtime/index.js'
import {
  SqliteWorkflowArtifactStore,
  SqliteWorkflowCatalogRepository,
  SqliteWorkflowRunCoordinator,
  SqliteWorkflowRunStore,
} from '../../storage/sqlite/index.js'

export interface WorkflowCliHost {
  readonly authorityRef?: string
  readonly authority?: unknown
  readonly services?: WorkflowEngineServices
  readonly authorityResolver?: WorkflowRuntimeOptions['authorityResolver']
  registerNodes?(registry: WorkflowNodeRegistry): void | Promise<void>
  dispose?(): void | Promise<void>
}

export interface WorkflowCliApplication {
  readonly runtime: WorkflowRuntime
  readonly access: WorkflowAgentAccess
  readonly coordinator: SqliteWorkflowRunCoordinator
  readonly host: WorkflowCliHost
  close(): Promise<void>
}

/** Type-safe identity helper; it never wraps or intercepts Host gateway calls. */
export function defineWorkflowCliHost<const Host extends WorkflowCliHost>(host: Host): Host {
  return host
}

export async function createWorkflowCliApplication(options: {
  readonly databasePath: string
  readonly hostModulePath?: string
}): Promise<WorkflowCliApplication> {
  const host = await loadWorkflowCliHost(options.hostModulePath)
  const nodes = new WorkflowNodeRegistry()
  registerCoreNodes(nodes)
  await host.registerNodes?.(nodes)
  const catalogRepository = new SqliteWorkflowCatalogRepository({ path: options.databasePath })
  const runStore = new SqliteWorkflowRunStore({ path: options.databasePath })
  const artifactStore = new SqliteWorkflowArtifactStore({ path: options.databasePath })
  const coordinator = new SqliteWorkflowRunCoordinator({ path: options.databasePath })
  const catalog = new WorkflowTemplateCatalog(catalogRepository, nodes)
  const runtime = new WorkflowRuntime({
    nodes,
    catalog,
    runStore,
    artifactStore,
    queue: coordinator,
    capturePolicy: { mode: 'standard', maxArtifactBytes: 1024 * 1024 },
    ...(host.services === undefined ? {} : { services: host.services }),
    ...(host.authorityResolver === undefined ? {} : { authorityResolver: host.authorityResolver }),
  })
  let closed = false
  return {
    runtime,
    access: new WorkflowAgentAccess(runtime),
    coordinator,
    host,
    async close() {
      if (closed) return
      closed = true
      coordinator.close()
      artifactStore.close()
      runStore.close()
      catalogRepository.close()
      await host.dispose?.()
    },
  }
}

export async function loadWorkflowCliHost(path: string | undefined): Promise<WorkflowCliHost> {
  if (path === undefined) return {}
  let loaded: Record<string, unknown>
  try { loaded = await import(pathToFileURL(path).href) as Record<string, unknown> }
  catch (error: unknown) {
    throw new WorkflowAccessError('WORKFLOW_HOST_LOAD_FAILED', `failed to load CLI Host module: ${path}`, {
      details: { hostModulePath: path }, cause: error,
    })
  }
  return validateWorkflowCliHost(loaded.default ?? loaded.host, path)
}

export function validateWorkflowCliHost(value: unknown, source = 'CLI Host module'): WorkflowCliHost {
  if (!isRecord(value)) hostInvalid(source, 'must export a Host object as default or named "host"')
  const host = value as Record<string, unknown>
  if (host.authorityRef !== undefined && (typeof host.authorityRef !== 'string' || host.authorityRef.length === 0 || host.authorityRef.length > 1024)) {
    hostInvalid(source, 'authorityRef must be a non-empty string of at most 1024 characters')
  }
  optionalFunction(host, 'registerNodes', source)
  optionalFunction(host, 'dispose', source)
  optionalMethodObject(host, 'authorityResolver', ['resolve'], source)
  if (host.services !== undefined) {
    if (!isRecord(host.services)) hostInvalid(source, 'services must be an object')
    const services = host.services as Record<string, unknown>
    optionalMethodObject(services, 'tools', ['execute'], source, ['list'])
    optionalMethodObject(services, 'agents', ['execute'], source)
    optionalMethodObject(services, 'approvals', ['request'], source)
    optionalMethodObject(services, 'subworkflows', ['execute'], source)
    optionalMethodObject(services, 'capabilities', ['resolve'], source)
  }
  return value as WorkflowCliHost
}

function optionalFunction(host: Record<string, unknown>, key: string, source: string): void {
  if (host[key] !== undefined && typeof host[key] !== 'function') hostInvalid(source, `${key} must be a function`)
}

function optionalMethodObject(
  host: Record<string, unknown>, key: string, requiredMethods: readonly string[], source: string, optionalMethods: readonly string[] = [],
): void {
  const value = host[key]
  if (value === undefined) return
  if (!isRecord(value)) hostInvalid(source, `${key} must be an object`)
  const gateway = value as Record<string, unknown>
  for (const method of requiredMethods) if (typeof gateway[method] !== 'function') hostInvalid(source, `${key}.${method} must be a function`)
  for (const method of optionalMethods) if (gateway[method] !== undefined && typeof gateway[method] !== 'function') hostInvalid(source, `${key}.${method} must be a function when supplied`)
}

function hostInvalid(source: string, message: string): never {
  throw new WorkflowAccessError('WORKFLOW_HOST_INVALID', `${source}: ${message}`, { details: { source } })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
