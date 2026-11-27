import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SQLITE_APPLICATION_ID, SQLITE_SCHEMA_VERSION } from '../../storage/sqlite/database.js'
import { writeWorkflowFileWith } from './files.js'

export function inspectWorkflowDatabase(path: string, verify = false) {
  const file = resolve(path)
  const bytes = statSync(file).size
  const walBytes = statSync(`${file}-wal`, { throwIfNoEntry: false })?.size ?? 0
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const applicationId = db.prepare('PRAGMA application_id').get()?.application_id
    const schemaVersion = db.prepare('PRAGMA user_version').get()?.user_version
    if (applicationId !== SQLITE_APPLICATION_ID || typeof schemaVersion !== 'number') throw new Error('file is not an Agent DAG Workflow database')
    let state: 'readable' | 'different-version' = 'different-version'
    if (schemaVersion === SQLITE_SCHEMA_VERSION || schemaVersion === 11) state = 'readable'
    if (verify) assertIntegrity(db)
    return { database: file, bytes, walBytes, totalBytes: bytes + walBytes, schemaVersion, currentSchemaVersion: SQLITE_SCHEMA_VERSION, state,
      ...(state === 'readable' ? {
        runs: count(db, 'SELECT count(*) AS count FROM workflow_runs'),
        journalEvents: count(db, 'SELECT count(*) AS count FROM workflow_run_events'),
        templates: count(db, 'SELECT count(*) AS count FROM workflow_drafts'),
        artifacts: count(db, 'SELECT count(*) AS count FROM workflow_artifacts'),
      } : {}),
      ...(verify ? { integrity: 'ok' } : {}),
    }
  } finally { db.close() }
}

export async function copyWorkflowDatabase(source: string, destination: string) {
  inspectWorkflowDatabase(source)
  const target = await writeWorkflowFileWith(destination, temporary => {
    const db = new DatabaseSync(resolve(source), { readOnly: true })
    try { db.prepare('VACUUM INTO ?').run(temporary) } finally { db.close() }
    inspectWorkflowDatabase(temporary, true)
  })
  return inspectWorkflowDatabase(target)
}

function assertIntegrity(db: DatabaseSync): void {
  const result = db.prepare('PRAGMA integrity_check').all()
  if (result.length !== 1 || result[0]?.integrity_check !== 'ok') throw new Error('SQLite integrity check failed')
  if (db.prepare('PRAGMA foreign_key_check').get() !== undefined) throw new Error('SQLite foreign key check failed')
}

function count(db: DatabaseSync, sql: string): number {
  const count = db.prepare(sql).get()?.count
  if (typeof count !== 'number') throw new Error('Unexpected SQLite row count')
  return count
}
