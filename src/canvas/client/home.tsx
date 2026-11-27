import { useEffect, useMemo, useState } from 'react'
import type { CanvasCatalogSummary, CanvasRunHistoryItem } from '../types.js'
import type { WorkflowCanvasClientApi } from './api.js'
import { useCanvasCopy } from './locale.js'
import { runStatusLabel } from './ux.js'

export interface CanvasHomeScope {
  readonly sessionId: string
  readonly authorityRef?: string
  readonly storage?: { readonly kind: 'sqlite' | 'memory'; readonly path?: string }
}

export function WorkflowHome({ api, scope, catalog, favorites, lastOpened, busy, onOpenDraft, onRunPublished, onOpenRun,
  onOrders, onEcho, onNew, onAgent }: {
  readonly api: WorkflowCanvasClientApi
  readonly scope: CanvasHomeScope
  readonly catalog: readonly CanvasCatalogSummary[]
  readonly favorites: readonly string[]
  readonly lastOpened?: string
  readonly busy: boolean
  readonly onOpenDraft: (id: string) => void
  readonly onRunPublished: (id: string, revision: number) => void
  readonly onOpenRun: (runId: string) => void
  readonly onOrders: () => void
  readonly onEcho: () => void
  readonly onNew: () => void
  readonly onAgent: () => void
}) {
  const { language, t } = useCanvasCopy()
  const { sessionId } = scope
  const [runs, setRuns] = useState<readonly CanvasRunHistoryItem[]>([])
  const [recentRuns, setRecentRuns] = useState<readonly CanvasRunHistoryItem[]>([])
  const [listState, setListState] = useState<'loading' | 'ready' | 'partial'>('loading')
  const [refresh, setRefresh] = useState(0)
  const [query, setQuery] = useState('')
  const visibleDrafts = useMemo(() => {
    const terms = query.trim().toLocaleLowerCase()
    return catalog.filter(item => terms === '' || [item.id, item.name].some(value => value.toLocaleLowerCase().includes(terms)))
      .sort((a, b) => Number(b.id === lastOpened) - Number(a.id === lastOpened)
        || Number(favorites.includes(b.id)) - Number(favorites.includes(a.id)) || b.updatedAt - a.updatedAt)
  }, [catalog, favorites, lastOpened, query])
  const recent = query === '' ? visibleDrafts.slice(0, 8) : visibleDrafts
  const favoriteRuns = catalog.filter(item => item.publishedRevision !== undefined && favorites.includes(item.id)).slice(0, 8)

  useEffect(() => {
    let open = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      const results = await Promise.allSettled((['running', 'paused', undefined] as const).map(status =>
        api.request('workflowCanvas.listRuns', () => api.remote.listRuns(sessionId, { ...(status === undefined ? {} : { status }), limit: 8 }), { retries: 1 })))
      if (!open) return
      const records = new Map<string, CanvasRunHistoryItem>()
      for (const result of results.slice(0, 2)) if (result.status === 'fulfilled') for (const item of result.value.items) records.set(item.runId, item)
      setRuns([...records.values()].sort((a, b) => Number(b.needsAttention) - Number(a.needsAttention) || b.updatedAt - a.updatedAt))
      const recentResult = results[2]
      if (recentResult?.status === 'fulfilled') setRecentRuns(recentResult.value.items.filter(item => item.status !== 'running' && item.status !== 'paused'))
      setListState(results.every(result => result.status === 'fulfilled') ? 'ready' : 'partial')
      timer = setTimeout(() => { if (open) void load() }, 15_000)
    }
    void load()
    return () => { open = false; if (timer !== undefined) clearTimeout(timer) }
  }, [api, refresh, sessionId])

  return <main className="wf-home" aria-label={t('My workflows')}>
    <style>{HOME_CSS}</style>
    <div className="wf-home-inner">
      <header className="wf-home-header">
        <div><h1>{t('My workflows')}</h1><p>{t('Pick up a draft, open a running workflow, or start from an example.')}</p></div>
        <button className="wf-primary" onClick={onNew} disabled={busy}>{t('New workflow')}</button>
      </header>
      <details className="wf-home-context"><summary>{t('Current DSH session')} <code>{sessionId}</code></summary>
        {scope.authorityRef === undefined ? null : <p>{t('Authority')} <code>{scope.authorityRef}</code></p>}
        {scope.storage === undefined ? null : <p>{t('Storage')} <code>{scope.storage.kind}</code> {scope.storage.path === undefined ? null : <code>{scope.storage.path}</code>}</p>}
      </details>
      <div className="wf-home-grid">
        <section>
          <header><h2>{t('Recent drafts')}</h2><label>{t('Find a workflow')}<input type="search" value={query} onChange={event => setQuery(event.currentTarget.value)} /></label></header>
          {recent.length === 0 ? <p>{t(query === '' ? 'No drafts yet' : 'No workflows match your search')}</p> : <ul>{recent.map(item => <li key={item.id}>
            <span><b>{favorites.includes(item.id) ? '★ ' : ''}{item.name}</b><small>{item.id} · {t('Draft revision {revision}', { revision: item.draftRevision })}</small></span>
            <button disabled={busy} aria-label={t('Edit draft {workflow}', { workflow: item.name })} onClick={() => onOpenDraft(item.id)}>{t('Edit draft')}</button>
            {item.publishedRevision === undefined ? null : <button disabled={busy} aria-label={t('Run {workflow} at revision {revision}', { workflow: item.name, revision: item.publishedRevision })}
              onClick={() => onRunPublished(item.id, item.publishedRevision!)}>{t('Run revision {revision}', { revision: item.publishedRevision })}</button>}
          </li>)}</ul>}
        </section>
        <section>
          <header><h2>{t('Active and pending runs')}</h2><button disabled={listState === 'loading'} onClick={() => { setListState('loading'); setRefresh(value => value + 1) }}>{t('Refresh runs')}</button></header>
          {listState === 'loading' && runs.length === 0 ? <p role="status">{t('Checking for active runs…')}</p> : null}
          {listState === 'partial' ? <p role="status">{t('Some run statuses could not be loaded.')}</p> : null}
          {listState === 'ready' && runs.length === 0 ? <p>{t('No active or pending runs')}</p> : null}
          {runs.length === 0 ? null : <ul>{runs.slice(0, 8).map(run => <li key={run.runId}><span>
            <b>{run.templateName}{run.revision === undefined ? '' : ` @${run.revision}`}</b>
            <small>{run.needsAttention ? t('Needs attention') : run.status === 'running' && run.active === false ? t('Interrupted') : runStatusLabel(run.status, language)} · <code>{run.runId}</code></small></span>
            <button disabled={busy} aria-label={t('Open run {runId}', { runId: run.runId })} onClick={() => onOpenRun(run.runId)}>{t('Open run')}</button></li>)}</ul>}
        </section>
        {recentRuns.length === 0 ? null : <section aria-label={t('Recent finished runs')}>
          <header><h2>{t('Recent finished runs')}</h2></header>
          <ul>{recentRuns.slice(0, 5).map(run => <li key={run.runId}><span>
            <b>{run.templateName}{run.revision === undefined ? '' : ` @${run.revision}`}</b>
            <small>{runStatusLabel(run.status, language)} · <code>{run.runId}</code></small></span>
            <button disabled={busy} aria-label={t('Review run {runId}', { runId: run.runId })} onClick={() => onOpenRun(run.runId)}>{t('Open run')}</button></li>)}</ul>
        </section>}
        {favoriteRuns.length === 0 ? null : <section>
          <header><h2>{t('Favorite published workflows')}</h2></header>
          <ul>{favoriteRuns.map(item => <li key={item.id}><span><b>{item.name}</b><small><code>{item.id}@{item.publishedRevision}</code></small></span>
            <button disabled={busy} onClick={() => onRunPublished(item.id, item.publishedRevision!)} aria-label={t('Run favorite {workflow} at revision {revision}', { workflow: item.name, revision: item.publishedRevision! })}>
              {t('Run revision {revision}', { revision: item.publishedRevision! })}</button></li>)}</ul>
        </section>}
        <section>
          <header><h2>{t('Try a workflow')}</h2></header>
          <ul><li><span><b>{t('Order normalization')}</b><small>{t('Process three orders with local nodes and inspect the saved result.')}</small></span>
            <button className="wf-primary" disabled={busy} onClick={onOrders}>{t('Open order example')}</button></li>
          <li><span><b>{t('Echo a message')}</b><small>{t('A two-node echo workflow that runs without external tools')}</small></span>
            <button disabled={busy} onClick={onEcho}>{t('Start with a runnable example')}</button></li>
          <li><span><b>{t('Create with an agent')}</b><small>{t('Copy a prompt for the workflow-builder skill')}</small></span>
            <button disabled={busy} onClick={onAgent}>{t('Copy agent prompt')}</button></li></ul>
        </section>
      </div>
    </div>
  </main>
}

const HOME_CSS = String.raw`
.wf-studio[data-surface=home]>.wf-palette,.wf-studio[data-surface=home]>.wf-canvas,.wf-studio[data-surface=home]>.wf-inspector,.wf-studio[data-surface=home]>.wf-trace{display:none}
.wf-home{grid-row:2/4;grid-column:1/-1;min-width:0;min-height:0;overflow:auto;background:var(--wf-bg);color:var(--wf-text);padding:clamp(16px,3vw,44px)}
.wf-home-inner{max-width:1200px;margin:0 auto}.wf-home-header,.wf-home-grid header{display:flex;align-items:center;justify-content:space-between;gap:12px}.wf-home h1{margin:0;font-size:clamp(24px,3vw,34px);letter-spacing:-.04em}.wf-home p{margin:6px 0;color:var(--wf-muted);font-size:12px}
.wf-home button{padding:7px 10px;border:1px solid var(--wf-border);border-radius:7px;color:var(--wf-text);background:var(--wf-surface);font:inherit;font-size:11px;cursor:pointer}.wf-home button.wf-primary{background:var(--wf-brand);border-color:var(--wf-brand);color:#fff}.wf-home button:disabled{opacity:.55;cursor:not-allowed}.wf-home button:hover:not(:disabled){border-color:var(--wf-brand)}
.wf-home-context{width:fit-content;max-width:100%;margin:13px 0 19px;font-size:11px;overflow-wrap:anywhere;color:var(--wf-muted)}.wf-home-context summary{cursor:pointer}.wf-home-context code{color:var(--wf-brand)}
.wf-home-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:start;gap:14px}.wf-home-grid>section{min-width:0;padding:14px 16px;border:1px solid var(--wf-border);border-radius:12px;background:var(--wf-surface)}.wf-home-grid h2{margin:0;font-size:15px}.wf-home-grid header label{display:grid;gap:3px;color:var(--wf-muted);font-size:10px}.wf-home-grid input{max-width:165px;width:100%;padding:5px 7px;border:1px solid var(--wf-border);border-radius:6px;color:var(--wf-text);background:var(--wf-surface-soft)}
.wf-home-grid ul{margin:10px 0 0;padding:0;list-style:none}.wf-home-grid li{display:flex;align-items:center;gap:6px;margin:0;padding:9px 0;border-top:1px solid var(--wf-border)}.wf-home-grid li>span{display:grid;min-width:0;gap:4px;flex:1}.wf-home-grid li b{font-size:12px;overflow-wrap:anywhere}.wf-home-grid li small{color:var(--wf-muted);font-size:10px;overflow-wrap:anywhere}
@media(max-width:820px){.wf-home-grid{grid-template-columns:minmax(0,1fr)}}@media(max-width:500px){.wf-home-grid li{align-items:flex-start;flex-wrap:wrap}.wf-home-grid li>span{flex-basis:100%}}
`
