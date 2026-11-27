import { useEffect, useMemo, useRef, useState } from 'react'
import type { CanvasJsonObject, CanvasPublishedRevision, CanvasRevisionSummary, CanvasWorkflowDiagnostic, CanvasWorkflowTemplate } from '../types.js'
import type { WorkflowCanvasClientApi } from './api.js'
import { RunInputForm, runInputFields } from './input-form.js'
import { useCanvasCopy } from './locale.js'
import { parseJsonObject, readPublishedInputs, writePublishedInputs } from './personal.js'
import { classifyWorkflowError, diagnosticTitle } from './ux.js'

export function WorkflowRevisions({ api, sessionId, workflowId, template, initialInputs, fixedRevision, actionError, busy, hasHostEffects, onRun, onClose }: {
  readonly api: WorkflowCanvasClientApi
  readonly sessionId: string
  readonly workflowId: string
  readonly template: CanvasWorkflowTemplate
  readonly initialInputs: string
  readonly fixedRevision?: number
  readonly actionError?: string
  readonly busy: boolean
  readonly hasHostEffects: (template: CanvasWorkflowTemplate) => boolean
  readonly onRun: (revision: CanvasPublishedRevision, inputs: CanvasJsonObject) => Promise<readonly CanvasWorkflowDiagnostic[] | undefined>
  readonly onClose: () => void
}) {
  const { language, t } = useCanvasCopy()
  const dialog = useRef<HTMLDialogElement>(null)
  const [items, setItems] = useState<readonly CanvasRevisionSummary[]>([])
  const [before, setBefore] = useState<number>()
  const [selected, setSelected] = useState<CanvasPublishedRevision>()
  const [compare, setCompare] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [inputs, setInputs] = useState(initialInputs)
  const [form, setForm] = useState<CanvasJsonObject>()
  const [diagnostics, setDiagnostics] = useState<readonly CanvasWorkflowDiagnostic[]>([])
  const [savedInputVersion, setSavedInputVersion] = useState(0)
  const [inputsNotice, setInputsNotice] = useState<string>()
  useEffect(() => {
    dialog.current?.showModal()
    let closed = false
    const request = fixedRevision === undefined
      ? api.request('workflowCanvas.revisions', () => api.remote.revisions(sessionId, { id: workflowId }), { retries: 1 })
          .then(page => { if (!closed) { setItems(page.items); setBefore(page.nextBefore) } })
      : api.request('workflowCanvas.readPublished', () => api.remote.readPublished(sessionId, { id: workflowId, revision: fixedRevision }), { retries: 1 })
          .then(revision => { if (!closed) setSelected(revision) })
    void request
      .catch((cause: unknown) => { if (!closed) setError(classifyWorkflowError(cause).detail) })
      .finally(() => { if (!closed) setLoading(false) })
    return () => { closed = true; dialog.current?.close() }
  }, [api, fixedRevision, sessionId, workflowId])

  const loadEarlier = async () => {
    if (before === undefined) return
    setLoading(true)
    setError(undefined)
    try {
      const page = await api.request('workflowCanvas.revisions', () => api.remote.revisions(sessionId, { id: workflowId, before }), { retries: 1 })
      setItems(current => [...current, ...page.items])
      setBefore(page.nextBefore)
    } catch (cause: unknown) { setError(classifyWorkflowError(cause).detail) }
    finally { setLoading(false) }
  }

  const choose = async (revision: number) => {
    setLoading(true)
    setError(undefined)
    setSelected(undefined)
    setDiagnostics([])
    setInputsNotice(undefined)
    try {
      const value = await api.request('workflowCanvas.readPublished', () => api.remote.readPublished(sessionId, { id: workflowId, revision }), { retries: 1 })
      setSelected(value)
    } catch (cause: unknown) { setError(classifyWorkflowError(cause).detail) }
    finally { setLoading(false) }
  }

  const date = new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en', { dateStyle: 'medium', timeStyle: 'short' })
  const fields = selected === undefined ? [] : runInputFields(selected.template.spec.inputSchema)
  const ref = selected === undefined ? undefined : `${selected.id}@${selected.revision}`
  const storedInputs = useMemo(() => selected === undefined ? undefined : readPublishedInputs(sessionId, selected.id, selected.revision),
    [savedInputVersion, selected, sessionId])
  const readInputs = () => {
    const value = parseJsonObject(inputs)
    setError(value === undefined ? t('Run input must be a valid JSON object.') : undefined)
    return value
  }
  const start = async () => {
    const value = readInputs()
    if (selected === undefined || value === undefined) return
    const issues = await onRun(selected, value)
    setDiagnostics(issues ?? [])
  }
  const persistInputs = (clear = false) => {
    if (selected === undefined) return
    const value = clear ? undefined : readInputs()
    if (!clear && value === undefined) return
    try {
      writePublishedInputs(sessionId, selected.id, selected.revision, value)
      setSavedInputVersion(current => current + 1)
      setInputsNotice(t(clear ? 'Saved revision inputs cleared' : 'Revision inputs saved on this device'))
    } catch (cause: unknown) { setError(classifyWorkflowError(cause).detail) }
  }
  return <><dialog ref={dialog} className="wf-modal wf-input-form wf-revisions" aria-labelledby="wf-revisions-title" onCancel={onClose}>
    <h2 id="wf-revisions-title">{t(fixedRevision === undefined ? 'Published revisions' : 'Run published revision')}</h2>
    {error === undefined && actionError === undefined ? null : <p role="alert">{error ?? actionError}</p>}
    {fixedRevision === undefined ? <label>{t('Exact revision')}<select disabled={loading || busy} value={selected?.revision ?? ''}
      onChange={event => void choose(Number(event.currentTarget.value))}>
      <option value="" disabled>{t('Select a published revision…')}</option>
      {items.map(item => <option key={item.revision} value={item.revision}>{workflowId}@{item.revision} · {date.format(item.publishedAt)}</option>)}
    </select></label> : null}
    {before === undefined ? null : <button disabled={loading || busy} onClick={() => void loadEarlier()}>{t('Older revisions')}</button>}
    {selected === undefined ? null : <>
      <h3>{selected.template.metadata.name} <code>{ref}</code></h3>
      <p className="wf-run-effects" data-host-effects={hasHostEffects(selected.template)}>{t(hasHostEffects(selected.template) ? 'Run may call real Host tools or agents.' : 'Run uses only local workflow nodes.')}</p>
      <label>{t('Published run input JSON')}<textarea value={inputs} onChange={event => {
        setInputs(event.currentTarget.value)
        setDiagnostics([])
        setError(undefined)
      }} disabled={busy} spellCheck={false} /></label>
      {fields.length === 0 ? null : <button onClick={() => setForm(readInputs())} disabled={busy}>{t('Input form')}</button>}
      <details className="wf-revision-presets" open={fixedRevision !== undefined ? true : undefined}>
        <summary>{t('Inputs on this device')}</summary>
        <p>{t('Inputs saved here are only for this exact revision and DSH session.')}</p>
        <button type="button" disabled={busy} onClick={() => persistInputs()}>{t('Remember these revision inputs')}</button>
        {storedInputs === undefined ? null : <><button type="button" disabled={busy} onClick={() => {
          setInputs(JSON.stringify(storedInputs, null, 2)); setDiagnostics([]); setError(undefined)
        }}>{t('Use last saved revision inputs')}</button>
          <button type="button" disabled={busy} onClick={() => persistInputs(true)}>{t('Forget revision inputs')}</button></>}
        {inputsNotice === undefined ? null : <p role="status">{inputsNotice}</p>}
      </details>
      {diagnostics.length === 0 ? null : <ul className="wf-revision-issues" role="alert">{diagnostics.map((item, index) =>
        <li key={index}><strong>{diagnosticTitle(item, language)}</strong> {item.message}</li>)}</ul>}
      <details><summary>{t('Input schema')}</summary><pre>{JSON.stringify(selected.template.spec.inputSchema, null, 2)}</pre></details>
      <details><summary>{t('Declared capabilities')}</summary><pre>{JSON.stringify(selected.template.spec.requires ?? [], null, 2)}</pre></details>
      {selected.id !== template.metadata.id ? null : <button onClick={() => setCompare(value => !value)} aria-expanded={compare}>{t('Compare with current draft')}</button>}
      {compare && selected.id === template.metadata.id ? <RevisionChanges published={selected.template} draft={template} /> : null}
    </>}
    <footer><button type="button" onClick={onClose}>{t('Close')}</button>
      <button type="button" className="wf-primary" disabled={selected === undefined || loading || busy}
        onClick={() => void start()}>{t('Run published revision')}</button></footer>
  </dialog>
  {form === undefined || ref === undefined ? null : <RunInputForm inputs={form} fields={fields} title={t('Inputs for {workflow}', { workflow: ref })}
    onCancel={() => setForm(undefined)} onApply={value => {
      setInputs(JSON.stringify(value, null, 2))
      setDiagnostics([])
      setForm(undefined)
    }} />}
  </>
}

function RevisionChanges({ published, draft }: { readonly published: CanvasWorkflowTemplate; readonly draft: CanvasWorkflowTemplate }) {
  const { t } = useCanvasCopy()
  const nodes = changes(published.spec.nodes, draft.spec.nodes)
  const edges = changes(published.spec.edges, draft.spec.edges)
  const contracts = JSON.stringify([published.spec.inputSchema, published.spec.outputSchema, published.spec.outputs, published.spec.requires])
    !== JSON.stringify([draft.spec.inputSchema, draft.spec.outputSchema, draft.spec.outputs, draft.spec.requires])
  return <div className="wf-revision-changes">
    <p>{t('Nodes')} <code>+{nodes.added.length} −{nodes.removed.length} ~{nodes.changed.length}</code> · {t('Edges')} <code>+{edges.added.length} −{edges.removed.length} ~{edges.changed.length}</code></p>
    {contracts ? <p>{t('Input, output, or capability contracts changed')}</p> : null}
    <div><details><summary>{t('Published workflow JSON')}</summary><pre>{JSON.stringify(published, null, 2)}</pre></details>
      <details><summary>{t('Current draft JSON')}</summary><pre>{JSON.stringify(draft, null, 2)}</pre></details></div>
  </div>
}

function changes<T extends { readonly id: string }>(before: readonly T[], after: readonly T[]) {
  const original = new Map(before.map(item => [item.id, item]))
  const candidate = new Map(after.map(item => [item.id, item]))
  return {
    added: after.filter(item => !original.has(item.id)),
    removed: before.filter(item => !candidate.has(item.id)),
    changed: after.filter(item => original.has(item.id) && JSON.stringify(original.get(item.id)) !== JSON.stringify(item)),
  }
}
