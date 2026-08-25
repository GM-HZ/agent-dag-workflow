import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import * as DagWorkflow from '@gm-hz/dsh-dag-workflow-host'
import {
  WorkflowNodeRegistryService,
  WorkflowCapabilityRegistryService,
  WorkflowScriptRuntimeRegistryService,
} from '@gm-hz/dsh-dag-workflow-host'
import {
  SqliteWorkflowRunsProvider,
  SqliteWorkflowTemplatesProvider,
} from '@gm-hz/dsh-dag-workflow-sqlite'

export interface Config {
  /** SQLite file path. The DSH bundle patch supplies a durable path under DSH_HOME. */
  readonly databasePath?: string
  /** Previous default used only to migrate existing installations to databasePath. */
  readonly legacyDatabasePath?: string
}

export const name = 'gm-hz-dsh-dag-workflow'
export const inject = ['tools', 'subagents', 'approval', 'skills']

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const path = config.databasePath ?? ':memory:'
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('dsh-dag-workflow databasePath must be a non-empty string')
  }
  await migrateLegacyDatabase(config.legacyDatabasePath, path)
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })

  if (ctx.get('workflowScripts') === undefined) await ctx.plugin(WorkflowScriptRuntimeRegistryService)
  if (ctx.get('workflowCapabilities') === undefined) await ctx.plugin(WorkflowCapabilityRegistryService)
  if (ctx.get('workflowNodes') === undefined) await ctx.plugin(WorkflowNodeRegistryService)
  if (ctx.get('workflowTemplates') === undefined) {
    await ctx.plugin(SqliteWorkflowTemplatesProvider, { path })
  }
  if (ctx.get('workflowRuns') === undefined) {
    await ctx.plugin(SqliteWorkflowRunsProvider, { path })
  }
  await ctx.plugin(DagWorkflow, {
    catalog: 'external',
    runStore: 'external',
  })
}

async function migrateLegacyDatabase(legacyPath: string | undefined, targetPath: string): Promise<void> {
  if (legacyPath === undefined || targetPath === ':memory:' || legacyPath === targetPath) return
  if (typeof legacyPath !== 'string' || legacyPath.length === 0) {
    throw new Error('dsh-dag-workflow legacyDatabasePath must be a non-empty string')
  }
  if (existsSync(targetPath) || !existsSync(legacyPath)) return
  mkdirSync(dirname(targetPath), { recursive: true })
  const temporaryPath = `${targetPath}.migration-${process.pid}`
  rmSync(temporaryPath, { force: true })
  try {
    const source = new DatabaseSync(legacyPath, { readOnly: true })
    try {
      await backup(source, temporaryPath)
    } finally {
      source.close()
    }
    renameSync(temporaryPath, targetPath)
  } catch (error: unknown) {
    rmSync(temporaryPath, { force: true })
    throw error
  }
}

export type * from '@gm-hz/dsh-dag-workflow-host'
