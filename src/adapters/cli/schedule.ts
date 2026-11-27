import { readFile } from 'node:fs/promises'
import { WorkflowAccessError, parsePublishedWorkflowRef, type AgentAccessContext } from '../../access/index.js'
import { snapshotJsonObject, WORKFLOW_TEMPLATE_API_VERSION, type WorkflowRunResult } from '../../core/index.js'
import { WorkflowRuntime } from '../../runtime/index.js'
import { SqliteWorkflowBindingRepository, SqliteWorkflowCronStore, SqliteWorkflowDeliveryStore, SqliteWorkflowIngressStore } from '../../storage/sqlite/index.js'
import {
  WorkflowBindingCatalog, WorkflowResultDeliveryService, WorkflowRunWorker, WorkflowRunWorkerError,
  WorkflowTriggerDefinitionRegistry, WorkflowTriggerIngress, type WorkflowBindingListQuery, type WorkflowDeliveryStore,
  type WorkflowRunCoordinator, type WorkflowTriggerBindingCandidate,
} from '../../triggers/core/index.js'
import { CRON_TRIGGER_DEFINITION, WorkflowCronScheduler, type WorkflowCronSnapshot } from '../../triggers/cron/index.js'
import type { WorkflowCliApplication, WorkflowCliNotice } from './application.js'
import type { WorkflowCliIo } from './run.js'

interface WorkerRequest { readonly workerId: string; readonly leaseMs: number; readonly signal?: AbortSignal }

export async function runPersonalScheduleCommand(
  command: 'schedule' | 'delivery',
  args: readonly string[],
  application: WorkflowCliApplication,
  context: AgentAccessContext,
  databasePath: string,
  io: Pick<WorkflowCliIo, 'readStdin'>,
): Promise<unknown> {
  const { action, id, options } = readArgs(args)
  const runtime = localScheduleRuntime(application, context)
  const deliveryRows = new SqliteWorkflowDeliveryStore({ path: databasePath })
  const deliveryStore = onlyOwnedDeliveries(deliveryRows, runtime, context.authorityRef)
  const delivery = application.host.delivery === undefined ? undefined : new WorkflowResultDeliveryService(application.host.delivery, deliveryStore)
  try {
    if (command === 'delivery') {
      if (action === 'list') return { items: await deliveryStore.listAttention({ limit: batchLimit(options, 100, 1000) }) }
      if (delivery === undefined) invalid('result delivery requires a Host module with a delivery gateway')
      if (action === 'retry') return await delivery.retry(requiredId(id))
      if (action !== 'retry-due') invalid('delivery requires list, retry, or retry-due')
      const batch = await delivery.retryDue({ limit: batchLimit(options, 25, 1000) })
      const notices = batch.failed.map(failure => ({
        type: 'delivery.pending' as const, runId: failure.runId, invocationId: failure.invocationId, message: failure.error,
      }))
      return { ...batch, notices, noticeFailures: await notify(application, notices) }
    }

    const bindingsRepository = new SqliteWorkflowBindingRepository({ path: databasePath })
    const scheduleStore = new SqliteWorkflowCronStore({ path: databasePath })
    const ingressStore = new SqliteWorkflowIngressStore({ path: databasePath })
    try {
      const definitions = new WorkflowTriggerDefinitionRegistry()
      definitions.register(CRON_TRIGGER_DEFINITION)
      const catalog = new WorkflowBindingCatalog(bindingsRepository, application.catalog, definitions)
      const bindings = {
        async get(bindingId: string, revision?: number) {
          const binding = await catalog.get(bindingId, revision)
          assertOwner(binding.spec.authorityRef, context.authorityRef)
          return binding
        },
        list(query?: WorkflowBindingListQuery) { return catalog.list({ ...query, authorityRef: context.authorityRef }) },
      }
      const ingress = new WorkflowTriggerIngress(runtime, ingressStore, bindings.get)
      const scheduler = new WorkflowCronScheduler(bindings, ingress, runtime, scheduleStore)

      switch (action) {
        case 'publish': {
          const bindingId = requiredId(id)
          const current = await bindingsRepository.get(bindingId)
          if (current !== undefined) assertOwner(current.spec.authorityRef, context.authorityRef)
          const candidate = await scheduleCandidate(bindingId, options, context.authorityRef, io)
          const revision = current?.spec.enabled === false ? { ...candidate, spec: { ...candidate.spec, enabled: false } } : candidate
          await catalog.publish(revision, expectedRevision(options, current?.metadata.revision ?? 0))
          return await scheduler.inspect(bindingId)
        }
        case 'status': return await scheduler.inspect(requiredId(id))
        case 'enable':
        case 'disable': {
          const current = await bindings.get(requiredId(id))
          await catalog.publish({ ...current, metadata: { id: current.metadata.id }, spec: {
            ...current.spec, enabled: action === 'enable',
          } }, expectedRevision(options, current.metadata.revision))
          return await scheduler.inspect(current.metadata.id)
        }
        case 'list': return { items: await listSchedules(bindings.list, scheduler, batchLimit(options, 100, 1000)) }
        case 'run-now': {
          context.signal?.throwIfAborted()
          const bindingId = requiredId(id)
          const launched = await scheduler.runNow(bindingId)
          const runId = launched.state?.last?.runId
          if (runId === undefined) return { schedule: launched }
          const worker = createWorker(application, runtime, context, delivery, runId)
          try {
            const result = await worker.runOnce(workerRequest(context))
            const notices = runNotices(result)
            return { schedule: await scheduler.inspect(bindingId), ...(result === undefined ? {} : { result: projectRunResult(result) }),
              notices, noticeFailures: await notify(application, notices) }
          } catch (error: unknown) {
            const notices = workerNotices(error)
            return { schedule: await scheduler.inspect(bindingId), failures: [{ runId, error: errorMessage(error) }],
              notices, noticeFailures: await notify(application, notices) }
          }
        }
        case 'tick': return await tickSchedules(scheduler, application, runtime, deliveryStore, delivery, context, batchLimit(options, 25, 100))
        default: invalid('schedule requires list, status, publish, enable, disable, tick, or run-now')
      }
    } finally {
      ingressStore.close()
      scheduleStore.close()
      bindingsRepository.close()
    }
  } finally { deliveryRows.close() }
}

export async function runPersonalWorker(
  application: WorkflowCliApplication,
  context: AgentAccessContext,
  databasePath: string,
  request: WorkerRequest,
): Promise<WorkflowRunResult | undefined> {
  const runtime = localScheduleRuntime(application, context)
  const deliveryRows = application.host.delivery === undefined ? undefined : new SqliteWorkflowDeliveryStore({ path: databasePath })
  const delivery = deliveryRows === undefined || application.host.delivery === undefined ? undefined
    : new WorkflowResultDeliveryService(application.host.delivery, onlyOwnedDeliveries(deliveryRows, runtime, context.authorityRef))
  try {
    const result = await createWorker(application, runtime, context, delivery).runOnce(request)
    await notify(application, runNotices(result))
    return result
  } catch (error: unknown) {
    await notify(application, workerNotices(error))
    throw error
  } finally { deliveryRows?.close() }
}

function localScheduleRuntime(application: WorkflowCliApplication, context: AgentAccessContext): WorkflowRuntime {
  if (application.host.authorityResolver !== undefined || context.authorityRef !== 'cli:local') return application.runtime
  return new WorkflowRuntime({
    nodes: application.nodes, catalog: application.catalog, runStore: application.runStore,
    queue: application.coordinator, artifactStore: application.artifactStore,
    capturePolicy: { mode: 'standard', maxArtifactBytes: 1024 * 1024 },
    ...(application.host.services === undefined ? {} : { services: application.host.services }),
    authorityResolver: { async resolve(ref) { return ref === 'cli:local' ? context.authority : undefined } },
  })
}

function createWorker(
  application: WorkflowCliApplication,
  runtime: WorkflowRuntime,
  context: AgentAccessContext,
  delivery?: WorkflowResultDeliveryService,
  runId?: string,
): WorkflowRunWorker {
  const coordinator = application.coordinator
  const scoped: WorkflowRunCoordinator = {
    enqueue: id => coordinator.enqueue(id),
    claim: request => coordinator.claim({ ...request, authorityRef: context.authorityRef, ...(runId === undefined ? {} : { runId }) }),
    heartbeat: request => coordinator.heartbeat(request),
    release: request => coordinator.release(request),
    requeue: request => coordinator.requeue(request),
  }
  return new WorkflowRunWorker(runtime, scoped, delivery)
}

function onlyOwnedDeliveries(store: SqliteWorkflowDeliveryStore, runtime: WorkflowRuntime, authorityRef: string): WorkflowDeliveryStore {
  return {
    async get(invocationId) {
      const row = await store.get(invocationId)
      if (row === undefined || (await runtime.getRun(row.runId))?.authorityRef !== authorityRef) return undefined
      return row
    },
    save: (row, attempts) => store.save(row, attempts),
    listAttention: query => store.listAttention({ ...query, authorityRef }),
  }
}

async function tickSchedules(
  scheduler: WorkflowCronScheduler,
  application: WorkflowCliApplication,
  runtime: WorkflowRuntime,
  deliveryStore: WorkflowDeliveryStore,
  delivery: WorkflowResultDeliveryService | undefined,
  context: AgentAccessContext,
  limit: number,
) {
  context.signal?.throwIfAborted()
  const now = Date.now()
  const currentMinute = Math.floor(now / 60_000) * 60_000
  const tick = await scheduler.tickAll(now)
  const notices: WorkflowCliNotice[] = []
  for (const { bindingId, decision } of tick.decisions) {
    if (decision.status === 'skipped-misfire' || decision.status === 'skipped-overlap' || decision.scheduledAt < currentMinute) {
      notices.push({ type: 'schedule.missed', bindingId, message: `${bindingId} at ${new Date(decision.scheduledAt).toISOString()}: ${decision.status}`,
        ...(decision.runId === undefined ? {} : { runId: decision.runId }) })
    }
  }
  const worker = createWorker(application, runtime, context, delivery)
  const runs: ReturnType<typeof projectRunResult>[] = []
  const failures: { readonly runId?: string; readonly error: string }[] = []
  for (let attempt = 0; attempt < limit; attempt++) {
    context.signal?.throwIfAborted()
    try {
      const result = await worker.runOnce(workerRequest(context))
      if (result === undefined) break
      runs.push(projectRunResult(result))
      notices.push(...runNotices(result))
    } catch (error: unknown) {
      notices.push(...workerNotices(error))
      failures.push({ error: errorMessage(error), ...(error instanceof WorkflowRunWorkerError ? { runId: error.runId } : {}) })
      // Failed claims can remain recoverable. End this tick on a repeat to
      // avoid exhausting retries immediately on an empty or degraded queue.
      if (error instanceof WorkflowRunWorkerError && failures.filter(failure => failure.runId === error.runId).length > 1) break
    }
  }
  const retried = await delivery?.retryDue({ limit })
  for (const failure of retried?.failed ?? []) notices.push({ type: 'delivery.pending', runId: failure.runId,
    invocationId: failure.invocationId, message: failure.error })
  const schedules = await Promise.all(tick.schedules.map(schedule => scheduler.inspect(schedule.binding.metadata.id, now)))
  return {
    ...tick, schedules, runs, failures,
    ...(retried === undefined ? {} : { delivery: retried }),
    pendingDeliveries: await deliveryStore.listAttention({ limit }),
    notices, noticeFailures: await notify(application, notices),
  }
}

function runNotices(result: WorkflowRunResult | undefined): WorkflowCliNotice[] {
  return result?.status === 'failed' || result?.status === 'paused'
    ? [{ type: result.status === 'failed' ? 'run.failed' : 'run.paused', runId: result.runId, message: result.error }] : []
}

function workerNotices(error: unknown): WorkflowCliNotice[] {
  if (!(error instanceof WorkflowRunWorkerError)) return []
  return [{ type: error.phase === 'delivery' ? 'delivery.pending' : 'run.recovery-required', runId: error.runId, message: error.message }]
}

async function notify(application: WorkflowCliApplication, notices: readonly WorkflowCliNotice[]): Promise<readonly string[]> {
  if (application.host.notify === undefined) return []
  const failures: string[] = []
  for (const notice of notices) {
    try { await application.host.notify(notice) }
    catch (error: unknown) { failures.push(errorMessage(error)) }
  }
  return failures
}

function workerRequest(context: AgentAccessContext): WorkerRequest {
  return { workerId: `cli-scheduler:${process.pid}`, leaseMs: 30_000, ...(context.signal === undefined ? {} : { signal: context.signal }) }
}

function projectRunResult(result: WorkflowRunResult) {
  return result.status === 'completed' ? { runId: result.runId, status: result.status, outputs: result.outputs }
    : { runId: result.runId, status: result.status, error: result.error,
      ...(result.needsAttention === undefined ? {} : { needsAttention: result.needsAttention }) }
}

async function listSchedules(
  list: (query: WorkflowBindingListQuery) => ReturnType<WorkflowBindingCatalog['list']>,
  scheduler: WorkflowCronScheduler,
  maximum: number,
): Promise<readonly WorkflowCronSnapshot[]> {
  const items: WorkflowCronSnapshot[] = []
  const limit = 100
  let afterId: string | undefined
  for (;;) {
    const page = await list({ latestOnly: true, limit, ...(afterId === undefined ? {} : { afterId }) })
    for (const binding of page) {
      if (binding.spec.trigger.uses !== 'cron@1') continue
      items.push(await scheduler.inspect(binding.metadata.id))
      if (items.length === maximum) return items
    }
    if (page.length < limit) return items
    afterId = page.at(-1)!.metadata.id
  }
}

async function scheduleCandidate(
  id: string,
  options: ReadonlyMap<string, string>,
  authorityRef: string,
  io: Pick<WorkflowCliIo, 'readStdin'>,
): Promise<WorkflowTriggerBindingCandidate> {
  const workflow = parsePublishedWorkflowRef(requiredOption(options, '--workflow'))
  const expression = requiredOption(options, '--cron')
  const timezone = requiredOption(options, '--timezone')
  const file = options.get('--input')
  const literal = options.get('--input-json')
  if (file !== undefined && literal !== undefined) invalid('schedule publish accepts only one of --input and --input-json')
  const inputJson = literal ?? (file === undefined ? '{}' : file === '-' ? await io.readStdin() : await readFile(file, 'utf8'))
  let input: ReturnType<typeof snapshotJsonObject>
  try { input = snapshotJsonObject(JSON.parse(inputJson)) }
  catch (error: unknown) { throw new WorkflowAccessError('WORKFLOW_REQUEST_INVALID', 'schedule input must be a JSON object', { cause: error }) }
  const misfirePolicy = options.get('--misfire')
  const overlapPolicy = options.get('--overlap')
  const dayMatch = options.get('--day-match')
  const deliveryRef = options.get('--delivery')
  return {
    kind: 'WorkflowBinding', apiVersion: WORKFLOW_TEMPLATE_API_VERSION, metadata: { id },
    spec: { workflow, authorityRef,
      trigger: { uses: 'cron@1', with: { expression, timezone,
        ...(misfirePolicy === undefined ? {} : { misfirePolicy }), ...(overlapPolicy === undefined ? {} : { overlapPolicy }),
        ...(dayMatch === undefined ? {} : { dayMatch }),
      } },
      inputMapping: Object.fromEntries(Object.entries(input).map(([key, value]) => [key, { literal: value }])),
      ...(deliveryRef === undefined ? {} : { deliveryRef }),
    },
  }
}

function readArgs(args: readonly string[]) {
  const options = new Map<string, string>()
  const positions: string[] = []
  for (let index = 0; index < args.length; index++) {
    const item = args[index]!
    if (item.startsWith('--')) options.set(item, args[++index]!)
    else positions.push(item)
  }
  return { action: positions[0], id: positions[1], options }
}

function assertOwner(found: string, expected: string): void {
  if (found !== expected) throw new WorkflowAccessError('WORKFLOW_AUTHORITY_DENIED', 'workflow schedule belongs to another authority')
}

function requiredId(id: string | undefined): string {
  if (id === undefined) invalid('a schedule or delivery ID is required')
  return id
}

function requiredOption(options: ReadonlyMap<string, string>, option: string): string {
  const value = options.get(option)
  if (value === undefined) invalid(`${option} is required`)
  return value
}

function expectedRevision(options: ReadonlyMap<string, string>, fallback: number): number {
  const expected = Number(options.get('--expected') ?? fallback)
  if (!Number.isSafeInteger(expected) || expected < 0) invalid('--expected must be a non-negative integer')
  return expected
}

function batchLimit(options: ReadonlyMap<string, string>, fallback: number, maximum: number): number {
  const limit = Number(options.get('--limit') ?? fallback)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) invalid(`--limit must be between 1 and ${maximum}`)
  return limit
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function invalid(message: string): never { throw new WorkflowAccessError('WORKFLOW_REQUEST_INVALID', message) }
