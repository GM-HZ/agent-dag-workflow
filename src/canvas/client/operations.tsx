import { useRef, useState } from 'react'
import type { CanvasOperationsSnapshot, CanvasScheduleRunReceipt } from '../types.js'
import { useCanvasCopy } from './locale.js'
import { classifyWorkflowError, runStatusLabel } from './ux.js'

type Binding = CanvasOperationsSnapshot['bindings'][number]

export function WorkflowOperationsPanel({ snapshot, busy, onRefresh, onOpenRun, onRunSchedule }: {
  readonly snapshot: CanvasOperationsSnapshot
  readonly busy: boolean
  readonly onRefresh: () => void
  readonly onOpenRun: (runId: string) => void
  readonly onRunSchedule: (id: string, revision: number, requestId: string, requestedAt: number) => Promise<CanvasScheduleRunReceipt>
}) {
  const { t } = useCanvasCopy()
  const requests = useRef(new Map<string, { readonly id: string; readonly requestedAt: number }>())
  const [running, setRunning] = useState<string>()
  const [receipts, setReceipts] = useState<Record<string, CanvasScheduleRunReceipt>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const schedules = snapshot.bindings.filter(binding => binding.spec.trigger.uses === 'cron@1')
  const otherBindings = snapshot.bindings.filter(binding => binding.spec.trigger.uses !== 'cron@1')

  async function startTrial(binding: Binding) {
    if (running !== undefined || !window.confirm(t('Run this schedule once with its saved inputs? It may call real Host tools. This trial does not send a delivery.'))) return
    const { id, revision } = binding.metadata
    const key = `${id}@${revision}`
    const request = requests.current.get(key) ?? { id: crypto.randomUUID?.() ?? [...crypto.getRandomValues(new Uint8Array(16))]
      .map(byte => byte.toString(16).padStart(2, '0')).join(''), requestedAt: Date.now() }
    requests.current.set(key, request)
    setRunning(key)
    setErrors(current => ({ ...current, [key]: '' }))
    try {
      const receipt = await onRunSchedule(id, revision, request.id, request.requestedAt)
      setReceipts(current => ({ ...current, [key]: receipt }))
      requests.current.delete(key)
    } catch (error: unknown) {
      setErrors(current => ({ ...current, [key]: classifyWorkflowError(error).detail }))
    } finally { setRunning(undefined) }
  }

  return <section className="wf-operations" aria-label={t('Trigger and delivery audit')}>
    <style>{SCHEDULE_CSS}</style>
    <header><div><h1>{t('Triggers, runs, and delivery')}</h1><span>{t('View host bindings, deduplicated ingress records, and deliveries that need attention. All triggers reference immutable workflow revisions.')}</span></div>
      <button onClick={onRefresh} disabled={busy || running !== undefined}>↻ {t('Refresh')}</button></header>
    <section className="wf-schedules" aria-label={t('Time schedules')}>
      <div className="wf-schedules-heading"><h2>{t('Time schedules')}</h2>
        <a href="https://github.com/GM-HZ/agent-dag-workflow/blob/main/docs/operations.md#个人定时任务" target="_blank" rel="noreferrer">{t('Set up system scheduling')}</a></div>
      {schedules.length === 0 ? <p>{t('No time schedules are visible in this session. Configure a schedule in its owning workspace, then refresh.')}</p> : null}
      {schedules.map(binding => {
        const { id, revision } = binding.metadata
        const key = `${id}@${revision}`
        return <ScheduleRow key={key} binding={binding} running={running === key} disabled={busy || running !== undefined}
          {...(receipts[key] === undefined ? {} : { receipt: receipts[key] })}
          {...(errors[key] === undefined ? {} : { error: errors[key] })}
          onStart={() => { void startTrial(binding) }} onOpenRun={onOpenRun} />
      })}
    </section>
    <div className="wf-operations-grid">
      <section><h2>{t('Bindings')} <em>{otherBindings.length}</em></h2>{otherBindings.length === 0 ? <p>{t('The host has no trigger bindings')}</p> : otherBindings.map(binding =>
        <article key={`${binding.metadata.id}@${binding.metadata.revision}`}><b>{binding.metadata.id}</b><code>{binding.spec.trigger.uses}</code>
          <span>{binding.spec.workflow.id}@{binding.spec.workflow.revision}</span><small>{t(binding.spec.enabled ? 'Enabled' : 'Disabled')}</small></article>)}</section>
      <section><h2>{t('Ingress audit')} <em>{snapshot.ingress.length}</em></h2>{snapshot.ingress.length === 0 ? <p>{t('No external triggers received')}</p> : snapshot.ingress.map(record =>
        <article key={record.triggerId} data-status={record.status}><b>{record.source} / {record.sourceEventId}</b><code>{record.status}</code>
          <span>{record.binding.id}@{record.binding.revision}</span><small>{record.runId ?? record.reasonCode ?? t('No associated run')} · {t('Duplicates: {count}', { count: record.duplicateCount ?? 0 })}</small>
          {record.runId === undefined ? null : <button onClick={() => onOpenRun(record.runId!)}>{t('View trace')}</button>}</article>)}</section>
      <section><h2>{t('Deliveries needing attention')} <em>{snapshot.deliveryAttention.length}</em></h2>{snapshot.deliveryAttention.length === 0 ? <p>{t('No deliveries in an unknown state')}</p> : snapshot.deliveryAttention.map(record =>
        <article key={record.invocationId} data-status="unknown"><b>{t('Needs attention')}</b><code>{record.phase} / {record.status}</code>
          <span>{record.runId}</span><small>{t('Attempts: {count}', { count: record.attempts })} · {t('Awaiting confirmation')}</small>
          <button onClick={() => onOpenRun(record.runId)}>{t('View trace')}</button></article>)}</section>
    </div>
  </section>
}

function ScheduleRow({ binding, running, disabled, receipt, error, onStart, onOpenRun }: {
  readonly binding: Binding
  readonly running: boolean
  readonly disabled: boolean
  readonly receipt?: CanvasScheduleRunReceipt
  readonly error?: string
  readonly onStart: () => void
  readonly onOpenRun: (runId: string) => void
}) {
  const { language, t } = useCanvasCopy()
  const { schedule } = binding
  const workflow = `${binding.spec.workflow.id}@${binding.spec.workflow.revision}`
  const formatter = schedule === undefined || schedule.unavailable === true ? undefined
    : new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en', { timeZone: schedule.timezone, dateStyle: 'medium', timeStyle: 'short' })
  const status = receipt ?? schedule?.lastDecision
  const traceId = receipt?.runId ?? schedule?.lastRun?.runId ?? schedule?.lastDecision?.runId
  const renderTime = (milliseconds: number | undefined, fallback: string) => milliseconds === undefined || formatter === undefined ? fallback
    : <time dateTime={new Date(milliseconds).toISOString()}>{formatter.format(milliseconds)}</time>
  return <article className="wf-schedule-row">
    <div className="wf-schedule-title"><div><strong>{binding.metadata.id}</strong><code>{workflow}</code></div>
      <span>{t(binding.spec.enabled ? 'Enabled' : 'Disabled')}</span></div>
    {schedule === undefined || schedule.unavailable === true ? <p>{t('Schedule details are unavailable. Refresh to check again.')}</p> : <>
      <p className="wf-schedule-clock"><code>{schedule.expression}</code> · {schedule.timezone}</p>
      <dl><div><dt>{t('Next scheduled run')}</dt><dd>{renderTime(schedule.nextRunAt, t('No scheduled time'))}</dd></div>
        <div><dt>{t('Last scheduler check')}</dt><dd>{renderTime(schedule.lastTickAt, t('Scheduler has not checked in'))}</dd></div>
        <div><dt>{t('Last schedule outcome')}</dt><dd>{running ? t('Starting schedule trial…') : status === undefined
          ? t('No schedule runs yet') : t(decisionLabel(status.status))}</dd></div></dl>
      {status?.reasonCode === undefined ? null : <p className="wf-schedule-error">{t('Trigger rejection reason')} <code>{status.reasonCode}</code></p>}
      {schedule.lastRun === undefined ? null : <p>{t('Last scheduled run')} · {runStatusLabel(schedule.lastRun.status, language)}</p>}
      {schedule.lastRun?.error === undefined ? null : <p className="wf-schedule-error">{schedule.lastRun.error}</p>}
      {error === undefined || error === '' ? null : <p role="alert" className="wf-schedule-error">{error}</p>}
      <div className="wf-schedule-actions"><button onClick={onStart} disabled={disabled || !binding.spec.enabled}>{t(running ? 'Starting schedule trial…' : 'Run schedule trial')}</button>
        {traceId === undefined ? null : <button onClick={() => onOpenRun(traceId)}>{t('View run journal')}</button>}</div>
    </>}
  </article>
}

function decisionLabel(status: CanvasScheduleRunReceipt['status']) {
  const labels = {
    launched: 'Scheduled run started', rejected: 'Schedule inputs rejected',
    'skipped-overlap': 'Skipped because another run is active', 'skipped-misfire': 'Skipped a missed schedule',
  } as const satisfies Record<CanvasScheduleRunReceipt['status'], string>
  return labels[status]
}

const SCHEDULE_CSS = String.raw`
.wf-schedules{max-width:1320px;margin:0 auto 18px;padding:16px;border:1px solid var(--wf-border);border-radius:14px;background:var(--wf-surface)}
.wf-schedules-heading,.wf-schedule-title,.wf-schedule-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between}.wf-schedules-heading h2{margin:0;font-size:16px}.wf-schedules a{font-size:12px;color:var(--wf-brand)}
.wf-schedules p,.wf-operations-grid>section>p{font-size:12px;color:var(--wf-muted)}.wf-schedule-row{border-top:1px solid var(--wf-border);margin-top:12px;padding-top:10px;font-size:12px;overflow-wrap:anywhere}
.wf-schedule-title code{margin-inline-start:8px;color:var(--wf-muted)}.wf-schedule-clock{margin:6px 0}.wf-schedule-row dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:10px;margin:10px 0}
.wf-schedule-row dt{color:var(--wf-muted)}.wf-schedule-row dd{margin:3px 0 0}.wf-schedule-actions{justify-content:flex-start}.wf-schedule-actions button{min-height:32px;padding-inline:10px}
.wf-schedule-row .wf-schedule-error{color:var(--wf-danger)}
`
