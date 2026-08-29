import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import * as WorkflowCanvas from '../../canvas/index.js'
import {
  SqliteWorkflowBindingsService,
  SqliteWorkflowDeliveryRecordsService,
  SqliteWorkflowIngressRecordsService,
  SqliteWorkflowRunsService,
  SqliteWorkflowTemplatesService,
} from './sqlite-services.js'
import * as DshWorkflow from './index.js'
import {
  WorkflowCapabilityRegistryService,
  WorkflowNodeRegistryService,
  WorkflowScriptRuntimeRegistryService,
  WorkflowTriggerRegistryService,
} from './services.js'

export interface Config {
  /** SQLite file path. The DSH bundle patch supplies a durable path under DSH_HOME. */
  readonly databasePath?: string
}

export const name = 'gm-hz-agent-dag-workflow'
export const inject = ['tools', 'subagents', 'approval', 'skills']

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const path = config.databasePath ?? ':memory:'
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('agent-dag-workflow databasePath must be a non-empty string')
  }
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })

  if (ctx.get('workflowScripts') === undefined) await ctx.plugin(WorkflowScriptRuntimeRegistryService)
  if (ctx.get('workflowCapabilities') === undefined) await ctx.plugin(WorkflowCapabilityRegistryService)
  if (ctx.get('workflowNodes') === undefined) await ctx.plugin(WorkflowNodeRegistryService)
  if (ctx.get('workflowTriggers') === undefined) await ctx.plugin(WorkflowTriggerRegistryService)
  if (ctx.get('workflowTemplates') === undefined) await ctx.plugin(SqliteWorkflowTemplatesService, { path })
  if (ctx.get('workflowRuns') === undefined) await ctx.plugin(SqliteWorkflowRunsService, { path })
  if (ctx.get('workflowBindings') === undefined) await ctx.plugin(SqliteWorkflowBindingsService, { path })
  if (ctx.get('workflowIngress') === undefined) await ctx.plugin(SqliteWorkflowIngressRecordsService, { path })
  if (ctx.get('workflowDelivery') === undefined) await ctx.plugin(SqliteWorkflowDeliveryRecordsService, { path })

  await ctx.plugin(DshWorkflow, { catalog: 'external', runStore: 'external' })
  const bindings = ctx.get('workflowBindings')
  const ingress = ctx.get('workflowIngress')
  const delivery = ctx.get('workflowDelivery')
  if (bindings === undefined || ingress === undefined || delivery === undefined) {
    throw new Error('agent-dag-workflow operational services failed to mount')
  }
  if (ctx.get('workflowCanvas') === undefined) await ctx.plugin(WorkflowCanvas, { bindings, ingress, delivery })
}

export type * from './types.js'
