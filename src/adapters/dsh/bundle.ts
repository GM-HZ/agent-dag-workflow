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
export const inject = ['tools', 'subagents', 'approval', 'skills', 'agents']

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

  const agents = ctx.get('agents') as { get(id: string): unknown } | undefined
  if (agents === undefined || typeof agents.get !== 'function') {
    throw new Error('agent-dag-workflow durable bundle requires the DSH agents service for restart recovery')
  }
  await ctx.plugin(DshWorkflow, {
    catalog: 'external',
    runStore: 'external',
    recovery: {
      reference: stableDshAuthorityReference,
      resolve: async authorityRef => {
        const sessionId = parseDshAuthorityReference(authorityRef)
        if (sessionId === undefined) return undefined
        const agent = agents.get(sessionId)
        return isDshAgent(agent) ? agent : undefined
      },
    },
  })
  const bindings = ctx.get('workflowBindings')
  const ingress = ctx.get('workflowIngress')
  const delivery = ctx.get('workflowDelivery')
  if (bindings === undefined || ingress === undefined || delivery === undefined) {
    throw new Error('agent-dag-workflow operational services failed to mount')
  }
  if (ctx.get('workflowCanvas') === undefined) await ctx.plugin(WorkflowCanvas, { bindings, ingress, delivery })
}

const DSH_AUTHORITY_PREFIX = 'dsh-session:'

function stableDshAuthorityReference(agent: DshWorkflow.DshAgentLike): string {
  const sessionId = agent.session.id
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 512) {
    throw new Error('agent-dag-workflow durable runs require a DSH Session with a stable 1-512 character id')
  }
  return `${DSH_AUTHORITY_PREFIX}${sessionId}`
}

function parseDshAuthorityReference(authorityRef: string): string | undefined {
  if (!authorityRef.startsWith(DSH_AUTHORITY_PREFIX)) return undefined
  const sessionId = authorityRef.slice(DSH_AUTHORITY_PREFIX.length)
  return sessionId.length > 0 && sessionId.length <= 512 ? sessionId : undefined
}

function isDshAgent(value: unknown): value is DshWorkflow.DshAgentLike {
  if (value === null || typeof value !== 'object' || !('session' in value)) return false
  const session = value.session
  return session !== null && typeof session === 'object' && 'append' in session && typeof session.append === 'function'
}

export type * from './types.js'
