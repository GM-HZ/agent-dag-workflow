import { useEffect, useId, useRef, useState } from 'react'
import type { CanvasJsonObject, CanvasJsonValue, CanvasRunDetails, CanvasTrace, CanvasWorkflowDiagnostic } from '../types.js'
import type { WorkflowCanvasClientApi } from './api.js'
import { RunInputForm, runInputFields } from './input-form.js'
import { useCanvasCopy } from './locale.js'
import { isObject, parseJsonObject } from './personal.js'
import { classifyWorkflowError, diagnosticTitle, runStatusLabel } from './ux.js'

export type NewRunResult = { readonly runId?: string; readonly diagnostics: readonly CanvasWorkflowDiagnostic[] }

export function NewRunFromHistory({ details, mayUseHost, onStart, onClose }: {
  readonly details: CanvasRunDetails
  readonly mayUseHost: boolean
  readonly onStart: (inputs: CanvasJsonObject) => Promise<NewRunResult>
  readonly onClose: () => void
}) {
  const { language, t } = useCanvasCopy()
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const input = useRef<HTMLTextAreaElement>(null)
  const [text, setText] = useState(() => JSON.stringify(details.inputs, null, 2))
  const [form, setForm] = useState<CanvasJsonObject>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [diagnostics, setDiagnostics] = useState<readonly CanvasWorkflowDiagnostic[]>([])
  useEffect(() => {
    const el = dialog.current
    el?.showModal()
    input.current?.focus()
    return () => { el?.close() }
  }, [])
  const fields = runInputFields(details.template.spec.inputSchema)
  const source = details.revision === undefined ? t('Draft snapshot') : `${details.template.metadata.id}@${details.revision}`
  const getInputs = () => {
    const value = parseJsonObject(text)
    setError(value === undefined ? t('Run input must be a valid JSON object.') : undefined)
    if (value === undefined) input.current?.focus()
    return value
  }
  const start = async () => {
    const inputs = getInputs()
    if (inputs === undefined) return
    setBusy(true)
    try {
      const result = await onStart(inputs)
      setDiagnostics(result.diagnostics)
    } catch (cause: unknown) {
      setError(classifyWorkflowError(cause).detail)
    } finally { setBusy(false) }
  }

  return <><dialog ref={dialog} className="wf-modal wf-input-form wf-revisions" aria-labelledby={titleId} onCancel={event => {
    event.preventDefault()
    if (!busy) onClose()
  }}>
    <h2 id={titleId}>{t('New run with these inputs')}</h2>
    <h3>{details.template.metadata.name} <code>{source}</code></h3>
    <p>{t('A new run starts from the beginning using this saved workflow snapshot.')}</p>
    <p className="wf-run-effects" data-host-effects={mayUseHost}>{t(mayUseHost ? 'Run may call real Host tools or agents.' : 'Run uses only local workflow nodes.')}</p>
    <label>{t('New run input JSON')}<textarea ref={input} value={text} disabled={busy} spellCheck={false} aria-invalid={error !== undefined}
      onChange={event => { setText(event.currentTarget.value); setDiagnostics([]); setError(undefined) }} /></label>
    {fields.length === 0 ? null : <button type="button" disabled={busy} onClick={() => setForm(getInputs())}>{t('Input form')}</button>}
    {error === undefined ? null : <p role="alert">{error}</p>}
    {diagnostics.length === 0 ? null : <ul className="wf-revision-issues" role="alert">{diagnostics.map((issue, index) =>
      <li key={index}><strong>{diagnosticTitle(issue, language)}</strong> {issue.message}</li>)}</ul>}
    <footer><button type="button" disabled={busy} onClick={onClose}>{t('Cancel')}</button>
      <button type="button" className="wf-primary" disabled={busy} onClick={() => void start()}>{t('Start new run')}</button></footer>
  </dialog>
  {form === undefined ? null : <RunInputForm inputs={form} fields={fields} title={t('Inputs for {workflow}', { workflow: source })}
    onCancel={() => setForm(undefined)} onApply={value => { setText(JSON.stringify(value, null, 2)); setDiagnostics([]); setForm(undefined) }} />}
  </>
}

interface ComparedRun {
  readonly details: CanvasRunDetails
  readonly trace: CanvasTrace
}

export function RunComparison({ api, sessionId, baseline, candidate, onClose }: {
  readonly api: WorkflowCanvasClientApi
  readonly sessionId: string
  readonly baseline: string
  readonly candidate: string
  readonly onClose: () => void
}) {
  const { language, t } = useCanvasCopy()
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [runs, setRuns] = useState<readonly [ComparedRun, ComparedRun]>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    const el = dialog.current
    el?.showModal()
    return () => { el?.close() }
  }, [])
  useEffect(() => {
    let current = true
    const read = async (runId: string): Promise<ComparedRun> => {
      const [details, trace] = await Promise.all([
        api.request('workflowCanvas.runDetails', () => api.remote.runDetails(sessionId, { runId }), { retries: 1 }),
        api.request('workflowCanvas.trace', () => api.remote.trace(sessionId, { runId, limit: 1 }), { retries: 1 }),
      ])
      if (details.runId !== runId || trace.runId !== runId || !isTerminalRun(trace)) throw new Error('Comparison requires two terminal runs.')
      return { details, trace }
    }
    void Promise.all([read(baseline), read(candidate)])
      .then(result => { if (current) setRuns(result) }).catch((cause: unknown) => { if (current) setError(classifyWorkflowError(cause).detail) })
    return () => { current = false }
  }, [api, baseline, candidate, sessionId])
  const rows: [string, string, string][] = []
  if (runs !== undefined) {
    const [left, right] = runs
    rows.push(
      [t('Workflow'), runLabel(left.details), runLabel(right.details)],
      [t('Status'), runStatusLabel(left.trace.status, language), runStatusLabel(right.trace.status, language)],
      [t('Workflow fingerprint'), left.trace.semanticHash, right.trace.semanticHash],
    )
    const nodeIds = new Set([...Object.keys(left.trace.nodeStates), ...Object.keys(right.trace.nodeStates)])
    for (const id of [...nodeIds].sort()) {
      const before = left.trace.nodeStates[id]
      const after = right.trace.nodeStates[id]
      if (before !== after) rows.push([t('Node {node}', { node: id }), before ?? '—', after ?? '—'])
    }
  }
  return <dialog ref={dialog} className="wf-modal wf-input-form wf-run-compare" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose() }}>
    <h2 id={titleId}>{t('Compare saved runs')}</h2>
    <p>{t('Compare the recorded outcomes of these two runs.')}</p>
    {error === undefined ? null : <p role="alert">{error}</p>}
    {runs === undefined && error === undefined ? <p role="status">{t('Loading run journal…')}</p> : null}
    {runs === undefined ? null : <>
      <div className="wf-run-compare-table"><table><thead><tr><th>{t('Recorded values')}</th>
        <th>{t('Baseline run')}<code>{baseline}</code></th><th>{t('Candidate run')}<code>{candidate}</code></th></tr></thead>
        <tbody>{rows.map(([label, left, right]) => <tr key={label} data-changed={left !== right}><th scope="row">{label}</th><td>{left}</td><td>{right}</td></tr>)}</tbody></table></div>
      <ComparedValue label={t('Run inputs')} left={runs[0].details.inputs} right={runs[1].details.inputs} />
      <ComparedValue label={t('Run output')} left={runs[0].trace.outputs} right={runs[1].trace.outputs} />
    </>}
    <footer><button type="button" onClick={onClose}>{t('Close')}</button></footer>
  </dialog>
}

export function isTerminalRun(trace: Pick<CanvasTrace, 'status'>): boolean {
  return trace.status === 'completed' || trace.status === 'failed' || trace.status === 'cancelled'
}

function ComparedValue({ label, left, right }: { readonly label: string; readonly left: CanvasJsonValue | undefined; readonly right: CanvasJsonValue | undefined }) {
  const { t } = useCanvasCopy()
  const changed = canonical(left) !== canonical(right)
  return <details className="wf-compared-value"><summary>{label} <small>{t(changed ? 'Changed' : 'Same')}</small></summary>
    <div><section aria-label={t('Baseline run')}><pre>{left === undefined ? '—' : JSON.stringify(left, null, 2)}</pre></section>
      <section aria-label={t('Candidate run')}><pre>{right === undefined ? '—' : JSON.stringify(right, null, 2)}</pre></section></div></details>
}

function canonical(value: CanvasJsonValue | undefined): string | undefined {
  return JSON.stringify(value, (_key, child: unknown) => isObject(child)
    ? Object.fromEntries(Object.keys(child).sort().map(key => [key, child[key]])) : child)
}

function runLabel(details: CanvasRunDetails) {
  const id = details.template.metadata.id
  return details.revision === undefined ? id : `${id}@${details.revision}`
}
