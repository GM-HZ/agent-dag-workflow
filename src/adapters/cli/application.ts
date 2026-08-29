import { pathToFileURL } from 'node:url'
import { WorkflowAgentAccess } from '../../access/index.js'
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
  const loaded = await import(pathToFileURL(path).href)
  const host = (loaded.default ?? loaded.host) as WorkflowCliHost | undefined
  if (host === undefined || host === null || typeof host !== 'object') throw new Error('CLI host module must export default or host object')
  return host
}
