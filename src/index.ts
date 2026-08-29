export * from './core/index.js'
export * from './catalog/index.js'
export * from './runtime/index.js'
export * from './access/index.js'
export * from './journal/index.js'
export * from './triggers/core/index.js'
export * from './migrations/index.js'

export { SqliteWorkflowCatalogRepository } from './storage/sqlite/catalog-repository.js'
export type { SqliteWorkflowCatalogOptions } from './storage/sqlite/catalog-repository.js'
export { SQLITE_APPLICATION_ID, SQLITE_SCHEMA_VERSION } from './storage/sqlite/database.js'
export { SqliteWorkflowRunStore } from './storage/sqlite/run-store.js'
export { SqliteWorkflowRunCoordinator } from './storage/sqlite/run-coordinator.js'
export type { SqliteWorkflowRunCoordinatorOptions } from './storage/sqlite/run-coordinator.js'
export type { SqliteWorkflowRunStoreOptions } from './storage/sqlite/run-store.js'
export { SqliteWorkflowArtifactStore } from './storage/sqlite/artifact-store.js'
export type { SqliteWorkflowArtifactStoreOptions } from './storage/sqlite/artifact-store.js'
export { SqliteWorkflowIngressStore } from './storage/sqlite/ingress-store.js'
export type { SqliteWorkflowIngressStoreOptions } from './storage/sqlite/ingress-store.js'
export { SqliteWorkflowDeliveryStore } from './storage/sqlite/delivery-store.js'
export type { SqliteWorkflowDeliveryStoreOptions } from './storage/sqlite/delivery-store.js'
export { SqliteWorkflowBindingRepository } from './storage/sqlite/binding-repository.js'
export type { SqliteWorkflowBindingRepositoryOptions } from './storage/sqlite/binding-repository.js'

/**
 * DSH treats the package named by the bundle patch as the owner of both the
 * host plugin and its browser client. Keep that name at the package root so
 * the client scanner can resolve this package's `dsh.client` declaration.
 *
 * The adapter is imported only when DSH calls `apply`: ordinary SDK users do
 * not need Cordis or any other DSH peer merely to import the workflow core.
 */
export const name = 'gm-hz-agent-dag-workflow'
export const inject = ['tools', 'subagents', 'approval', 'skills']

export interface DshBundleConfig {
  /** SQLite file path. The DSH bundle patch supplies a durable path under DSH_HOME. */
  readonly databasePath?: string
}

export async function apply(ctx: unknown, config: DshBundleConfig = {}): Promise<void> {
  const adapter = await import('./adapters/dsh/bundle.js')
  await adapter.apply(ctx as Parameters<typeof adapter.apply>[0], config)
}
