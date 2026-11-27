import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CanvasJsonObject, CanvasRunDetails, CanvasRunHistoryPage, CanvasRunHistoryRequest, CanvasTrace, CanvasWorkflowTemplate } from '../types.js'
import type { WorkflowCanvasClientApi } from './api.js'
import { useCanvasCopy } from './locale.js'
import { downloadCanvasFile } from './personal.js'
import { WorkflowResultView } from './result-view.js'
import { FrozenRunGraph } from './run-graph.js'
import { WorkflowAuditExport } from './run-case.js'
import { isTerminalRun, NewRunFromHistory, RunComparison, type NewRunResult } from './run-dialogs.js'
import { useRunStop, useRunWatch } from './run-watch.js'
import { classifyWorkflowError, runStatusLabel, visibleTraceEvents } from './ux.js'

const statuses = ['completed', 'running', 'failed', 'paused', 'cancelled'] as const
const emptyPage: CanvasRunHistoryPage = { items: [] }
interface JournalFilter { readonly runId: string | undefined; readonly nodeId: string | undefined; readonly failuresOnly: boolean }

export function WorkflowRunHistory({ api, sessionId, templateId, initialRunId, initialGraph, initialNodeId, onStartNewRun, hasHostEffects }: {
  readonly api: WorkflowCanvasClientApi
  readonly sessionId: string
  readonly templateId: string
  readonly initialRunId?: string
  readonly initialGraph?: boolean
  readonly initialNodeId?: string
  readonly onStartNewRun: (details: CanvasRunDetails, inputs: CanvasJsonObject) => Promise<NewRunResult>
  readonly hasHostEffects: (template: CanvasWorkflowTemplate) => boolean
}) {
  const { language, t } = useCanvasCopy()
  const [filters, setFilters] = useState<CanvasRunHistoryRequest>({})
  const [page, setPage] = useState<CanvasRunHistoryPage>(emptyPage)
  const [listState, setListState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const listEpoch = useRef(0)
  const [selectedRunId, setSelectedRunId] = useState(initialRunId)
  const [openRunId, setOpenRunId] = useState('')
  const [copiedRunId, setCopiedRunId] = useState<string>()
  const [journalFilter, setJournalFilter] = useState<JournalFilter>({ runId: undefined, nodeId: undefined, failuresOnly: false })
  const selectedNode = journalFilter.runId === selectedRunId ? journalFilter.nodeId : undefined
  const failuresOnly = journalFilter.runId === selectedRunId && journalFilter.failuresOnly
  const { trace, error: watchError, reading: traceReading, ready: traceReady, read: readTrace, readOlder } = useRunWatch(api, sessionId, selectedRunId, 100, {
    window: 'recent', failuresOnly, ...(selectedNode === undefined ? {} : { nodeId: selectedNode }),
  })
  const { phase: stopPhase, stop } = useRunStop(api, sessionId, selectedRunId)
  const stopping = trace?.status === 'running' && stopPhase === 'requesting'
  const [traceBusy, setTraceBusy] = useState(false)
  const [details, setDetails] = useState<CanvasRunDetails>()
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [newRun, setNewRun] = useState<CanvasRunDetails>()
  const [newRunTarget, setNewRunTarget] = useState<string>()
  const [auditExport, setAuditExport] = useState<{ runId: string; kind: 'case' | 'evidence'; details?: CanvasRunDetails }>()
  const [baseline, setBaseline] = useState<string>()
  const [candidate, setCandidate] = useState<string>()
  const [resolutions, setResolutions] = useState<Readonly<Record<string, 'retry' | 'fail'>>>({})
  const [jumpToFailure, setJumpToFailure] = useState<string>()
  const [focusedEvent, setFocusedEvent] = useState<{ runId: string; seq: number }>()
  const timeline = useRef<HTMLElement>(null)
  const [error, setError] = useState<string>()
  const [showInfrastructure, setShowInfrastructure] = useState(false)
  const [showFilters, setShowFilters] = useState(false)
  const date = useMemo(() => new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en', { dateStyle: 'short', timeStyle: 'short' }), [language])
  const eventViews = useMemo(() => trace === undefined || !traceReady ? [] : visibleTraceEvents(trace, showInfrastructure, language), [language, showInfrastructure, trace, traceReady])
  const rawEvents = useMemo(() => new Map(trace?.events.map(event => [event.seq, event])), [trace])

  const loadRuns = useCallback(async (request: CanvasRunHistoryRequest) => {
    const epoch = ++listEpoch.current
    setListState('loading')
    setError(undefined)
    try {
      const next = await api.request('workflowCanvas.listRuns', () => api.remote.listRuns(sessionId, { ...request, limit: 25 }), { retries: 1 })
      if (listEpoch.current !== epoch) return
      setPage(current => {
        if (request.after === undefined) return next
        const seen = new Set(current.items.map(run => run.runId))
        return { ...next, items: [...current.items, ...next.items.filter(run => !seen.has(run.runId))] }
      })
      setListState('ready')
    } catch (cause: unknown) {
      if (listEpoch.current !== epoch) return
      setError(classifyWorkflowError(cause).detail)
      setListState('failed')
    }
  }, [api, sessionId])

  useEffect(() => { void loadRuns({}) }, [loadRuns])
  useEffect(() => { if (initialRunId !== undefined) setSelectedRunId(initialRunId) }, [initialRunId])
  useEffect(() => {
    setDetails(undefined)
    setDetailsOpen(false)
    setAuditExport(undefined)
    setResolutions({})
    setJumpToFailure(undefined)
    setFocusedEvent(undefined)
    setCopiedRunId(undefined)
  }, [selectedRunId])
  useEffect(() => {
    const target = newRunTarget === selectedRunId ? newRunTarget : initialGraph === true && initialRunId === selectedRunId ? initialRunId : undefined
    if (target === undefined) return
    let current = true
    void api.request('workflowCanvas.runDetails', () => api.remote.runDetails(sessionId, { runId: target }), { retries: 1 })
      .then(value => {
        if (!current) return
        setDetails(value)
        setJournalFilter({ runId: target, nodeId: target === initialRunId ? initialNodeId : undefined, failuresOnly: false })
        setDetailsOpen(true)
      }).catch((cause: unknown) => { if (current) setError(classifyWorkflowError(cause).detail) })
    return () => { current = false }
  }, [api, initialGraph, initialNodeId, initialRunId, newRunTarget, selectedRunId, sessionId])
  useEffect(() => {
    if (trace === undefined || !traceReady || traceReading || jumpToFailure !== trace.runId) return
    const event = trace.events.findLast(entry => entry.type === 'node.failed')
      ?? trace.events.findLast(entry => entry.type === 'run.failed') ?? trace.events.at(-1)
    setJumpToFailure(undefined)
    if (typeof event?.seq !== 'number') return
    const row = timeline.current?.querySelector<HTMLDetailsElement>(`[data-seq="${event.seq}"]`)
    if (row === null || row === undefined) return
    row.open = true
    row.scrollIntoView({ block: 'nearest' })
    row.querySelector('summary')?.focus({ preventScroll: true })
    setFocusedEvent({ runId: trace.runId, seq: event.seq })
  }, [jumpToFailure, trace, traceReady, traceReading])

  const changeFilters = (next: CanvasRunHistoryRequest) => {
    setFilters(next)
    setPage(emptyPage)
    void loadRuns(next)
  }
  const openTrace = (runId: string) => {
    setError(undefined)
    if (runId === selectedRunId) void readTrace()
    else setSelectedRunId(runId)
  }
  const selectEvents = (nodeId: string | undefined, onlyFailures = failuresOnly) => {
    setFocusedEvent(undefined)
    setJumpToFailure(undefined)
    setJournalFilter({ runId: selectedRunId, nodeId, failuresOnly: onlyFailures })
  }
  const showFailure = (nodeId?: string) => {
    selectEvents(nodeId, true)
    setJumpToFailure(selectedRunId)
  }
  const act = async <T,>(action: () => Promise<T>) => {
    setTraceBusy(true)
    setError(undefined)
    try { return await action() } catch (cause: unknown) { setError(classifyWorkflowError(cause).detail); return undefined }
    finally { setTraceBusy(false) }
  }
  const getDetails = async () => {
    if (selectedRunId === undefined) return undefined
    if (details?.runId === selectedRunId) return details
    const data = await api.request('workflowCanvas.runDetails', () => api.remote.runDetails(sessionId, { runId: selectedRunId }), { retries: 1 })
    if (data.runId !== selectedRunId) throw new Error('The run details did not match the selected run.')
    setDetails(data)
    return data
  }
  const resume = () => void act(async () => {
    if (trace === undefined) return
    const pending = trace.needsAttention ?? []
    if (pending.some(id => resolutions[id] === undefined)) return
    if (pending.some(id => resolutions[id] === 'retry') && !window.confirm(t('Retry may repeat an external action. Resume this run?'))) return
    const unknownNodeResolutions = Object.fromEntries(pending.map(id => [id, resolutions[id]!]))
    await api.request('workflowCanvas.resumeRun', () => api.remote.resumeRun(sessionId, {
      runId: trace.runId, ...(pending.length === 0 ? {} : { unknownNodeResolutions }),
    }))
    setResolutions({})
    await readTrace()
    await loadRuns(filters)
  })
  const cancel = () => void act(async () => {
    if (trace === undefined || !window.confirm(t('Request stop? A running Host action may finish first.'))) return
    await stop(trace.runId, 'cancelled from Canvas history')
    await readTrace()
    await loadRuns(filters)
  })
  const download = async () => {
    if (trace === undefined) return
    await act(async () => {
      const journal = await readRunJournal(api, sessionId, trace.runId)
      downloadCanvasFile(journal, `workflow-${trace.runId}.jsonl`)
    })
  }
  const pendingNodes = trace?.needsAttention ?? []
  const interrupted = trace?.status === 'running' && trace.active === false
  const awaitingApproval = trace?.status === 'running' && !interrupted && Object.values(trace.nodeStates).includes('waiting')
  const failure = trace?.status === 'failed' ? describeFailure(trace) : undefined
  const openGraph = (nodeId?: string) => {
    if (nodeId !== undefined) showFailure(nodeId)
    void act(async () => {
      if (await getDetails() === undefined) return
      setDetailsOpen(true)
    })
  }
  const copyRunId = (runId: string) => void act(async () => {
    await navigator.clipboard.writeText(runId)
    setCopiedRunId(runId)
  })
  const prepareCase = () => void act(async () => {
    if (trace === undefined) return
    const data = await getDetails()
    if (data === undefined) return
    setAuditExport({ kind: 'case', runId: trace.runId, details: data })
  })
  const prepareNewRun = () => void act(async () => setNewRun(await getDetails()))
  const startNewRun = async (source: CanvasRunDetails, inputs: CanvasJsonObject) => {
    const launched = await onStartNewRun(source, inputs)
    if (launched.runId !== undefined) {
      setNewRun(undefined)
      setNewRunTarget(launched.runId)
      openTrace(launched.runId)
      void loadRuns(filters)
    }
    return launched
  }
  const watchIssue = watchError === undefined ? undefined : classifyWorkflowError(watchError, language)
  const runOrigin = trace?.origin ?? details?.origin ?? page.items.find(run => run.runId === selectedRunId)?.origin
  const replaySource = runOrigin?.type === 'replay' ? runOrigin.sourceRef : undefined
  const selectedStatus = stopping ? t('Stop requested…') : interrupted ? t('Interrupted')
    : awaitingApproval ? t('Awaiting human input') : pendingNodes.length > 0 ? t('Needs attention') : runStatusLabel(trace?.status, language)

  return <section className="wf-history" aria-label={t('Run history')}>
    <style>{HISTORY_CSS}</style>
    <header className="wf-history-title"><h1>{t('Run history')}</h1><button onClick={() => void loadRuns(filters)} disabled={listState === 'loading'}>↻ {t('Refresh')}</button></header>
    {error === undefined ? null : <p className="wf-history-error" role="alert">{error}</p>}
    <div className="wf-history-workspace">
      <section className="wf-history-list" aria-label={t('Saved runs')}>
        <form className="wf-history-open" onSubmit={event => {
          event.preventDefault()
          if (openRunId.trim() !== '') openTrace(openRunId.trim())
        }}>
          <label><span>{t('Open by Run ID')}</span><input value={openRunId} onChange={event => setOpenRunId(event.currentTarget.value)}
            autoComplete="off" spellCheck={false} maxLength={1024} placeholder={t('Run ID')} required /></label>
          <button type="submit" disabled={traceBusy || openRunId.trim() === ''}>{t('Open run')}</button>
        </form>
        <div className="wf-history-filters">
          <label>{t('Workflow')} <select value={filters.templateId === undefined ? 'all' : 'current'} onChange={event => {
            const { templateId: _previous, ...rest } = filters
            changeFilters({ ...rest, ...(event.currentTarget.value === 'current' ? { templateId } : {}) })
          }} disabled={listState === 'loading'}><option value="all">{t('All workflows')}</option><option value="current">{t('Current workflow')}</option></select></label>
          <label>{t('Status')} <select value={filters.status ?? ''} onChange={event => {
            const status = statuses.find(candidate => candidate === event.currentTarget.value)
            const { status: _previous, ...rest } = filters
            changeFilters({ ...rest, ...(status === undefined ? {} : { status }) })
          }} disabled={listState === 'loading'}><option value="">{t('All statuses')}</option>{statuses.map(status => <option key={status} value={status}>{runStatusLabel(status, language)}</option>)}</select></label>
          <button onClick={() => setShowFilters(value => !value)} aria-expanded={showFilters}>{t('More filters')}</button>
          {showFilters ? <form className="wf-history-more-filters" onSubmit={event => {
            event.preventDefault()
            const values = new FormData(event.currentTarget)
            const query = String(values.get('query') ?? '').trim()
            const revision = Number(values.get('revision')) || undefined
            const origin = String(values.get('origin') ?? '')
            const from = new Date(`${String(values.get('from'))}T00:00:00`).getTime()
            const through = new Date(`${String(values.get('through'))}T23:59:59.999`).getTime()
            changeFilters({
              ...(filters.status === undefined ? {} : { status: filters.status }),
              ...(filters.templateId === undefined ? {} : { templateId: filters.templateId }),
              ...(query === '' ? {} : { query }), ...(origin === '' ? {} : { origin }),
              ...(revision === undefined ? {} : { revision }),
              ...(Number.isFinite(from) ? { from } : {}), ...(Number.isFinite(through) ? { through } : {}),
            })
          }}>
            <label>{t('Find a run')}<input name="query" defaultValue={filters.query} /></label>
            <label>{t('Exact revision')}<input name="revision" type="number" min={1} step={1} defaultValue={filters.revision} /></label>
            <label>{t('Origin')}<select name="origin" defaultValue={filters.origin ?? ''}><option value="">{t('All origins')}</option>
              {['host', 'cli', 'mcp', 'sdk', 'trigger', 'replay'].map(origin => <option key={origin}>{origin}</option>)}
            </select></label>
            <label>{t('From date')}<input type="date" name="from" defaultValue={dateInput(filters.from)} /></label>
            <label>{t('Through date')}<input type="date" name="through" defaultValue={dateInput(filters.through)} /></label>
            <button disabled={listState === 'loading'}>{t('Apply filters')}</button>
          </form> : null}
        </div>
        {baseline === undefined ? null : <div className="wf-compare-baseline"><span>{t('Baseline run')} <code>{baseline}</code></span>
          <button onClick={() => setBaseline(undefined)}>{t('Clear baseline')}</button></div>}
        <div className="wf-history-scroll">
          {page.items.length === 0 ? <p className="wf-history-empty">{listState === 'loading' ? t('Loading run history…') : listState === 'failed' ? t('Could not load run history') : t('No runs match these filters')}</p> : null}
          {page.items.map(run => <button className="wf-history-row" key={run.runId} aria-pressed={run.runId === selectedRunId} onClick={() => openTrace(run.runId)} disabled={traceBusy}>
            <span><strong>{run.templateName}{run.revision === undefined ? '' : ` @${run.revision}`}</strong><code title={run.runId}>{run.runId}{run.origin.source === undefined ? '' : ` · ${run.origin.source}`}</code></span>
            <span><strong className="wf-history-status" data-status={run.status}>{run.runId === trace?.runId ? selectedStatus : run.needsAttention ? t('Needs attention')
              : run.status === 'running' && run.active === false ? t('Interrupted') : runStatusLabel(run.status, language)}</strong><time dateTime={new Date(run.updatedAt).toISOString()}>{date.format(run.updatedAt)}</time></span>
          </button>)}
          {page.nextAfter === undefined ? null : <button className="wf-history-more" onClick={() => void loadRuns({ ...filters, after: page.nextAfter! })} disabled={listState === 'loading'}>{t('Load more runs')}</button>}
        </div>
      </section>
      <section className="wf-history-detail" aria-label={t('Run journal')}>
        {watchIssue === undefined ? null : <div className="wf-history-watch-error" role="alert"><div><strong>{watchIssue.title}</strong>
          <p>{watchIssue.kind === 'permission' || watchIssue.kind === 'not-found' ? t('Check the Run ID and use a session that can access the saved run.') : watchIssue.remedy}</p>
          <small>{watchIssue.detail}</small></div>
          <button onClick={() => void readTrace(true)} disabled={traceReading}>{t('Retry loading')}</button></div>}
        {trace === undefined ? watchIssue === undefined ? <p className="wf-history-empty" role="status">
          {selectedRunId === undefined ? t('Select a run to inspect its journal') : t('Loading run journal…')}</p> : null : <>
          <div className="wf-history-detail-head">
            <div><h2>{details?.runId === trace.runId ? details.template.metadata.name : t('Run journal')}</h2><code>{trace.runId}</code></div>
            <div className="wf-history-header-actions"><button onClick={() => copyRunId(trace.runId)} disabled={traceBusy}>{t('Copy run ID')}</button>
              <button onClick={() => void readTrace(true)} disabled={traceBusy || traceReading}>{t('Refresh')}</button></div>
            {copiedRunId === trace.runId ? <small className="wf-history-copy" role="status">{t('Run ID copied')}</small> : null}
          </div>
          <div className="wf-history-scroll wf-history-records">
            <dl><div><dt>{t('Workflow')}</dt><dd><code>{runRef(trace)}</code></dd></div><div><dt>{t('Status')}</dt><dd className="wf-history-status" data-status={trace.status} aria-live="polite">{selectedStatus}</dd></div><div><dt>{t('Journal sequence')}</dt><dd><code>{trace.checkpointSeq}</code></dd></div></dl>
            {replaySource === undefined ? null : <p className="wf-history-replay">{t(runOrigin?.source === 'recorded' ? 'Recorded replay from' : 'Replay from')}
              <button onClick={() => openTrace(replaySource)}><code>{replaySource}</code></button></p>}
            {failure === undefined ? trace.error === undefined ? null : <p className="wf-history-error">{trace.error}</p> : <section className="wf-history-failure" aria-label={t('Failure summary')}>
              <div><h3>{t('Run failed')}{failure.nodeId === undefined ? null : <code>{failure.nodeId}</code>}</h3>
                <p>{failure.message ?? t('The journal records where this run stopped.')}</p>
                {failure.code === undefined ? null : <code className="wf-history-error-code">{failure.code}</code>}
                {failure.nodeId === undefined ? null : <p className="wf-history-failure-advice">{t('Review the node inputs and recorded error before starting another run.')}</p>}
              </div>
              <div className="wf-history-failure-actions">
                {failure.nodeId === undefined ? null : <button onClick={() => openGraph(failure.nodeId)} disabled={traceBusy}>{t('Inspect failed node')} <code>{failure.nodeId}</code></button>}
                <button onClick={() => showFailure(failure.nodeId)} disabled={traceBusy}>{t('Open failure event')}</button>
              </div>
            </section>}
            {interrupted ? <p className="wf-stop-note" role="status">{t('Continue from the last saved checkpoint to resume this interrupted run.')}</p> : null}
            {awaitingApproval ? <p className="wf-stop-note" role="status">{t('Respond to the pending approval in the Host to continue.')}</p> : null}
            {stopping || stopPhase === 'finished' ? <p className="wf-stop-note" role="status">{t(stopping ? 'Waiting for the Host to finish or stop the current action.' : 'Run finished before it could be stopped.')}</p> : null}
            <div className="wf-history-detail-actions">
              {trace.status === 'running' && !interrupted && (stopPhase === undefined || stopping) ? <button onClick={cancel} disabled={traceBusy || stopping}>{t('Stop run')}</button> : null}
              {trace.status === 'paused' || interrupted
                ? <button onClick={resume} disabled={traceBusy || pendingNodes.some(id => resolutions[id] === undefined)}>{t('Continue this run')}</button> : null}
              <button onClick={prepareNewRun} disabled={traceBusy}>{t('New run with these inputs')}</button>
              <button onClick={() => detailsOpen ? setDetailsOpen(false) : openGraph()} disabled={traceBusy} aria-expanded={detailsOpen}>{t('Show executed graph')}</button>
              <details className="wf-history-audit"><summary>{t('Audit and regression')}</summary><div>
                <button onClick={() => void download()} disabled={traceBusy} title={t('Raw JSONL may contain unredacted inputs and results.')}>{t('Download raw JSONL')}</button>
                <button onClick={() => setAuditExport({ kind: 'evidence', runId: trace.runId })} disabled={traceBusy}>{t('Export shareable evidence')}</button>
                {trace.status === 'completed' || trace.status === 'failed' ? <button onClick={prepareCase} disabled={traceBusy}>{t('Save regression case')}</button> : null}
                {!isTerminalRun(trace) || baseline === trace.runId ? null : baseline === undefined
                  ? <button onClick={() => setBaseline(trace.runId)} disabled={traceBusy}>{t('Set as comparison baseline')}</button>
                  : <button onClick={() => setCandidate(trace.runId)} disabled={traceBusy}>{t('Compare with baseline')}</button>}
              </div></details>
            </div>
            {pendingNodes.length === 0 ? null : <fieldset className="wf-history-decisions">
              <legend>{t('Resolve unknown node outcomes')}</legend>
              <p>{t('Review the recorded result before choosing whether to retry an external action.')}</p>
              {pendingNodes.map(id => <label key={id}><code>{id}</code><select value={resolutions[id] ?? ''} onChange={event => {
                const value = event.currentTarget.value
                const next = { ...resolutions }
                if (value === 'retry' || value === 'fail') next[id] = value
                else delete next[id]
                setResolutions(next)
              }}><option value="">{t('Choose an action')}</option><option value="retry">{t('Retry the node')}</option><option value="fail">{t('Mark failed')}</option></select></label>)}
            </fieldset>}
            {detailsOpen && details?.runId === trace.runId ? <FrozenRunGraph details={details} trace={trace} selectedNode={selectedNode} onSelect={selectEvents} onOpenRelated={openTrace} /> : null}
            {trace.outputs === undefined ? null : <details className="wf-history-output"><summary>{t('Run output')}</summary><WorkflowResultView outputs={trace.outputs} /></details>}
            <section className="wf-history-timeline" ref={timeline} aria-label={t('Journal events')} aria-busy={!traceReady && watchIssue === undefined}>
              <div className="wf-history-event-controls">
                <div role="group" aria-label={t('Journal event scope')}>
                  <button type="button" aria-pressed={!failuresOnly} onClick={() => selectEvents(selectedNode, false)}>{t('Recent events')}</button>
                  <button type="button" aria-pressed={failuresOnly} onClick={() => selectEvents(selectedNode, true)}>{t('Only failures')}</button>
                </div>
                <label>{t('Event node')} <select value={selectedNode ?? ''} onChange={event => selectEvents(event.currentTarget.value || undefined)}>
                  <option value="">{t('All nodes')}</option>{Object.keys(trace.nodeStates).sort().map(id => <option key={id} value={id}>{id}</option>)}
                </select></label>
                {failuresOnly ? null : <label className="wf-history-toggle"><input type="checkbox" checked={showInfrastructure}
                  onChange={event => setShowInfrastructure(event.currentTarget.checked)} />{t('Show infrastructure events')}</label>}
              </div>
              {eventViews.length === 0 && watchIssue === undefined ? <p className="wf-history-empty" role="status">
                {traceReady ? t('No events match these filters') : t('Loading matching events…')}</p> : null}
              {traceReady && trace.nextBeforeSeq !== undefined ? <button className="wf-history-more" onClick={() => void readOlder()} disabled={traceBusy || traceReading}
              >{t('Read older events')}</button> : null}
              {eventViews.map(event => <details className="wf-history-event" key={event.seq} data-seq={event.seq} data-tone={event.tone}
                data-focused={focusedEvent?.runId === trace.runId && focusedEvent.seq === event.seq}>
                <summary><code>{event.seq}</code><strong>{event.title}</strong><small title={event.detail}>{event.detail}</small></summary>
                <pre>{JSON.stringify(rawEvents.get(event.seq), null, 2)}</pre>
              </details>)}
            </section>
          </div>
        </>}
      </section>
    </div>
    {newRun === undefined ? null : <NewRunFromHistory details={newRun} mayUseHost={hasHostEffects(newRun.template)}
      onStart={inputs => startNewRun(newRun, inputs)} onClose={() => setNewRun(undefined)} />}
    {auditExport === undefined ? null : <WorkflowAuditExport api={api} sessionId={sessionId} kind={auditExport.kind} runId={auditExport.runId}
      {...(auditExport.details === undefined ? {} : { details: auditExport.details })} onClose={() => setAuditExport(undefined)} />}
    {baseline === undefined || candidate === undefined ? null : <RunComparison api={api} sessionId={sessionId} baseline={baseline}
      candidate={candidate} onClose={() => setCandidate(undefined)} />}
  </section>
}

function describeFailure(trace: CanvasTrace): { readonly nodeId?: string; readonly message?: string; readonly code?: string } {
  const lastFailed = trace.events.findLast(event => event.type === 'node.failed' && typeof event.nodeId === 'string'
    && Object.hasOwn(trace.nodeStates, event.nodeId) && trace.nodeStates[event.nodeId] === 'failed')
  const nodeId = typeof lastFailed?.nodeId === 'string' ? lastFailed.nodeId : Object.keys(trace.nodeStates).find(id => trace.nodeStates[id] === 'failed')
  const terminal = lastFailed ?? trace.events.findLast(event => event.type === 'run.failed')
  const message = typeof terminal?.error === 'string' ? terminal.error : trace.error
  const code = typeof terminal?.errorCode === 'string' ? terminal.errorCode : message?.match(/^([A-Z][A-Z0-9_]{2,}):/u)?.[1]
  return {
    ...(nodeId === undefined ? {} : { nodeId }), ...(message === undefined ? {} : { message }), ...(code === undefined ? {} : { code }),
  }
}

function dateInput(ms: number | undefined): string {
  if (ms === undefined) return ''
  const date = new Date(ms)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

async function readRunJournal(api: WorkflowCanvasClientApi, sessionId: string, runId: string): Promise<Blob> {
  const chunks: string[] = []
  for await (const page of runJournalPages(api, sessionId, runId)) {
    if (chunks.length === 0) chunks.push(`${JSON.stringify({
      format: 'agent-dag-workflow.journal/v1', type: 'run.snapshot', runId, ref: runRef(page), semanticHash: page.semanticHash,
      status: page.status, createdAt: page.createdAt, updatedAt: page.updatedAt, checkpointSeq: page.checkpointSeq,
      outputs: page.outputs, error: page.error,
    })}\n`)
    if (page.events.length > 0) chunks.push(`${page.events.map(event => JSON.stringify(event)).join('\n')}\n`)
  }
  return new Blob(chunks, { type: 'application/x-ndjson;charset=utf-8' })
}

async function* runJournalPages(api: WorkflowCanvasClientApi, sessionId: string, runId: string): AsyncGenerator<CanvasTrace> {
  let throughSeq: number | undefined
  let afterSeq = 0
  do {
    const page = await api.request('workflowCanvas.trace', () => api.remote.trace(sessionId, {
      runId, limit: 100, afterSeq, ...(throughSeq === undefined ? {} : { throughSeq, eventsOnly: true }),
    }), { retries: 1 })
    if (page.runId !== runId) throw new Error('The journal page did not match this run.')
    throughSeq ??= page.checkpointSeq
    const previousSeq = afterSeq
    for (const event of page.events) {
      if (event.seq !== afterSeq + 1 || event.seq > throughSeq) throw new Error('The journal changed while it was being exported. Refresh the run and try again.')
      afterSeq = event.seq
    }
    if (afterSeq < throughSeq && (afterSeq === previousSeq || page.nextAfterSeq !== afterSeq)) {
      throw new Error('The journal export could not read every event. Refresh the run and try again.')
    }
    yield page
  } while (afterSeq < throughSeq)
}

function runRef(trace: Pick<CanvasTrace, 'templateId' | 'revision'>): string {
  return trace.revision === undefined ? trace.templateId : `${trace.templateId}@${trace.revision}`
}

const HISTORY_CSS = String.raw`
.wf-studio[data-surface=history]>.wf-palette,.wf-studio[data-surface=history]>.wf-canvas,.wf-studio[data-surface=history]>.wf-inspector,.wf-studio[data-surface=history]>.wf-trace{display:none}
.wf-history{grid-row:2/4;grid-column:1/-1;min-width:0;min-height:0;display:flex;flex-direction:column;gap:12px;padding:clamp(14px,2.4vw,34px);background:var(--wf-bg);color:var(--wf-text)}
.wf-history-title,.wf-history-workspace,.wf-history>.wf-history-error{width:100%;max-width:1320px;margin:0 auto}.wf-history-title,.wf-history-detail-head{display:flex;align-items:center;justify-content:space-between;gap:14px}.wf-history-title h1{margin:0;font-size:24px;font-weight:700;letter-spacing:-.03em}
.wf-history-workspace{flex:1;min-height:0;display:grid;grid-template-columns:minmax(290px, .8fr) minmax(310px,1.2fr);gap:14px}.wf-history-list,.wf-history-detail{display:flex;min-width:0;min-height:0;flex-direction:column;border:1px solid var(--wf-border);border-radius:13px;background:var(--wf-surface);overflow:hidden}
.wf-history button,.wf-history select{border:1px solid var(--wf-border);border-radius:7px;padding:6px 10px;background:var(--wf-surface);color:var(--wf-text);font:inherit;font-size:11px}.wf-history button:hover:not(:disabled){background:var(--wf-surface-hover);border-color:var(--wf-brand)}
.wf-history-open{display:flex;gap:8px;align-items:end;padding:12px 13px 9px}.wf-history-open label{display:grid;gap:4px;flex:1;min-width:0;font-size:10px;color:var(--wf-muted)}.wf-history-open input{min-width:0;width:100%;box-sizing:border-box;border:1px solid var(--wf-border);border-radius:7px;padding:6px 9px;background:var(--wf-bg);color:var(--wf-text);font:11px/1.4 var(--ds-font-family-code),monospace}
.wf-history-filters{display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:13px;border-bottom:1px solid var(--wf-border)}.wf-history-filters label{display:flex;align-items:center;gap:6px;font-size:10px;color:var(--wf-muted)}
.wf-compare-baseline{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 13px;border-bottom:1px solid var(--wf-border);background:var(--wf-surface-soft);font-size:11px}.wf-compare-baseline span,.wf-compare-baseline code{overflow-wrap:anywhere}
.wf-history-audit{font-size:11px}.wf-history-audit summary{cursor:pointer;min-height:28px;padding:5px 8px;border:1px solid var(--wf-border);border-radius:7px}.wf-history-audit>div{display:flex;flex-wrap:wrap;gap:6px;margin:5px 0 0}
.wf-history-scroll{min-height:0;overflow:auto;padding:7px 12px 12px}.wf-history .wf-history-row{width:100%;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;text-align:left;border-color:transparent;background:transparent;padding:11px 9px}.wf-history .wf-history-row+.wf-history-row{border-top-color:var(--wf-border)}.wf-history .wf-history-row[aria-pressed=true]{border-color:var(--wf-brand);background:var(--wf-surface-hover)}.wf-history-row>span{display:grid;gap:5px;min-width:0}.wf-history-row>span:last-child{text-align:right}.wf-history-row strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.wf-history-row code,.wf-history-row time{font-size:10px;color:var(--wf-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wf-history-status[data-status=completed]{color:var(--wf-success)}.wf-history-status[data-status=failed]{color:var(--wf-danger)}.wf-history-status[data-status=paused],.wf-history-status[data-status=running]{color:var(--wf-warning)}.wf-history-empty{margin:24px;text-align:center;font-size:12px;color:var(--wf-muted)}
.wf-history-detail-head{padding:13px;border-bottom:1px solid var(--wf-border);flex-wrap:wrap}.wf-history-header-actions{display:flex;gap:6px}.wf-history-detail h2{font-size:15px;margin:0 0 3px}.wf-history-detail-head code,.wf-history-records dt{color:var(--wf-muted);font-size:10px}.wf-history-copy{color:var(--wf-success);font-size:11px}
.wf-history-records dl{display:flex;flex-wrap:wrap;gap:12px 22px;margin:8px 0 13px}.wf-history-records dl>div{display:grid;gap:4px}.wf-history-records dd{font-size:11px;margin:0}.wf-history-toggle{display:flex;align-items:center;gap:6px;margin:11px 0 8px;font-size:11px;color:var(--wf-muted)}.wf-history-toggle input{accent-color:var(--wf-brand)}
.wf-history-failure{display:grid;gap:10px;margin:0 0 12px;padding:10px 11px;border:1px solid var(--wf-border);border-left:3px solid var(--wf-danger);border-radius:8px;background:var(--wf-surface-soft);overflow-wrap:anywhere}.wf-history-failure h3{display:flex;flex-wrap:wrap;align-items:baseline;gap:7px;font-size:13px;margin:0;color:var(--wf-danger)}.wf-history-failure h3>code{font-size:11px}.wf-history-failure p{font-size:11px;margin:4px 0 0}.wf-history-failure .wf-history-failure-advice{color:var(--wf-muted)}.wf-history-error-code{display:inline-block;font-size:10px;color:var(--wf-danger);margin-top:4px}.wf-history-failure-actions{display:flex;flex-wrap:wrap;gap:6px}
.wf-history-event-controls{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:8px 0;border-top:1px solid var(--wf-border);margin-top:9px}.wf-history-event-controls>div{display:flex;gap:3px}.wf-history-event-controls label{display:flex;align-items:center;gap:5px;color:var(--wf-muted);font-size:11px;margin:0}.wf-history-event-controls button[aria-pressed=true]{border-color:var(--wf-brand);color:var(--wf-brand);background:var(--wf-surface-hover)}.wf-history-event[data-focused=true]{outline:2px solid var(--wf-brand);outline-offset:1px}.wf-history-watch-error{margin:9px;padding:9px;display:flex;align-items:flex-start;gap:7px;justify-content:space-between;border:1px solid var(--wf-border);border-radius:7px;font-size:11px;overflow-wrap:anywhere}.wf-history-watch-error p{margin:4px 0}.wf-history-watch-error small{color:var(--wf-muted)}.wf-history-replay{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:11px}
.wf-history-output,.wf-history-event{padding:8px;border:1px solid var(--wf-border);border-radius:7px;background:var(--wf-surface-soft);font-size:11px;margin-bottom:5px}.wf-history-event[data-tone=danger]{border-left:3px solid var(--wf-danger)}.wf-history-event summary{display:grid;grid-template-columns:32px minmax(0,1.2fr) minmax(0,1fr);gap:6px;cursor:pointer}.wf-history-event summary>*{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.wf-history-event code{color:var(--wf-brand)}.wf-history-event small{color:var(--wf-muted)}.wf-history-records pre{margin:7px 0 0;padding:8px;max-height:220px;overflow:auto;background:var(--wf-surface);border-radius:5px;white-space:pre-wrap;overflow-wrap:anywhere;font:10px/1.5 var(--ds-font-family-code),monospace}.wf-history-error{font-size:11px;color:var(--wf-danger);overflow-wrap:anywhere}.wf-history .wf-history-more{display:block;margin:9px auto 0}
@media(max-width:660px){.wf-history-workspace{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(135px,.75fr) minmax(150px,1fr)}}
`
