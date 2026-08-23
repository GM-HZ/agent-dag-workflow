import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import * as DagWorkflow from '@gm-hz/dsh-workflow-dsh'
import {
  WorkflowNodeRegistryService,
} from '@gm-hz/dsh-workflow-dsh'
import {
  SqliteWorkflowRunsProvider,
  SqliteWorkflowTemplatesProvider,
} from '@gm-hz/dsh-workflow-sqlite'

export interface Config {
  /** SQLite file path. The DSH bundle patch supplies a durable path under DSH_HOME. */
  readonly databasePath?: string
  /** Mirror compact run/node events into the owning DSH Session. */
  readonly recordSessionEvents?: boolean
}

export const name = 'gm-hz-dsh-dag-workflow'
export const inject = ['tools', 'subagents', 'approval', 'skills']

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const path = config.databasePath ?? ':memory:'
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('dsh-dag-workflow databasePath must be a non-empty string')
  }
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })

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
    ...(config.recordSessionEvents === undefined ? {} : { recordSessionEvents: config.recordSessionEvents }),
  })
}

export type * from '@gm-hz/dsh-workflow-dsh'
