import type { Context } from '@deepseek-ai/cordis'
import type { CanvasScheduleRunReceipt, CanvasScheduleSummary, WorkflowCanvasPrincipal, WorkflowCanvasScheduleHost } from '../../canvas/types.js'
import { WorkflowExecutionError } from '../../core/index.js'
import { mapInputs } from '../../triggers/core/index.js'
import { createCronTrigger, describeWorkflowCronSchedule, type WorkflowCronSnapshot, type WorkflowCronStore } from '../../triggers/cron/index.js'
import { cronMinute, readCronBindingOptions } from '../../triggers/cron/trigger.js'

export function createDshCanvasSchedules(ctx: Context, store: WorkflowCronStore): WorkflowCanvasScheduleHost {
  const services = { engine: ctx.get('dagWorkflowEngine'), bindings: ctx.get('workflowBindings'), runs: ctx.get('workflowRuns') }
  if (services.engine === undefined || services.bindings === undefined || services.runs === undefined) {
    throw new Error('workflow schedule services failed to mount')
  }
  const engine = services.engine
  const bindings = services.bindings
  const runs = services.runs

  async function ownLatest(id: string, revision: number, principal: WorkflowCanvasPrincipal) {
    const authorityRef = engine.authorityRefFor?.(principal.agent)
    const binding = await bindings.get(id)
    if (authorityRef === undefined || binding.spec.authorityRef !== authorityRef) throw new Error('workflow schedule access denied')
    if (binding.metadata.revision !== revision) throw new Error('workflow schedule revision changed; refresh before running it')
    if (binding.spec.trigger.uses !== 'cron@1') throw new Error('workflow binding is not a time schedule')
    return binding
  }

  return {
    async inspect(id, revision, principal) {
      const binding = await ownLatest(id, revision, principal)
      const state = await store.get(id)
      const snapshot = await describeWorkflowCronSchedule(binding, state?.bindingRevision === revision ? state : undefined, async runId => {
        if (!await engine.owns(runId, principal.agent)) return undefined
        const checkpoint = await runs.getCheckpoint(runId)
        if (checkpoint === undefined) return undefined
        return { runId, status: checkpoint.status, updatedAt: checkpoint.updatedAt,
          ...(checkpoint.error === undefined ? {} : { error: checkpoint.error.slice(0, 512) }) }
      })
      return projectSchedule(snapshot)
    },
    async runNow(request, principal) {
      const binding = await ownLatest(request.id, request.revision, principal)
      if (binding.spec.enabled === false) throw new Error('workflow schedule is disabled')
      const config = readCronBindingOptions(binding.spec.trigger.with)
      const trial = createCronTrigger({ ...config, now: () => request.requestedAt })
        .envelope(new Date(cronMinute(request.requestedAt)))
      let inputs
      try { inputs = mapInputs(binding.spec.inputMapping, trial) }
      catch { return { status: 'rejected', reasonCode: 'INGRESS_INPUT_MAPPING_INVALID' } }
      const { id, revision } = binding.spec.workflow
      const bindingRef = `${request.id}@${request.revision}`
      try {
        // A trial runs with the live DSH Agent. The clock cursor and delivery belong to the scheduling host.
        const run = await engine.start({
          parent: principal.agent, target: { type: 'published', id, revision }, inputs,
          origin: { type: 'trigger', source: 'cron-trial', sourceRef: bindingRef },
          idempotencyKey: `canvas:cron-trial:${bindingRef}:${request.requestId}`,
        })
        return { status: 'launched', runId: run.id }
      } catch (error: unknown) {
        if (error instanceof WorkflowExecutionError && (error.code === 'WORKFLOW_INPUT_INVALID' || error.code === 'WORKFLOW_INPUT_TOO_LARGE')) {
          return { status: 'rejected', reasonCode: `INGRESS_${error.code}` }
        }
        throw error
      }
    },
  }
}

function projectSchedule(snapshot: WorkflowCronSnapshot): CanvasScheduleSummary {
  const { expression, timezone } = readCronBindingOptions(snapshot.binding.spec.trigger.with)
  const state = snapshot.state
  const last = state?.last
  const { lastRun } = snapshot
  return {
    expression, timezone,
    ...(snapshot.nextRunAt === undefined ? {} : { nextRunAt: snapshot.nextRunAt }),
    ...(state?.lastTickAt === undefined ? {} : { lastTickAt: state.lastTickAt }),
    ...(last === undefined ? {} : { lastDecision: { ...projectDecision(last, lastRun?.runId), manual: last.manual, scheduledAt: last.scheduledAt } }),
    ...(lastRun === undefined ? {} : { lastRun }),
  }
}

function projectDecision(decision: NonNullable<NonNullable<WorkflowCronSnapshot['state']>['last']>, ownedRunId?: string): CanvasScheduleRunReceipt {
  return { status: decision.status,
    ...(decision.runId !== undefined && decision.runId === ownedRunId ? { runId: decision.runId } : {}),
    ...(decision.reasonCode === undefined ? {} : { reasonCode: decision.reasonCode }) }
}
