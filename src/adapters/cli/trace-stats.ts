import type { WorkflowRunProjection } from '../../access/index.js'
import { validateHostEvidence } from '../../core/host-evidence.js'
import { isRecordedReplayOrigin } from '../../core/replay.js'
import type { WorkflowEvent, WorkflowHostUsage } from '../../core/index.js'

const usageFields = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const

interface Durations {
  samples: number
  totalMs: number
  maxMs: number
}

function emptyDurations(): Durations {
  return { samples: 0, totalMs: 0, maxMs: 0 }
}

function emptyMetrics() {
  return {
    attempts: 0, failures: 0, retries: 0, duration: emptyDurations(),
    host: {
      requested: 0, completed: 0, failed: 0, replayed: 0, usageSamples: 0,
      modelIds: new Set<string>(), toolVersions: new Set<string>(), duration: emptyDurations(),
      usage: {} as Partial<Record<keyof WorkflowHostUsage, number>>,
    },
  }
}

type Metrics = ReturnType<typeof emptyMetrics>

export function createTraceStats() {
  const totals = emptyMetrics()
  const nodes = new Map<string, { uses?: string; metrics: Metrics }>()
  return {
    append(event: WorkflowEvent): void {
      if (!('nodeId' in event)) return
      let node = nodes.get(event.nodeId)
      if (node === undefined) {
        node = { metrics: emptyMetrics() }
        nodes.set(event.nodeId, node)
      }
      if (event.node?.uses !== undefined) node.uses = event.node.uses
      const evidence = 'hostEvidence' in event ? validateHostEvidence(event.hostEvidence) : undefined
      const recorded = event.type === 'capability.replayed' || isRecordedReplayOrigin(event.origin)
      for (const metrics of [totals, node.metrics]) {
        switch (event.type) {
          case 'node.started': metrics.attempts++; break
          case 'node.retry-scheduled':
            metrics.retries++
            metrics.failures++
            addDuration(metrics.duration, event.durationMs)
            break
          case 'node.failed':
            metrics.failures++
            addDuration(metrics.duration, event.durationMs)
            break
          case 'node.completed': addDuration(metrics.duration, event.durationMs); break
          case 'capability.requested': if (!recorded) metrics.host.requested++; break
          case 'capability.completed':
          case 'capability.failed':
          case 'capability.replayed':
            if (recorded) metrics.host.replayed++
            else if (event.type === 'capability.completed') metrics.host.completed++
            else metrics.host.failed++
            if (evidence?.modelId !== undefined) metrics.host.modelIds.add(evidence.modelId)
            if (evidence?.toolVersion !== undefined) metrics.host.toolVersions.add(evidence.toolVersion)
            if (!recorded) {
              addDuration(metrics.host.duration, evidence?.durationMs)
              if (evidence?.usage !== undefined) addUsage(metrics.host, evidence.usage)
            }
            break
        }
      }
    },
    finish(run: WorkflowRunProjection) {
      return {
        format: 'agent-dag-workflow.trace-stats/v1', runId: run.runId, ref: run.ref, status: run.status, checkpointSeq: run.checkpointSeq,
        totals: projectMetrics(totals),
        nodes: Object.keys(run.nodeStates).sort().map(nodeId => {
          const node = nodes.get(nodeId)
          return {
            nodeId, status: run.nodeStates[nodeId]!,
            ...(node?.uses === undefined ? {} : { uses: node.uses }),
            ...projectMetrics(node?.metrics ?? emptyMetrics()),
          }
        }),
      }
    },
  }
}

function addDuration(duration: Durations, milliseconds: number | undefined): void {
  if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds < 0) return
  duration.samples++
  duration.totalMs += milliseconds
  duration.maxMs = Math.max(duration.maxMs, milliseconds)
}

function addUsage(host: Metrics['host'], usage: WorkflowHostUsage): void {
  host.usageSamples++
  for (const field of usageFields) {
    const tokens = usage[field]
    if (tokens !== undefined) host.usage[field] = (host.usage[field] ?? 0) + tokens
  }
}

function projectMetrics({ host, ...metrics }: Metrics) {
  return {
    ...metrics,
    host: {
      requested: host.requested, completed: host.completed, failed: host.failed, replayed: host.replayed,
      modelIds: [...host.modelIds].sort(), toolVersions: [...host.toolVersions].sort(), duration: host.duration,
      usageSamples: host.usageSamples, ...(host.usageSamples === 0 ? {} : { usage: host.usage }),
    },
  }
}
