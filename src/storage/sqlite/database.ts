import { DatabaseSync } from 'node:sqlite'

export const SQLITE_SCHEMA_VERSION = 11
export const SQLITE_APPLICATION_ID = 1_146_308_695

export interface SqliteWorkflowOptions {
  readonly path: string
  readonly busyTimeoutMs?: number
}

export function openWorkflowDatabase(options: SqliteWorkflowOptions): DatabaseSync {
  if (typeof options.path !== 'string' || options.path.length === 0) throw new Error('SQLite path must be a non-empty string')
  const timeout = options.busyTimeoutMs ?? 5_000
  if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 2_147_483_647) throw new Error('busyTimeoutMs must be a non-negative SQLite millisecond integer')
  const db = new DatabaseSync(options.path, { timeout })
  try {
    db.exec('PRAGMA trusted_schema = OFF; PRAGMA foreign_keys = ON; PRAGMA mmap_size = 0; PRAGMA synchronous = FULL;')
    db.exec(`PRAGMA busy_timeout = ${timeout}`)
    if (options.path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;')
    transaction(db, () => initializeOrValidate(db))
    return db
  } catch (error: unknown) {
    db.close()
    throw error
  }
}

export function transaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    db.exec('COMMIT')
    return result
  } catch (error: unknown) {
    try { db.exec('ROLLBACK') } catch { /* retain original failure */ }
    throw error
  }
}

function initializeOrValidate(db: DatabaseSync): void {
  const version = pragmaInteger(db, 'user_version')
  const applicationId = pragmaInteger(db, 'application_id')
  const objectCount = scalarInteger(db, `SELECT COUNT(*) AS value FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'`)
  if (version === 0 && applicationId === 0 && objectCount === 0) {
    createCatalogTables(db)
    createRunTables(db)
    createArtifactTables(db)
    createIngressTables(db)
    createRunQueueTables(db)
    createDeliveryTables(db)
    createBindingTables(db)
    db.exec(`PRAGMA application_id = ${SQLITE_APPLICATION_ID}; PRAGMA user_version = ${SQLITE_SCHEMA_VERSION};`)
  } else if (version !== SQLITE_SCHEMA_VERSION || applicationId !== SQLITE_APPLICATION_ID) {
    throw new Error(`workflow database has version/application ${version}/${applicationId}; expected ${SQLITE_SCHEMA_VERSION}/${SQLITE_APPLICATION_ID}`)
  }
  const names = tableNames(db)
  if (names.join(',') !== 'workflow_artifacts,workflow_bindings,workflow_delivery,workflow_drafts,workflow_ingress,workflow_revisions,workflow_run_events,workflow_run_queue,workflow_runs') {
    throw new Error('workflow database required schema objects do not match this build')
  }
}

function createBindingTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE workflow_bindings (
      id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      binding_json TEXT NOT NULL,
      published_at INTEGER NOT NULL,
      PRIMARY KEY (id, revision)
    ) STRICT;
  `)
}

function createDeliveryTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE workflow_delivery (
      invocation_id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'unknown')),
      attempts INTEGER NOT NULL CHECK (attempts >= 1),
      record_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
  `)
}

function createRunQueueTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE workflow_run_queue (
      run_id TEXT PRIMARY KEY,
      enqueued_at INTEGER NOT NULL,
      worker_id TEXT,
      lease_token TEXT,
      lease_expires_at INTEGER,
      CHECK ((worker_id IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
        OR (worker_id IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
    ) STRICT;
  `)
}

function createIngressTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE workflow_ingress (
      trigger_id TEXT PRIMARY KEY,
      dedupe_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('received', 'rejected', 'launched')),
      record_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
  `)
}

function createArtifactTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE workflow_artifacts (
      digest TEXT PRIMARY KEY CHECK (length(digest) = 64),
      size INTEGER NOT NULL CHECK (size >= 0),
      media_type TEXT NOT NULL,
      redacted INTEGER NOT NULL CHECK (redacted IN (0, 1)),
      content BLOB NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;
  `)
}

function createCatalogTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE workflow_drafts (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      template_json TEXT NOT NULL,
      content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
      semantic_hash TEXT NOT NULL CHECK (length(semantic_hash) = 64),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE workflow_revisions (
      id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      source_draft_revision INTEGER NOT NULL CHECK (source_draft_revision >= 1),
      template_json TEXT NOT NULL,
      content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
      semantic_hash TEXT NOT NULL CHECK (length(semantic_hash) = 64),
      published_at INTEGER NOT NULL,
      PRIMARY KEY (id, revision)
    ) STRICT;
  `)
}

function createRunTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE workflow_runs (
      run_id TEXT PRIMARY KEY,
      template_json TEXT NOT NULL,
      semantic_hash TEXT NOT NULL CHECK (length(semantic_hash) = 64),
      plan_json TEXT NOT NULL,
      inputs_json TEXT NOT NULL,
      execution_json TEXT NOT NULL,
      launch_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      checkpoint_json TEXT NOT NULL,
      checkpoint_seq INTEGER NOT NULL CHECK (checkpoint_seq >= 0),
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled', 'paused')),
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE workflow_run_events (
      run_id TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
      seq INTEGER NOT NULL CHECK (seq >= 1),
      event_json TEXT NOT NULL,
      PRIMARY KEY (run_id, seq)
    ) STRICT;
  `)
}

function tableNames(db: DatabaseSync): string[] {
  return db.prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all()
    .map(row => {
      const name = (row as Record<string, unknown>).name
      if (typeof name !== 'string') throw new Error('SQLite schema name is not text')
      return name
    })
}

function pragmaInteger(db: DatabaseSync, name: 'user_version' | 'application_id'): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined
  const value = row?.[name]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`SQLite PRAGMA ${name} is not an integer`)
  return value
}

function scalarInteger(db: DatabaseSync, sql: string): number {
  const value = (db.prepare(sql).get() as Record<string, unknown> | undefined)?.value
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('SQLite scalar is not an integer')
  return value
}
