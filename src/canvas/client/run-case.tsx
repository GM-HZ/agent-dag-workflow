import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { CanvasRunDetails } from '../types.js'
import type { WorkflowCanvasClientApi } from './api.js'
import { useCanvasCopy } from './locale.js'
import { downloadCanvasFile, isObject, parseJsonObject } from './personal.js'
import { classifyWorkflowError } from './ux.js'

export function WorkflowAuditExport({ api, sessionId, runId, details, kind, onClose }: {
  readonly api: WorkflowCanvasClientApi
  readonly sessionId: string
  readonly runId: string
  readonly details?: CanvasRunDetails
  readonly kind: 'case' | 'evidence'
  readonly onClose: () => void
}) {
  const { t } = useCanvasCopy()
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [text, setText] = useState('')
  const [redaction, setRedaction] = useState('')
  const [includeArtifacts, setIncludeArtifacts] = useState(false)
  const [reviewedOptions, setReviewedOptions] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [copied, setCopied] = useState(false)
  const safeRunId = runId.replace(/[^a-zA-Z0-9._-]/g, '_')
  const caseName = `${safeRunId}.case.json`
  const baselineName = `${safeRunId}.baseline.workflow.json`
  const options = JSON.stringify([redaction.trim(), includeArtifacts])
  const stalePreview = options !== reviewedOptions
  const command = `adw case compare ./${caseName} --base ./${baselineName} --candidate ./candidate.workflow.json`

  const load = useCallback(async (fieldList: string, artifacts: boolean, current: () => boolean = () => true) => {
    const redactFields = [...new Set(fieldList.split(',').map(field => field.trim()).filter(Boolean))]
    setLoading(true)
    setError(undefined)
    try {
      const value = kind === 'case'
        ? await api.request('workflowCanvas.exportCase', () => api.remote.exportCase(sessionId, { runId, redactFields }), { retries: 1 })
        : await api.request('workflowCanvas.exportEvidence', () => api.remote.exportEvidence(sessionId, {
            runId, redactFields, includeArtifacts: artifacts,
          }), { retries: 1 })
      if (!current()) return
      setReviewedOptions(JSON.stringify([fieldList.trim(), artifacts]))
      setText(JSON.stringify(value, null, 2))
    } catch (cause: unknown) {
      if (current()) setError(classifyWorkflowError(cause).detail)
    } finally { if (current()) setLoading(false) }
  }, [api, kind, runId, sessionId])
  useEffect(() => {
    const el = dialog.current
    el?.showModal()
    let current = true
    void load('', false, () => current)
    return () => { current = false; el?.close() }
  }, [load])

  const save = () => {
    const value = parseJsonObject(text)
    if (value === undefined || (kind === 'case' && (value.format !== 'agent-dag-workflow.case/v1'
      || typeof value.name !== 'string' || !isObject(value.inputs) || !isObject(value.expected)
      || (value.expected.status !== 'completed' && value.expected.status !== 'failed')))) {
      setError(t('Invalid regression case JSON'))
      return
    }
    downloadCanvasFile(new Blob([JSON.stringify(value, null, 2) + '\n'], { type: 'application/json' }),
      kind === 'case' ? caseName : `${safeRunId}.evidence.json`)
  }

  const saveBaseline = () => {
    if (details === undefined) return
    downloadCanvasFile(new Blob([JSON.stringify(details.template, null, 2) + '\n'], { type: 'application/json' }), baselineName)
  }

  return <dialog ref={dialog} className="wf-modal wf-input-form wf-case-editor" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose() }}>
    <h2 id={titleId}>{t(kind === 'case' ? 'Save regression case' : 'Export run evidence')}</h2>
    <p>{t(kind === 'case' ? 'Create an offline test from this run. Review inputs and recorded results before downloading.' : 'Preview the run evidence and redact selected fields before sharing. It may contain business data.')}</p>
    <form className="wf-export-options" onSubmit={event => { event.preventDefault(); void load(redaction, includeArtifacts) }}>
      <label>{t('Fields to redact, comma-separated')}<input value={redaction} onChange={event => setRedaction(event.currentTarget.value)} disabled={loading} /></label>
      {kind === 'case' ? null : <label className="wf-export-check"><input type="checkbox" checked={includeArtifacts} disabled={loading}
        onChange={event => setIncludeArtifacts(event.currentTarget.checked)} />{t('Include captured artifact content')}</label>}
      <button type="submit" disabled={loading}>{t('Refresh preview')}</button>
    </form>
    {stalePreview && !loading && text.length > 0 ? <p role="status">{t('Refresh the preview to apply export options.')}</p> : null}
    {loading ? <p role="status">{t('Preparing export…')}</p> : null}
    <label>{t(kind === 'case' ? 'Regression case JSON' : 'Evidence JSON')}<textarea value={text} spellCheck={false}
      readOnly={kind === 'evidence'} disabled={loading} aria-invalid={error !== undefined}
      onChange={event => { setText(event.currentTarget.value); setError(undefined) }} /></label>
    {error === undefined ? null : <p role="alert">{error}</p>}
    {kind === 'case' && details !== undefined ? <details className="wf-case-cli">
      <summary>{t('Compare with the CLI')}</summary>
      <p>{t('Save the baseline and case next to candidate.workflow.json, then run this command. The baseline contains the saved workflow definition.')}</p>
      <p className="wf-run-effects" data-host-effects="true">{t('The exact baseline contains raw workflow values such as literals and prompts. Review it separately before sharing.')}</p>
      <code>{command}</code>
      <div><button type="button" onClick={saveBaseline}>{t('Download baseline workflow')}</button>
        <button type="button" onClick={() => void navigator.clipboard.writeText(command).then(() => { setCopied(true); setError(undefined) })
          .catch((cause: unknown) => setError(classifyWorkflowError(cause).detail))}>{t('Copy compare command')}</button></div>
      {copied ? <p role="status">{t('Compare command copied')}</p> : null}
    </details> : null}
    <footer><button type="button" onClick={onClose}>{t('Close')}</button>
      <button type="button" className="wf-primary" disabled={loading || stalePreview || text.length === 0}
        onClick={save}>{t(kind === 'case' ? 'Download test case' : 'Download evidence')}</button></footer>
  </dialog>
}
