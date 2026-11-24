import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import type {
  CanvasCatalogSummary,
  CanvasJsonObject,
  CanvasJsonValue,
  CanvasNodeDefinition,
  CanvasOperationsSnapshot,
  CanvasRunResult,
  CanvasTemplateDiff,
  CanvasTrace,
  CanvasWorkflowDiagnostic,
  CanvasWorkflowDraft,
  CanvasWorkflowNode,
  CanvasWorkflowTemplate,
} from '../types.js'
import { WorkflowCanvasRequestError, type WorkflowCanvasClientApi } from './api.js'
import type { WorkflowCanvasUiTarget } from './controller.js'
import { CanvasLocaleContext, useCanvasCopy, useCanvasLocale } from './locale.js'
import { canvasText, type CanvasLocale, type CanvasMessage, type MessageValues } from './messages.js'
import {
  addNode,
  blankTemplate,
  connectNodes,
  moveNode,
  removeEdge,
  removeNode,
  findNodeDefinition,
  templateToFlow,
  type WorkflowFlowNode,
} from './model.js'
import { workflowNodeRenderers } from './registry.js'
import {
  classifyWorkflowError,
  connectionStateLabel,
  definitionDisplayDescription,
  definitionDisplayTitle,
  definitionGroup,
  diagnosticTitle,
  documentStateLabel,
  hasUnsavedChanges,
  nodeRequirementPresentation,
  parseRecoverySnapshot,
  recoveryStorageKey,
  serializeRecoverySnapshot,
  starterTemplate,
  visibleTraceEvents,
  workflowFailurePresentation,
  type WorkflowConnectionState,
  type WorkflowDocumentState,
  type WorkflowErrorPresentation,
} from './ux.js'

export interface WorkflowStudioProps {
  readonly api: WorkflowCanvasClientApi
  readonly locale?: string
  readonly sessionId: string
  readonly initialTemplate?: CanvasWorkflowTemplate
  readonly initialTarget?: WorkflowCanvasUiTarget
  readonly onClose?: () => void
}

type RightPanel = 'inspector' | 'diagnostics' | 'diff'
type PaletteGroup = 'nodes' | 'tools'

type Activity = { readonly message: CanvasMessage; readonly values?: MessageValues; readonly action?: CanvasMessage }
const nodeTypes = { workflow: WorkflowNodeView }

export function WorkflowStudio({ api, sessionId, initialTemplate, initialTarget, onClose, locale }: WorkflowStudioProps) {
  const language = useCanvasLocale(locale)
  const t = canvasText(language)
  const graphLabels = useMemo(() => ({
    'controls.ariaLabel': t('Canvas controls'),
    'controls.zoomIn.ariaLabel': t('Zoom in'),
    'controls.zoomOut.ariaLabel': t('Zoom out'),
    'controls.fitView.ariaLabel': t('Fit view'),
    'minimap.ariaLabel': t('Canvas minimap'),
  }), [t])
  const initialRecovery = useMemo(() => initialTemplate === undefined && initialTarget?.templateId === undefined
    ? readRecovery(sessionId)
    : undefined, [initialTarget?.templateId, initialTemplate, sessionId])
  const [definitions, setDefinitions] = useState<readonly CanvasNodeDefinition[]>([])
  const [catalog, setCatalog] = useState<readonly CanvasCatalogSummary[]>([])
  const [draft, setDraft] = useState<CanvasWorkflowDraft | undefined>(initialRecovery?.draft)
  const [template, setTemplate] = useState<CanvasWorkflowTemplate>(() => initialTemplate ?? initialRecovery?.template ?? blankTemplate(undefined, language))
  const [selectedNode, setSelectedNode] = useState<string | undefined>(initialTarget?.nodeId)
  const [diagnostics, setDiagnostics] = useState<readonly CanvasWorkflowDiagnostic[]>([])
  const [diff, setDiff] = useState<CanvasTemplateDiff>()
  const [trace, setTrace] = useState<CanvasTrace>()
  const [runResult, setRunResult] = useState<CanvasRunResult>()
  const [rightPanel, setRightPanel] = useState<RightPanel>('inspector')
  const [inputsText, setInputsText] = useState(initialRecovery?.inputsText ?? '{}')
  const [paletteQuery, setPaletteQuery] = useState('')
  const [paletteGroup, setPaletteGroup] = useState<PaletteGroup>('nodes')
  const [documentState, setDocumentState] = useState<WorkflowDocumentState>(initialRecovery !== undefined ? 'dirty' : initialTemplate === undefined ? 'pristine' : 'unsaved')
  const [connectionState, setConnectionState] = useState<WorkflowConnectionState>('connecting')
  const [activity, setActivity] = useState<Activity>({ message: initialRecovery === undefined ? 'Ready to work' : 'Unsaved Canvas restored' })
  const [busy, setBusy] = useState(false)
  const [requestError, setError] = useState<WorkflowErrorPresentation>()
  const error = requestError === undefined ? undefined : classifyWorkflowError(requestError.detail, language)
  const [showInfrastructureEvents, setShowInfrastructureEvents] = useState(false)
  const [confirmPublish, setConfirmPublish] = useState(false)
  const [surface, setSurface] = useState<'design' | 'operations'>('design')
  const [operations, setOperations] = useState<CanvasOperationsSnapshot>({ bindings: [], ingress: [], deliveryAttention: [] })
  const [recoveryNotice, setRecoveryNotice] = useState(initialRecovery !== undefined)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>()

  const execute = useCallback(async <T,>(action: CanvasMessage, operation: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true)
    setError(undefined)
    setActivity({ message: '{action}…', action })
    try {
      const value = await operation()
      setActivity({ message: '{action} complete', action })
      return value
    } catch (cause: unknown) {
      const presentation = cause instanceof WorkflowCanvasRequestError ? cause.presentation : classifyWorkflowError(cause)
      setError(presentation)
      setActivity({ message: '{action} failed', action })
      if (presentation.kind === 'connection') setConnectionState('disconnected')
      return undefined
    } finally {
      setBusy(false)
    }
  }, [])

  const refreshCatalog = useCallback(async () => {
    const [nodes, templates] = await Promise.all([
      api.request('workflowCanvas.nodes', () => api.remote.nodes(sessionId), {
        retries: 2, onRetry: () => setConnectionState('reconnecting'),
      }),
      api.request('workflowCanvas.templates', () => api.remote.templates(sessionId), {
        retries: 2, onRetry: () => setConnectionState('reconnecting'),
      }),
    ])
    setDefinitions(nodes)
    setCatalog(templates)
    setConnectionState('connected')
  }, [api, sessionId])

  const syncCatalog = useCallback(() => execute('Sync catalog', refreshCatalog), [execute, refreshCatalog])

  const refreshOperations = useCallback(() => execute('Refresh trigger and delivery records', async () => {
    const value = await api.request('workflowCanvas.operations', () => api.remote.operations(sessionId, { limit: 200 }), { retries: 1 })
    setOperations(value)
    return value
  }), [api, execute, sessionId])

  useEffect(() => { void syncCatalog() }, [syncCatalog])

  useEffect(() => {
    if (connectionState !== 'disconnected') return
    reconnectTimer.current = setTimeout(() => { setConnectionState('reconnecting'); void syncCatalog() }, 2_000)
    return () => { if (reconnectTimer.current !== undefined) clearTimeout(reconnectTimer.current) }
  }, [connectionState, syncCatalog])

  useEffect(() => {
    const refreshWhenVisible = () => { if (document.visibilityState === 'visible') void syncCatalog() }
    const reconnectWhenOnline = () => { setConnectionState('reconnecting'); void syncCatalog() }
    window.addEventListener('online', reconnectWhenOnline)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      window.removeEventListener('online', reconnectWhenOnline)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [syncCatalog])

  useEffect(() => {
    if (!hasUnsavedChanges(documentState)) return
    const timer = setTimeout(() => writeRecovery(sessionId, {
      version: 1, template, ...(draft === undefined ? {} : { draft }), inputsText, savedAt: Date.now(),
    }), 250)
    return () => clearTimeout(timer)
  }, [documentState, draft, inputsText, sessionId, template])

  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedChanges(documentState)) return
      event.preventDefault()
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [documentState])

  const flow = useMemo(() => templateToFlow(template, definitions, trace), [template, definitions, trace])
  const selected = template.spec.nodes.find(node => node.id === selectedNode)
  const filteredDefinitions = useMemo(() => {
    const query = paletteQuery.trim().toLocaleLowerCase()
    return definitions.filter(definition => definitionGroup(definition) === paletteGroup)
      .filter(definition => query.length === 0 || [definitionDisplayTitle(definition, language), definitionDisplayDescription(definition, language), definition.title, definition.description, definition.uses, definition.toolName]
      .some(value => value?.toLocaleLowerCase().includes(query)))
  }, [definitions, language, paletteGroup, paletteQuery])

  const save = useCallback(async (): Promise<CanvasWorkflowDraft | undefined> => execute('Save draft', async () => {
    const next = draft === undefined
      ? await api.request('workflowCanvas.createDraft', () => api.remote.createDraft(sessionId, { template }))
      : await api.request('workflowCanvas.updateDraft', () => api.remote.updateDraft(sessionId, {
          id: draft.id, expectedRevision: draft.revision, template,
        }))
    setDraft(next)
    setTemplate(next.template)
    setDocumentState('saved')
    clearRecovery(sessionId)
    await refreshCatalog()
    return next
  }), [api, draft, execute, refreshCatalog, sessionId, template])

  const validate = useCallback(async () => execute('Validate workflow', async () => {
    const result = await api.request('workflowCanvas.validate', () => api.remote.validate(sessionId, { template }), { retries: 1 })
    setDiagnostics(result.diagnostics)
    setRightPanel('diagnostics')
    if (!result.diagnostics.some(item => item.severity === 'error')) {
      setDocumentState(current => hasUnsavedChanges(current) ? 'validated-dirty' : 'validated')
    }
    return result
  }), [api, execute, sessionId, template])

  const showDiff = useCallback(async () => {
    if (draft === undefined) { setError(classifyWorkflowError('catalog diff requires a saved draft')); return }
    await execute('Compare changes', async () => {
      const value = await api.request('workflowCanvas.diff', () => api.remote.diff(sessionId, { id: draft.id, candidate: template }), { retries: 1 })
      setDiff(value)
      setRightPanel('diff')
      return value
    })
  }, [api, draft, execute, sessionId, template])

  const publish = useCallback(async () => {
    setConfirmPublish(false)
    const saved = await save()
    if (saved === undefined) return
    const revision = await execute('Publish workflow', async () => {
      const published = await api.request('workflowCanvas.publish', () => api.remote.publish(sessionId, {
        id: saved.id,
        expectedRevision: saved.revision,
      }))
      await refreshCatalog()
      setDocumentState('published')
      return published.revision
    })
    if (revision !== undefined) setActivity({ message: 'Published as immutable revision {revision}', values: { revision } })
  }, [api, execute, refreshCatalog, save, sessionId])

  const loadDraft = useCallback(async (id: string) => execute('Open draft', async () => {
    const value = await api.request('workflowCanvas.readDraft', () => api.remote.readDraft(sessionId, { id }), { retries: 1 })
    setDraft(value)
    setTemplate(value.template)
    setDocumentState('saved')
    clearRecovery(sessionId)
    setSelectedNode(undefined)
    setDiagnostics([])
    setDiff(undefined)
    setTrace(undefined)
    setRunResult(undefined)
    return value
  }), [api, execute, sessionId])

  useEffect(() => {
    if (initialTarget?.templateId !== undefined) void loadDraft(initialTarget.templateId)
  }, [initialTarget?.templateId, loadDraft])

  useEffect(() => {
    if (initialTarget?.runId === undefined) return
    void execute('Open run trace', async () => {
      const value = await api.request('workflowCanvas.trace', () => api.remote.trace(sessionId, { runId: initialTarget.runId! }), { retries: 1 })
      setTrace(value)
      return value
    })
  }, [api, execute, initialTarget?.runId, sessionId])

  const runDraft = useCallback(async () => execute('Test run', async () => {
    const parsed = JSON.parse(inputsText) as unknown
    if (!isObject(parsed)) throw new Error('Invalid run input: expected a JSON object')
    const result = await api.request('workflowCanvas.runDraft', () => api.remote.runDraft(sessionId, { template, inputs: parsed }))
    setRunResult(result)
    const nextTrace = await api.request('workflowCanvas.trace', () => api.remote.trace(sessionId, { runId: result.runId }), { retries: 1 })
    setTrace(nextTrace)
    return result
  }), [api, execute, inputsText, sessionId, template])

  const refreshTrace = useCallback(async () => {
    const runId = runResult?.runId ?? trace?.runId
    if (runId === undefined) return
    await execute('Refresh run trace', async () => {
      const value = await api.request('workflowCanvas.trace', () => api.remote.trace(sessionId, { runId }), { retries: 1 })
      setTrace(value)
      return value
    })
  }, [api, execute, runResult?.runId, sessionId, trace?.runId])

  const loadMoreTrace = useCallback(async () => {
    if (trace?.nextAfterSeq === undefined) return
    const afterSeq = trace.nextAfterSeq
    await execute('Load more run events', async () => {
      const page = await api.request('workflowCanvas.trace', () => api.remote.trace(sessionId, {
        runId: trace.runId, afterSeq, limit: 200,
      }), { retries: 1 })
      setTrace({ ...page, events: [...trace.events, ...page.events] })
      return page
    })
  }, [api, execute, sessionId, trace])

  const resumeRun = useCallback(async (resolution?: 'retry' | 'fail') => {
    if (runResult === undefined) return
    await execute('Resume run', async () => {
      const unknownNodeResolutions = resolution === undefined || runResult.needsAttention === undefined
        ? undefined
        : Object.fromEntries(runResult.needsAttention.map(nodeId => [nodeId, resolution] as const))
      const result = await api.request('workflowCanvas.resume', () => api.remote.resume(sessionId, {
        runId: runResult.runId,
        ...(unknownNodeResolutions === undefined ? {} : { unknownNodeResolutions }),
      }))
      setRunResult(result)
      setTrace(await api.request('workflowCanvas.trace', () => api.remote.trace(sessionId, { runId: result.runId }), { retries: 1 }))
      return result
    })
  }, [api, execute, runResult, sessionId])

  const cancelRun = useCallback(async () => {
    const runId = runResult?.runId ?? trace?.runId
    if (runId === undefined) return
    await execute('Cancel run', async () => {
      const result = await api.request('workflowCanvas.cancel', () => api.remote.cancel(sessionId, { runId, reason: 'cancelled from Canvas' }))
      setRunResult(result)
      setTrace(await api.request('workflowCanvas.trace', () => api.remote.trace(sessionId, { runId }), { retries: 1 }))
      return result
    })
  }, [api, execute, runResult?.runId, sessionId, trace?.runId])

  const mutate = useCallback((next: CanvasWorkflowTemplate) => {
    setTemplate(next)
    setDocumentState(draft === undefined ? 'unsaved' : 'dirty')
    setActivity(draft === undefined
      ? { message: 'Unsaved' }
      : { message: 'Draft revision {revision} has unsaved changes', values: { revision: draft.revision } })
  }, [draft])

  const updateSelected = useCallback((next: CanvasWorkflowNode) => {
    mutate({
      ...template,
      spec: { ...template.spec, nodes: template.spec.nodes.map(node => node.id === next.id ? next : node) },
    })
  }, [mutate, template])

  const onConnect = useCallback((connection: Connection) => mutate(connectNodes(template, connection)), [mutate, template])
  const onEdgesDelete = useCallback((edges: Edge[]) => {
    mutate(edges.reduce((candidate, edge) => removeEdge(candidate, edge.id), template))
  }, [mutate, template])

  const confirmDiscard = useCallback(() => !hasUnsavedChanges(documentState)
    || window.confirm(t('Discard the unsaved changes to this workflow?')), [documentState, t])
  const startNew = useCallback(() => {
    if (!confirmDiscard()) return
    setDraft(undefined)
    setTemplate(blankTemplate(undefined, language))
    setSelectedNode(undefined)
    setTrace(undefined)
    setRunResult(undefined)
    setDiagnostics([])
    setDocumentState('pristine')
    setRecoveryNotice(false)
    setActivity({ message: 'Created a blank workflow' })
    clearRecovery(sessionId)
  }, [confirmDiscard, language, sessionId])
  const openDraftSafely = useCallback((id: string) => {
    if (id === '' || !confirmDiscard()) return
    void loadDraft(id)
  }, [confirmDiscard, loadDraft])
  const closeSafely = useCallback(() => {
    if (onClose !== undefined && confirmDiscard()) onClose()
  }, [confirmDiscard, onClose])
  const useStarter = useCallback(() => {
    if (!confirmDiscard()) return
    setDraft(undefined)
    setTemplate(starterTemplate(undefined, language))
    setInputsText(JSON.stringify({ message: t('Hello, DSH Workflow') }, null, 2))
    setDocumentState('unsaved')
    setRecoveryNotice(false)
    setActivity({ message: 'Example ready for a test run' })
  }, [confirmDiscard])
  const copyTemplate = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(template, null, 2))
      setActivity({ message: 'WorkflowTemplate JSON copied' })
    } catch (cause: unknown) { setError(classifyWorkflowError(cause)) }
  }, [template])
  const copyAgentPrompt = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(t('Use the workflow-builder skill to create a reusable DAG workflow. Create and validate a draft first. Leave it as a draft and report its name, revision, and validation results so I can review it in Canvas.'))
      setActivity({ message: 'Agent prompt copied' })
    } catch (cause: unknown) { setError(classifyWorkflowError(cause)) }
  }, [t])

  const nodes = flow.nodes
  const edges = flow.edges
  const traceEvents = useMemo(() => trace === undefined ? [] : visibleTraceEvents(trace, showInfrastructureEvents, language), [language, showInfrastructureEvents, trace])
  const runFailure = workflowFailurePresentation(trace, language)
  const selectedOutput = selectedNode === undefined ? undefined : trace?.nodeOutputs[selectedNode]
  const selectedProgress = selectedNode === undefined ? undefined : trace?.nodeProgress[selectedNode]

  return <CanvasLocaleContext.Provider value={language}><div className="wf-studio" data-workflow-studio data-surface={surface} lang={language}>
    <style>{STRUCTURE_CSS + PRODUCT_CSS + EXPERIENCE_CSS}</style>
    <header className="wf-topbar">
      <div className="wf-brand">
        <span className="wf-brand-mark">D</span>
        <span><b>AGENT DAG WORKFLOW</b><small>{t('Auditable workflows')}</small></span>
      </div>
      <div className="wf-doc-title">
        <span className="wf-status-dot" data-busy={busy} data-connection={connectionState} />
        <input value={template.metadata.name} aria-label={t('Workflow name')} onChange={event => mutate({
          ...template, metadata: { ...template.metadata, name: event.target.value },
        })} />
        <span className="wf-document-state" data-state={documentState}>{documentStateLabel(documentState, language)}</span>
        <code>{template.metadata.id}</code>
      </div>
      <div className="wf-guardrails" aria-label={t('Workflow safeguards')}>
        <span><i />{t('Dependencies: {count}', { count: template.spec.requires?.length ?? 0 })}</span><span><i />{t('Audited')}</span><span><i />{t('Schema validation')}</span>
      </div>
      <div className="wf-actions">
        <button onClick={() => { const next = surface === 'design' ? 'operations' : 'design'; setSurface(next); if (next === 'operations') void refreshOperations() }} disabled={busy}>{surface === 'design' ? t('Triggers & delivery') : t('Back to Canvas')}</button>
        <button onClick={startNew} disabled={busy} title={busy ? t('Wait for the current action to finish') : t('Create a workflow')}>{t('New')}</button>
        <button onClick={() => void save()} disabled={busy || !hasUnsavedChanges(documentState)} title={busy ? t('Wait for the current action to finish') : !hasUnsavedChanges(documentState) ? t('The draft has no changes to save') : t('Save current draft')}>{t('Save')}</button>
        <button onClick={() => void validate()} disabled={busy} title={busy ? t('Wait for the current action to finish') : t('Validate using the runtime rules')}>{t('Validate')}</button>
        <button onClick={() => void showDiff()} disabled={busy || draft === undefined} title={draft === undefined ? t('Save a draft before comparing changes') : t('Compare Canvas with the saved draft')}>{t('Changes')}</button>
        <button className="wf-primary" onClick={() => setConfirmPublish(true)} disabled={busy} title={busy ? t('Wait for the current action to finish') : t('Publish an immutable revision')}>{t('Publish')}</button>
        {onClose === undefined ? null : <button className="wf-close" onClick={closeSafely} aria-label={t('Close workflow Canvas')}>×</button>}
      </div>
    </header>

    {connectionState !== 'connected' ? <div className="wf-system-banner" data-kind={connectionState === 'disconnected' ? 'danger' : 'info'}>
      <b>{connectionStateLabel(connectionState, language)}</b><span>{connectionState === 'disconnected' ? t('Your changes were kept. Sync will resume when the connection returns.') : t('Syncing nodes, tools, and drafts.')}</span>
      <button onClick={() => void syncCatalog()} disabled={busy}>{t('Retry now')}</button>
    </div> : null}
    {recoveryNotice ? <div className="wf-system-banner wf-recovery" data-kind="warning"><b>{t('Unsaved changes restored')}</b><span>{t('We restored the Canvas and run inputs from your previous session.')}</span><button onClick={() => setRecoveryNotice(false)}>{t('Dismiss')}</button></div> : null}
    {error === undefined || error.kind === 'connection' ? null : <div className="wf-error-banner" data-kind={error.kind}>
      <div><b>{error.title}</b><span>{error.message} {error.remedy}</span><details><summary>{t('Technical details')}</summary><code>{error.detail}</code></details></div>
      <div>{error.retryable ? <button onClick={() => void syncCatalog()}>{t('Retry')}</button> : null}
        {error.kind === 'conflict' ? <><button onClick={() => void copyTemplate()}>{t('Copy current JSON')}</button>{draft === undefined ? null : <button onClick={() => void loadDraft(draft.id)}>{t('Reload')}</button>}</> : null}
        <button onClick={() => setError(undefined)}>{t('Close')}</button></div>
    </div>}

    <aside className="wf-palette">
      <div className="wf-section-row"><SectionLabel index="01" text={t('Workflow')} /><button onClick={() => void syncCatalog()} disabled={busy} title={t('Refresh drafts created by agents')}>↻</button></div>
      <select aria-label={t('Select workflow draft')} value={draft?.id ?? ''} onChange={event => openDraftSafely(event.target.value)}>
        <option value="">{t('Select a draft…')}</option>
        {catalog.map(item => <option key={item.id} value={item.id}>{item.name} · {t('Draft revision {revision}', { revision: item.draftRevision })}{item.publishedRevision === undefined ? '' : ` · ${t('Published {revision}', { revision: item.publishedRevision })}`}</option>)}
      </select>
      <SectionLabel index="02" text={t('Add nodes')} />
      <div className="wf-palette-tabs" role="tablist" aria-label={t('Node categories')}>
        <button role="tab" data-active={paletteGroup === 'nodes'} onClick={() => setPaletteGroup('nodes')}>{t('Workflow nodes')} <span>{definitions.filter(item => item.kind === 'node').length}</span></button>
        <button role="tab" data-active={paletteGroup === 'tools'} onClick={() => setPaletteGroup('tools')}>{t('Agent tools')} <span>{definitions.filter(item => item.kind === 'tool').length}</span></button>
      </div>
      <div className="wf-palette-search"><span>⌕</span><input value={paletteQuery} onChange={event => setPaletteQuery(event.target.value)} placeholder={paletteGroup === 'nodes' ? t('Search workflow nodes…') : t('Search available agent tools…')} aria-label={t('Search workflow nodes')} /></div>
      <div className="wf-node-list">
        {filteredDefinitions.length === 0 ? <p className="wf-list-empty">{t('No matches in this category')}</p> : filteredDefinitions.map((definition, index) => <button
          key={definition.catalogId} className="wf-palette-node"
          onClick={() => mutate(addNode(template, definition, { x: 140 + index % 2 * 280, y: 100 + index * 42 }))}
        ><span>{nodeGlyph(definition)}</span><b>{definitionDisplayTitle(definition, language)}</b><small>{definitionDisplayDescription(definition, language)}</small><em>{definition.kind === 'tool' ? t('Uses host permissions') : definition.uses}</em></button>)}
      </div>
      <div className="wf-palette-foot"><span>{t('Showing {count}', { count: filteredDefinitions.length })}</span><span>{t('Template v1')}</span></div>
    </aside>

    <main className="wf-canvas">
      <div className="wf-coordinate"><b>{t('Workflow Canvas')}</b><span>{t('Nodes: {nodes} · Edges: {edges}', { nodes: template.spec.nodes.length, edges: template.spec.edges.length })}</span></div>
      {definitions.length === 0 ? <div className="wf-canvas-loading">{t('Syncing nodes and tools…')}</div> : <ReactFlow
        nodes={nodes} edges={edges} nodeTypes={nodeTypes} ariaLabelConfig={graphLabels} fitView minZoom={0.25} maxZoom={1.8}
        onNodeClick={(_event, node) => { setSelectedNode(node.id); setRightPanel('inspector') }}
        onNodeDragStop={(_event, node) => mutate(moveNode(template, node.id, node.position))}
        onConnect={onConnect} onEdgesDelete={onEdgesDelete} deleteKeyCode={['Backspace', 'Delete']}
      ><Background color="rgba(142, 153, 174, .24)" gap={24} size={1} variant={BackgroundVariant.Dots} /><Controls showInteractive={false} /><MiniMap pannable zoomable nodeColor={node => statusColor(String(node.data.status ?? 'pending'))} /></ReactFlow>}
      {definitions.length > 0 && template.spec.nodes.length === 0 ? <WelcomePanel catalog={catalog} onOpen={openDraftSafely} onStarter={useStarter} onAgentPrompt={() => void copyAgentPrompt()} /> : null}
    </main>

    <aside className="wf-inspector">
      <nav>{(['inspector', 'diagnostics', 'diff'] as const).map(panel => <button key={panel} data-active={rightPanel === panel} onClick={() => setRightPanel(panel)}>{panel === 'inspector' ? t('Settings') : panel === 'diagnostics' ? `${t('Issues')}${diagnostics.length > 0 ? ` ${diagnostics.length}` : ''}` : t('Changes')}</button>)}</nav>
      {rightPanel === 'inspector' ? selected === undefined
        ? <WorkflowInspector template={template} onChange={mutate} />
        : <NodeInspector node={selected} definition={findNodeDefinition(definitions, selected)}
            requirements={nodeRequirementPresentation(selected, findNodeDefinition(definitions, selected), template.spec.requires ?? [])}
            {...(trace?.nodeStates[selected.id] === undefined ? {} : { status: trace.nodeStates[selected.id] })}
            {...(selectedOutput === undefined ? {} : { output: selectedOutput })}
            {...(selectedProgress === undefined ? {} : { progress: selectedProgress })}
            onChange={updateSelected} onDelete={() => { mutate(removeNode(template, selected.id)); setSelectedNode(undefined) }} />
        : rightPanel === 'diagnostics' ? <Diagnostics diagnostics={diagnostics} documentState={documentState} onSelect={id => { setSelectedNode(id); setRightPanel('inspector') }} /> : <DiffView diff={diff} />}
    </aside>

    <section className="wf-trace">
      <div className="wf-trace-head">
        <SectionLabel index="03" text={t('Run & audit')} />
        <textarea value={inputsText} onChange={event => setInputsText(event.target.value)} aria-label={t('Run input JSON')} title={t('Run input JSON')} />
        <button className="wf-run" onClick={() => void runDraft()} disabled={busy}>▶ {t('Test run')}</button>
        <button onClick={() => void refreshTrace()} disabled={busy || trace === undefined} title={trace === undefined ? t('No run trace to refresh') : t('Load the latest saved trace')}>{t('Refresh')}</button>
        {trace?.status === 'running' ? <button onClick={() => void cancelRun()} disabled={busy}>{t('Stop run')}</button> : null}
        {runResult?.status === 'paused' && (runResult.needsAttention?.length ?? 0) === 0 ? <button onClick={() => void resumeRun()} disabled={busy}>▶ {t('Resume run')}</button> : null}
        {(runResult?.needsAttention?.length ?? 0) > 0 ? <><button onClick={() => void resumeRun('retry')} disabled={busy}>↻ {t('Retry unresolved nodes')}</button><button onClick={() => void resumeRun('fail')} disabled={busy}>× {t('Mark failed')}</button></> : null}
        {trace === undefined ? null : <><button className="wf-subtle" onClick={() => setShowInfrastructureEvents(value => !value)}>{showInfrastructureEvents ? t('Hide infrastructure events') : t('Show infrastructure events')}</button><button className="wf-copy-run" onClick={() => void navigator.clipboard.writeText(trace.runId)} title={trace.runId}>{t('Copy run ID')}</button></>}
        <span className={`wf-run-state wf-${trace?.status ?? 'idle'}`}>{runStatusLabel(trace?.status, language)}</span>
      </div>
      <div className="wf-events">
        {runFailure === undefined ? null : <article className="wf-run-failure"><span>!</span><div><b>{runFailure.title}</b><small>{runFailure.remedy}</small></div></article>}
        {trace === undefined ? <div className="wf-empty-line">{t('Enter JSON inputs and run a test. The execution path and any failed nodes will appear here.')}</div> : <>{traceEvents.map(event => <button key={`${event.seq}-${event.title}`} data-tone={event.tone} onClick={() => { if (event.nodeId !== undefined) { setSelectedNode(event.nodeId); setRightPanel('inspector') } }}><span>{String(event.seq).padStart(3, '0')}</span><b>{event.title}</b><small>{event.detail}</small></button>)}{trace.nextAfterSeq === undefined ? null : <button className="wf-load-more" onClick={() => void loadMoreTrace()} disabled={busy}><span>…</span><b>{t('Load more')}</b><small>{t('Read more events from the journal')}</small></button>}</>}
      </div>
      <div className="wf-statusbar"><span>{documentStateLabel(documentState, language)} · {connectionStateLabel(connectionState, language)}</span><span>{error?.title ?? t(activity.message, activity.action === undefined ? activity.values : { action: t(activity.action) })}</span></div>
    </section>

    {surface === 'operations' ? <WorkflowOperationsPanel snapshot={operations} busy={busy} onRefresh={() => void refreshOperations()} onOpenRun={runId => {
      setSurface('design')
      void execute('Open run trace', async () => {
        const value = await api.request('workflowCanvas.trace', () => api.remote.trace(sessionId, { runId }), { retries: 1 })
        setTrace(value)
        return value
      })
    }} /> : null}

    {confirmPublish ? <div className="wf-modal-backdrop" role="presentation"><section className="wf-modal" role="dialog" aria-modal="true" aria-labelledby="wf-publish-title"><span className="wf-modal-icon">↗</span><h2 id="wf-publish-title">{t('Publish an immutable revision?')}</h2><p>{t('Canvas saves your draft before publishing. Runs must reference the published revision, and later edits create a new draft revision.')}</p><div><button onClick={() => setConfirmPublish(false)}>{t('Cancel')}</button><button className="wf-primary" onClick={() => void publish()}>{t('Confirm publication')}</button></div></section></div> : null}
  </div></CanvasLocaleContext.Provider>
}

function WorkflowOperationsPanel({ snapshot, busy, onRefresh, onOpenRun }: {
  readonly snapshot: CanvasOperationsSnapshot
  readonly busy: boolean
  readonly onRefresh: () => void
  readonly onOpenRun: (runId: string) => void
}) {
  const { t } = useCanvasCopy()
  return <section className="wf-operations" aria-label={t('Trigger and delivery audit')}>
    <header><div><h1>{t('Triggers, runs, and delivery')}</h1><span>{t('View host bindings, deduplicated ingress records, and deliveries that need attention. All triggers reference immutable workflow revisions.')}</span></div><button onClick={onRefresh} disabled={busy}>↻ {t('Refresh')}</button></header>
    <div className="wf-operations-grid">
      <section><h2>{t('Bindings')} <em>{snapshot.bindings.length}</em></h2>{snapshot.bindings.length === 0 ? <EmptyOperation text={t('The host has no trigger bindings')} /> : snapshot.bindings.map(binding => <article key={`${binding.metadata.id}@${binding.metadata.revision}`}><b>{binding.metadata.id}</b><code>{binding.spec.trigger.uses}</code><span>{binding.spec.workflow.id}@{binding.spec.workflow.revision}</span><small>{binding.spec.authorityRef} · {binding.spec.enabled === false ? t('Disabled') : t('Enabled')}</small></article>)}</section>
      <section><h2>{t('Ingress audit')} <em>{snapshot.ingress.length}</em></h2>{snapshot.ingress.length === 0 ? <EmptyOperation text={t('No external triggers received')} /> : snapshot.ingress.map(record => <article key={record.triggerId} data-status={record.status}><b>{record.source} / {record.sourceEventId}</b><code>{record.status}</code><span>{record.binding.id}@{record.binding.revision}</span><small>{record.runId ?? record.reasonCode ?? t('No associated run')} · {t('Duplicates: {count}', { count: record.duplicateCount ?? 0 })}</small>{record.runId === undefined ? null : <button onClick={() => onOpenRun(record.runId!)}>{t('View trace')}</button>}</article>)}</section>
      <section><h2>{t('Deliveries needing attention')} <em>{snapshot.deliveryAttention.length}</em></h2>{snapshot.deliveryAttention.length === 0 ? <EmptyOperation text={t('No deliveries in an unknown state')} /> : snapshot.deliveryAttention.map(record => <article key={record.invocationId} data-status="unknown"><b>{record.deliveryRef}</b><code>{record.phase} / {record.status}</code><span>{record.runId}</span><small>{t('Attempts: {count}', { count: record.attempts })} · {record.error ?? t('Awaiting confirmation')}</small><button onClick={() => onOpenRun(record.runId)}>{t('View trace')}</button></article>)}</section>
    </div>
  </section>
}

function EmptyOperation({ text }: { readonly text: string }) { return <div className="wf-operation-empty">✓<span>{text}</span></div> }

function WorkflowNodeView({ data, selected }: NodeProps<WorkflowFlowNode>) {
  const { language, t } = useCanvasCopy()
  const renderer = workflowNodeRenderers.resolve(data.template.uses)
  const Custom = renderer
  const ports = data.definition?.outputPorts ?? ['default']
  return <article className="wf-graph-node" data-selected={selected} data-status={data.status ?? 'pending'}>
    <div className="wf-node-cap"><span>{nodeGlyph(data.definition)}</span><em>{data.definition?.kind === 'tool' ? t('DSH tool') : nodeStatusLabel(data.status, language)}</em></div>
    {Custom === undefined
      ? <><h3>{data.template.title ?? (data.definition === undefined ? data.template.id : definitionDisplayTitle(data.definition, language))}</h3><code>{data.template.uses}</code></>
      : <Custom data={data} selected={selected} />}
    <div className="wf-node-foot"><span>{nodeStatusLabel(data.status, language)}</span><span>{t('Capabilities: {count}', { count: data.definition?.capabilities.length ?? 0 })}</span></div>
    <Handle type="target" position={Position.Left} className="wf-handle" />
    {ports.map((port, index) => <Handle
      key={port}
      id={port}
      type="source"
      position={Position.Right}
      className="wf-handle"
      style={{ top: `${45 + index * 18}%` } as CSSProperties}
    />)}
  </article>
}

function WorkflowInspector({ template, onChange }: { readonly template: CanvasWorkflowTemplate; readonly onChange: (value: CanvasWorkflowTemplate) => void }) {
  const { t } = useCanvasCopy()
  return <div className="wf-panel-body">
    <p className="wf-eyebrow">{t('Workflow settings')}</p>
    <label>{t('Workflow ID')}<input value={template.metadata.id} onChange={event => onChange({ ...template, metadata: { ...template.metadata, id: event.target.value } })} /></label>
    <label>{t('Description')}<textarea value={template.metadata.description ?? ''} onChange={event => onChange({
      ...template,
      metadata: { ...template.metadata, description: event.target.value },
    })} /></label>
    <details className="wf-advanced"><summary>{t('Advanced · schemas and dependencies')}</summary>
      <p>{t('These fields edit the WorkflowTemplate directly. Declare external capabilities in the dependency allowlist.')}</p>
      <JsonEditor label={t('Input schema')} value={template.spec.inputSchema} onChange={value => onChange({ ...template, spec: { ...template.spec, inputSchema: value } })} />
      <RequirementsEditor value={template.spec.requires ?? []} onChange={value => onChange({ ...template, spec: { ...template.spec, requires: value } })} />
      <JsonEditor label={t('Workflow output bindings')} value={template.spec.outputs as unknown as CanvasJsonObject} onChange={value => onChange({ ...template, spec: { ...template.spec, outputs: value as unknown as CanvasWorkflowTemplate['spec']['outputs'] } })} />
    </details>
  </div>
}

function NodeInspector({ node, definition, requirements, status, output, progress, onChange, onDelete }: {
  readonly node: CanvasWorkflowNode
  readonly definition: CanvasNodeDefinition | undefined
  readonly requirements: ReturnType<typeof nodeRequirementPresentation>
  readonly status?: string
  readonly output?: CanvasJsonObject
  readonly progress?: CanvasJsonValue
  readonly onChange: (node: CanvasWorkflowNode) => void
  readonly onDelete: () => void
}) {
  const { language, t } = useCanvasCopy()
  return <div className="wf-panel-body">
    <p className="wf-eyebrow">{t('Node settings')}</p>
    <h2>{node.id}</h2>
    <code className="wf-uses">{node.uses}</code>
    {requirements.length === 0 ? null : <section className="wf-node-security">
      <header><b>{t('Capability boundary')}</b><span data-complete={requirements.every(item => item.declared)}>{requirements.every(item => item.declared) ? t('Dependencies declared') : t('Undeclared dependencies')}</span></header>
      <div>{requirements.map(item => <code key={`${item.kind}:${item.uses}`} data-declared={item.declared}>{item.kind} · {item.uses}</code>)}</div>
      <p>{t('Declarations form an allowlist. The current host or agent checks the actual permissions.')}</p>
    </section>}
    <label>{t('Node name')}<input value={node.title ?? ''} onChange={event => onChange({ ...node, title: event.target.value })} /></label>
    <SchemaObjectEditor schema={definition?.configSchema} value={node.with} onChange={value => onChange({ ...node, with: value })} />
    <JsonEditor label={t('Input bindings')} value={node.inputs as unknown as CanvasJsonObject} onChange={value => onChange({
      ...node,
      inputs: value as unknown as CanvasWorkflowNode['inputs'],
    })} />
    {status === undefined ? null : <section className="wf-node-run"><header><b>{t('Current run')}</b><span data-status={status}>{nodeStatusLabel(status, language)}</span></header>
      {progress === undefined ? null : <details><summary>{t('View saved progress')}</summary><pre>{JSON.stringify(progress, null, 2)}</pre></details>}
      {output === undefined ? null : <details><summary>{t('View node output')}</summary><pre>{JSON.stringify(output, null, 2)}</pre></details>}
    </section>}
    <details className="wf-advanced"><summary>{t('Advanced · raw JSON and output contract')}</summary>
      <JsonEditor label={t('Raw node configuration')} value={node.with} onChange={value => onChange({ ...node, with: value })} />
      <JsonEditor label={t('Expected output contract')} value={(node.expects ?? {}) as unknown as CanvasJsonObject} onChange={value => {
        const { expects: _expects, ...withoutExpectation } = node
        onChange(Object.keys(value).length === 0 ? withoutExpectation : { ...withoutExpectation, expects: value as unknown as NonNullable<CanvasWorkflowNode['expects']> })
      }} />
    </details>
    <button className="wf-danger" onClick={onDelete}>{t('Delete node')}</button>
  </div>
}

function SchemaObjectEditor({ schema, value, onChange }: {
  readonly schema: CanvasJsonObject | undefined
  readonly value: CanvasJsonObject
  readonly onChange: (value: CanvasJsonObject) => void
}) {
  const { t } = useCanvasCopy()
  const properties = isObject(schema?.properties) ? schema.properties : undefined
  if (properties === undefined || Object.keys(properties).length === 0) return null
  const required = new Set(Array.isArray(schema?.required) ? schema.required.filter(item => typeof item === 'string') : [])
  return <fieldset className="wf-schema-form"><legend>{t('Node parameters')}</legend>{Object.entries(properties).map(([name, candidate]) => {
    const property = isObject(candidate) ? candidate : {}
    const current = value[name]
    const type = typeof property.type === 'string' ? property.type : undefined
    const choices = Array.isArray(property.enum) ? property.enum.filter(item => typeof item === 'string') : undefined
    return <label key={name}>{name.toUpperCase()}{required.has(name) ? ' *' : ''}
      {choices !== undefined
        ? <select value={typeof current === 'string' ? current : ''} onChange={event => onChange({ ...value, [name]: event.target.value })}>
            <option value="">—</option>{choices.map(choice => <option key={choice} value={choice}>{choice}</option>)}
          </select>
        : property['x-dsh-editor'] === 'multiline'
          ? <textarea
              value={typeof current === 'string' ? current : ''}
              placeholder={typeof property.description === 'string' ? property.description : 'expression'}
              onChange={event => onChange({ ...value, [name]: event.target.value })}
            />
        : type === 'boolean'
          ? <input type="checkbox" checked={current === true} onChange={event => onChange({ ...value, [name]: event.target.checked })} />
          : <input
              type={type === 'number' || type === 'integer' ? 'number' : 'text'}
              value={typeof current === 'string' || typeof current === 'number' ? current : ''}
              placeholder={typeof property.description === 'string' ? property.description : type ?? 'value'}
              onChange={event => onChange({
                ...value,
                [name]: type === 'number' || type === 'integer' ? Number(event.target.value) : event.target.value,
              })}
            />}
    </label>
  })}</fieldset>
}

function JsonEditor({ label, value, onChange }: { readonly label: string; readonly value: CanvasJsonObject; readonly onChange: (value: CanvasJsonObject) => void }) {
  const { t } = useCanvasCopy()
  const serialized = JSON.stringify(value, null, 2)
  const [text, setText] = useState(serialized)
  const [invalid, setInvalid] = useState(false)
  useEffect(() => { setText(serialized); setInvalid(false) }, [serialized])
  return <label data-invalid={invalid}>{label}{invalid ? <span className="wf-field-error">{t('Enter a valid JSON object')}</span> : null}<textarea value={text} onChange={event => setText(event.target.value)} onBlur={() => {
    try {
      const parsed = JSON.parse(text) as unknown
      if (!isObject(parsed)) throw new Error('object required')
      setInvalid(false)
      onChange(parsed)
    } catch { setInvalid(true) }
  }} /></label>
}

function RequirementsEditor({ value, onChange }: {
  readonly value: NonNullable<CanvasWorkflowTemplate['spec']['requires']>
  readonly onChange: (value: NonNullable<CanvasWorkflowTemplate['spec']['requires']>) => void
}) {
  const { t } = useCanvasCopy()
  const serialized = JSON.stringify(value, null, 2)
  const [text, setText] = useState(serialized)
  const [invalid, setInvalid] = useState(false)
  useEffect(() => { setText(serialized); setInvalid(false) }, [serialized])
  return <label data-invalid={invalid}>{t('Declared dependencies (allowlist)')}{invalid ? <span className="wf-field-error">{t('Each item requires kind and uses')}</span> : null}<textarea value={text} onChange={event => setText(event.target.value)} onBlur={() => {
    try {
      const parsed = JSON.parse(text) as unknown
      if (!Array.isArray(parsed) || parsed.some(item => !isObject(item) || typeof item.kind !== 'string' || typeof item.uses !== 'string')) {
        throw new Error('requirement array required')
      }
      setInvalid(false)
      onChange(parsed as unknown as NonNullable<CanvasWorkflowTemplate['spec']['requires']>)
    } catch { setInvalid(true) }
  }} /></label>
}

function Diagnostics({ diagnostics, documentState, onSelect }: { readonly diagnostics: readonly CanvasWorkflowDiagnostic[]; readonly documentState: WorkflowDocumentState; readonly onSelect: (id: string) => void }) {
  const { language, t } = useCanvasCopy()
  if (diagnostics.length === 0) return <div className="wf-panel-empty"><b>{documentState === 'validated' || documentState === 'validated-dirty' ? t('Validation passed') : t('Not yet validated')}</b><span>{documentState === 'validated' || documentState === 'validated-dirty' ? t('No structure, dependency, or schema issues found.') : t('Select Validate to check this workflow with the runtime’s compile rules.')}</span></div>
  return <div className="wf-diagnostics">{diagnostics.map((item, index) => <button key={`${item.code}-${index}`} data-severity={item.severity} onClick={() => { if (item.nodeId !== undefined) onSelect(item.nodeId) }}>
    <span>{item.severity === 'error' ? '×' : '!'}</span><div><b>{diagnosticTitle(item, language)}</b><p>{item.message}</p><small>{item.nodeId === undefined ? `${t('Workflow')} · ${item.code}` : `${item.nodeId} · ${item.code}`}</small></div>
  </button>)}</div>
}

function DiffView({ diff }: { readonly diff: CanvasTemplateDiff | undefined }) {
  const { t } = useCanvasCopy()
  if (diff === undefined) return <div className="wf-panel-empty"><b>{t('No comparison yet')}</b><span>{t('Save a draft, then compare Canvas with the saved revision.')}</span></div>
  return <div className="wf-diff">
    <div className="wf-diff-flags"><Flag on={diff.semanticChanged} text={t('Semantic changes')} /><Flag on={diff.layoutChanged} text={t('Layout changes')} /></div>
    <ChangeSet label={t('Nodes')} value={diff.nodes} />
    <ChangeSet label={t('Edges')} value={diff.edges} />
  </div>
}

function ChangeSet({ label, value }: { readonly label: string; readonly value: { readonly added: readonly string[]; readonly removed: readonly string[]; readonly changed: readonly string[] } }) {
  const { t } = useCanvasCopy()
  const labels = { added: t('Added'), changed: t('Changed'), removed: t('Removed') }
  return <section><h3>{label}</h3>{(['added', 'changed', 'removed'] as const).map(kind => <div key={kind}><b>{labels[kind]}</b><span>{value[kind].join(', ') || '—'}</span></div>)}</section>
}

function Flag({ on, text }: { readonly on: boolean; readonly text: string }) { return <span data-on={on}>{on ? '●' : '○'} {text}</span> }
function SectionLabel({ index, text }: { readonly index: string; readonly text: string }) { return <h4 className="wf-section-label"><span>{index}</span>{text}</h4> }

function WelcomePanel({ catalog, onOpen, onStarter, onAgentPrompt }: {
  readonly catalog: readonly CanvasCatalogSummary[]
  readonly onOpen: (id: string) => void
  readonly onStarter: () => void
  readonly onAgentPrompt: () => void
}) {
  const { t } = useCanvasCopy()
  return <section className="wf-welcome">
    <span className="wf-welcome-kicker">{t('One JSON template with an auditable execution path')}</span>
    <h1>{t('Start with a clear outcome')}</h1>
    <p>{t('The agent, Canvas, and DAG engine use the same WorkflowTemplate. Run an example or have an agent turn your steps into a workflow.')}</p>
    <div className="wf-welcome-actions">
      <button className="wf-welcome-primary" onClick={onStarter}><span>01</span><b>{t('Start with a runnable example')}</b><small>{t('A two-node echo workflow that runs without external tools')}</small></button>
      <button onClick={onAgentPrompt}><span>02</span><b>{t('Ask an agent to create it')}</b><small>{t('Copy a prompt for the workflow-builder skill')}</small></button>
      {catalog[0] === undefined ? <button disabled><span>03</span><b>{t('Open an existing draft')}</b><small>{t('No drafts yet')}</small></button> : <button onClick={() => onOpen(catalog[0]!.id)}><span>03</span><b>{t('Continue the latest draft')}</b><small>{catalog[0]!.name} · {t('Draft revision {revision}', { revision: catalog[0]!.draftRevision })}</small></button>}
    </div>
  </section>
}

function nodeGlyph(definition?: CanvasNodeDefinition): string {
  if (definition?.kind === 'tool') return 'T'
  if (definition?.role === 'start') return '▷'
  if (definition?.role === 'end') return '■'
  if (definition?.uses.includes('agent')) return 'A'
  if (definition?.uses.includes('condition')) return '◇'
  if (definition?.uses.includes('foreach')) return '∞'
  if (definition?.uses.includes('script')) return 'ƒ'
  if (definition?.uses.includes('approval')) return '⌁'
  return '＋'
}

function statusColor(status: string): string {
  if (status === 'succeeded') return '#63c174'
  if (status === 'failed' || status === 'needs_attention') return '#ee6045'
  if (status === 'running' || status === 'waiting') return '#e7b44e'
  return '#77766f'
}

function nodeStatusLabel(status: string | undefined, language: CanvasLocale): string {
  const t = canvasText(language)
  const labels: Record<string, string> = {
    pending: t('Pending'), ready: t('Ready'), running: t('Running'), waiting: t('Awaiting human input'), succeeded: t('Completed'),
    failed: t('Failed'), cancelled: t('Canceled'), skipped: t('Skipped'), needs_attention: t('Needs attention'), draft: t('Draft'),
  }
  return labels[status ?? 'draft'] ?? status ?? t('Draft')
}

function runStatusLabel(status: CanvasTrace['status'] | undefined, language: CanvasLocale): string {
  const t = canvasText(language)
  if (status === undefined) return t('No runs yet')
  return { running: t('Running'), completed: t('Run complete'), failed: t('Run failed'), cancelled: t('Canceled'), paused: t('Paused') }[status]
}

function isObject(value: unknown): value is CanvasJsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readRecovery(sessionId: string) {
  if (typeof window === 'undefined') return undefined
  try { return parseRecoverySnapshot(window.localStorage.getItem(recoveryStorageKey(sessionId))) } catch { return undefined }
}

function writeRecovery(sessionId: string, snapshot: Parameters<typeof serializeRecoverySnapshot>[0]): void {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(recoveryStorageKey(sessionId), serializeRecoverySnapshot(snapshot)) } catch { /* best effort */ }
}

function clearRecovery(sessionId: string): void {
  if (typeof window === 'undefined') return
  try { window.localStorage.removeItem(recoveryStorageKey(sessionId)) } catch { /* best effort */ }
}

const STRUCTURE_CSS = String.raw`
.wf-studio{position:absolute;inset:0;z-index:40;display:grid;overflow:hidden;pointer-events:auto}
.wf-studio *{box-sizing:border-box}.wf-studio button{cursor:pointer}.wf-studio button:disabled{cursor:not-allowed;opacity:.4}
.wf-topbar{grid-column:1/-1;z-index:3;display:flex;align-items:center;border-bottom:1px solid}.wf-brand{height:100%;display:flex;align-items:center;border-right:1px solid}.wf-brand b,.wf-brand small{display:block}.wf-doc-title{min-width:0;flex:1;display:flex;align-items:center}.wf-status-dot{flex:none;border-radius:50%}.wf-doc-title input{width:min(42vw,420px);border:0;background:transparent;outline:0}.wf-actions{display:flex;height:100%}
.wf-palette{grid-row:2;grid-column:1;display:flex;min-height:0;flex-direction:column;border-right:1px solid}.wf-section-label{display:flex;align-items:center}.wf-palette select{width:100%}.wf-node-list{display:flex;overflow:auto;flex-direction:column}.wf-palette-node{display:grid;cursor:pointer}.wf-palette-foot{display:flex;justify-content:space-between;margin-top:auto;border-top:1px solid}
.wf-canvas{position:relative;grid-row:2;grid-column:2;min-width:0}.wf-canvas .react-flow__minimap{width:150px!important;height:92px!important}.wf-canvas-loading{position:absolute;inset:0;display:grid;place-items:center}.wf-coordinate{position:absolute;z-index:2}.wf-edge-skipped .react-flow__edge-path{stroke-dasharray:3 5;opacity:.35}
.wf-graph-node{position:relative}.wf-graph-node:before{content:"";position:absolute}.wf-node-cap{display:flex;justify-content:space-between}.wf-node-cap em{font-style:normal}.wf-handle{position:absolute}
.wf-inspector{grid-row:2;grid-column:3;min-height:0;overflow:hidden;border-left:1px solid}.wf-inspector>nav{display:flex;border-bottom:1px solid}.wf-panel-body,.wf-diagnostics,.wf-diff{overflow:auto}.wf-panel-body label{display:block}.wf-panel-body input,.wf-panel-body textarea,.wf-schema-form select{display:block;width:100%;margin-top:7px}.wf-panel-body textarea{min-height:82px;resize:vertical}.wf-panel-empty{display:flex;height:100%;flex-direction:column;align-items:center;justify-content:center;text-align:center}.wf-schema-form{margin:0 0 16px}.wf-schema-form input[type=checkbox]{display:inline-block;width:auto;margin-left:10px}.wf-danger{width:100%}
.wf-diagnostics>button{display:grid;width:100%;grid-template-columns:25px 1fr;text-align:left}.wf-diff-flags{display:flex}.wf-diff section div{display:grid;grid-template-columns:65px 1fr}
.wf-trace{grid-row:3;grid-column:1/-1;display:grid;min-width:0;border-top:1px solid}.wf-trace-head{display:flex;align-items:stretch;border-bottom:1px solid}.wf-trace-head textarea{resize:none}.wf-events{display:flex;overflow:auto}.wf-events button{display:grid;flex:0 0 188px;grid-template-columns:28px 1fr;text-align:left}.wf-events button span{grid-row:1/3}.wf-statusbar{display:flex;align-items:center;justify-content:space-between;overflow:hidden;white-space:nowrap}
`

const PRODUCT_CSS = String.raw`
/* Agent DAG Workflow: light-first, host-aware product skin. */
.wf-studio{
  --wf-bg:#f6f7fb;--wf-surface:#ffffff;--wf-surface-soft:#f1f3f7;--wf-surface-hover:#eef3ff;
  --wf-border:#e2e6ed;--wf-border-strong:#cbd2dc;--wf-text:#171b24;--wf-muted:#667085;
  --wf-brand:#2563eb;--wf-brand-strong:#1d4ed8;--wf-brand-soft:#eaf1ff;--wf-success:#159455;
  --wf-warning:#b7791f;--wf-danger:#d64545;--wf-shadow:0 14px 42px rgba(27,39,66,.12);
  --ink:var(--wf-text);--muted:var(--wf-muted);--panel:var(--wf-surface);--line:var(--wf-border);
  --accent:var(--wf-brand);--green:var(--wf-success);color-scheme:light;background:var(--wf-bg);color:var(--wf-text);
  font-family:var(--dsw-font-family),"Avenir Next","PingFang SC",sans-serif;
  grid-template:64px minmax(0,1fr) 176px / 272px minmax(0,1fr) 348px;
}
.wf-topbar{height:64px;background:color-mix(in srgb,var(--wf-surface) 94%,transparent);border-color:var(--wf-border);box-shadow:0 1px 0 rgba(19,27,45,.03);backdrop-filter:blur(18px)}
.wf-brand{width:272px;padding:0 20px;border-color:var(--wf-border);gap:11px}
.wf-brand-mark{display:grid;place-items:center;width:30px;height:30px;border-radius:9px;background:var(--wf-brand);color:#fff;font:800 15px/1 var(--dsw-font-family),sans-serif;transform:none;box-shadow:0 7px 18px color-mix(in srgb,var(--wf-brand) 26%,transparent)}
.wf-brand b{font-size:12px;letter-spacing:.035em;color:var(--wf-text)}.wf-brand small{font-size:8px;letter-spacing:.14em;color:var(--wf-muted);margin-top:2px}
.wf-doc-title{gap:10px;padding:0 16px;max-width:min(38vw,520px)}.wf-status-dot{width:8px;height:8px;background:var(--wf-success);box-shadow:0 0 0 4px color-mix(in srgb,var(--wf-success) 14%,transparent)}.wf-status-dot[data-busy=true]{background:var(--wf-warning);box-shadow:0 0 0 4px color-mix(in srgb,var(--wf-warning) 14%,transparent)}
.wf-doc-title input{font:650 15px/1.2 var(--dsw-font-family),sans-serif;color:var(--wf-text);min-width:160px}.wf-doc-title code{font:10px/1.2 var(--ds-font-family-code),monospace;color:var(--wf-muted);background:var(--wf-surface-soft);border:1px solid var(--wf-border);border-radius:6px;padding:4px 7px;overflow:hidden;text-overflow:ellipsis}
.wf-guardrails{display:flex;align-items:center;gap:6px;margin-left:auto;white-space:nowrap}.wf-guardrails span{display:flex;align-items:center;gap:6px;padding:5px 8px;border:1px solid var(--wf-border);border-radius:999px;color:var(--wf-muted);font-size:9px;background:var(--wf-surface)}.wf-guardrails i{width:5px;height:5px;border-radius:50%;background:var(--wf-success)}
.wf-actions{margin-left:12px;gap:5px;align-items:center;padding:0 12px 0 4px}.wf-actions button,.wf-trace button{height:34px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--wf-text);font:600 11px/1 var(--dsw-font-family),sans-serif;letter-spacing:0;padding:0 11px;transition:background .16s ease,border-color .16s ease,transform .16s ease}.wf-actions button:hover,.wf-trace button:hover{background:var(--wf-surface-soft);border-color:var(--wf-border)}
.wf-actions .wf-primary{background:var(--wf-brand);color:#fff;border-color:var(--wf-brand);padding-inline:16px;box-shadow:0 6px 16px color-mix(in srgb,var(--wf-brand) 22%,transparent)}.wf-actions .wf-primary:hover{background:var(--wf-brand-strong);border-color:var(--wf-brand-strong);transform:translateY(-1px)}.wf-actions .wf-close{font-size:19px;color:var(--wf-muted);padding:0 8px}
.wf-palette{padding:16px 14px 10px;background:var(--wf-surface);border-color:var(--wf-border)}.wf-section-label{gap:8px;color:var(--wf-text);font-size:11px;font-weight:650;letter-spacing:0;margin:3px 3px 10px;text-transform:none}.wf-section-label span{display:grid;place-items:center;width:18px;height:18px;border-radius:6px;background:var(--wf-brand-soft);color:var(--wf-brand);font-size:8px}
.wf-palette select{height:38px;margin-bottom:18px;padding:0 11px;border:1px solid var(--wf-border);border-radius:9px;background:var(--wf-surface-soft);color:var(--wf-text);font:11px var(--dsw-font-family),sans-serif;outline:none}.wf-palette select:focus,.wf-palette-search:focus-within{border-color:var(--wf-brand);box-shadow:0 0 0 3px color-mix(in srgb,var(--wf-brand) 12%,transparent)}
.wf-palette-search{display:flex;align-items:center;height:38px;margin:0 0 10px;border:1px solid var(--wf-border);border-radius:9px;background:var(--wf-surface);color:var(--wf-muted);transition:border-color .16s ease,box-shadow .16s ease}.wf-palette-search span{padding-left:11px;font-size:17px}.wf-palette-search input{min-width:0;flex:1;border:0;outline:0;background:transparent;color:var(--wf-text);font:11px var(--dsw-font-family),sans-serif;padding:0 10px}
.wf-node-list{gap:7px;padding:1px 1px 8px}.wf-palette-node{position:relative;grid-template-columns:32px minmax(0,1fr);padding:10px;border:1px solid transparent;border-radius:10px;background:transparent;color:var(--wf-text);transition:background .16s ease,border-color .16s ease,transform .16s ease;text-align:left}.wf-palette-node:hover{background:var(--wf-surface-hover);border-color:color-mix(in srgb,var(--wf-brand) 24%,var(--wf-border));transform:translateX(2px)}
.wf-palette-node>span{display:grid;place-items:center;width:28px;height:28px;border-radius:8px;background:var(--wf-brand-soft);color:var(--wf-brand);font-size:13px;font-weight:750;grid-row:1/4}.wf-palette-node b{font-size:11px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.wf-palette-node small{margin-top:3px;color:var(--wf-muted);font-size:9px;line-height:1.35;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}.wf-palette-node em{margin-top:5px;color:var(--wf-brand);font:650 7px/1 var(--ds-font-family-code),monospace;font-style:normal;letter-spacing:.04em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.wf-palette-foot{padding:10px 3px 1px;border-color:var(--wf-border);color:var(--wf-muted);font-size:9px}
.wf-canvas{background:var(--wf-bg)}.wf-canvas:before{content:"";position:absolute;inset:0;pointer-events:none;background:radial-gradient(circle at 50% 32%,color-mix(in srgb,var(--wf-brand) 5%,transparent),transparent 42%)}.wf-coordinate{top:14px;left:16px;display:flex;align-items:center;gap:9px;padding:7px 10px;border:1px solid var(--wf-border);border-radius:8px;background:color-mix(in srgb,var(--wf-surface) 92%,transparent);box-shadow:0 5px 18px rgba(30,42,68,.06);color:var(--wf-muted);font:9px/1 var(--dsw-font-family),sans-serif;letter-spacing:0;backdrop-filter:blur(10px)}.wf-coordinate b{color:var(--wf-text);font-size:10px}.wf-coordinate span{border-left:1px solid var(--wf-border);padding-left:9px}
.wf-canvas .react-flow__controls{overflow:hidden;border:1px solid var(--wf-border);border-radius:10px;background:var(--wf-surface);box-shadow:0 9px 26px rgba(27,39,66,.1)}.wf-canvas .react-flow__controls button{background:var(--wf-surface);color:var(--wf-text);border-bottom-color:var(--wf-border)}.wf-canvas .react-flow__controls button:hover{background:var(--wf-surface-soft)}.wf-canvas .react-flow__minimap{background:color-mix(in srgb,var(--wf-surface) 92%,transparent);border:1px solid var(--wf-border);border-radius:10px;box-shadow:0 9px 26px rgba(27,39,66,.08)}.wf-canvas .react-flow__edge-path{stroke:#aeb7c5;stroke-width:1.7}.wf-canvas .react-flow__edge.selected .react-flow__edge-path{stroke:var(--wf-brand);stroke-width:2.3}
.wf-graph-node{width:224px;min-height:104px;padding:13px 14px 11px;border:1px solid var(--wf-border-strong);border-radius:11px;background:var(--wf-surface);box-shadow:0 10px 30px rgba(31,43,68,.1);color:var(--wf-text);overflow:hidden}.wf-graph-node:before{left:0;top:0;width:4px;height:100%;background:#98a2b3}.wf-graph-node[data-selected=true]{border-color:var(--wf-brand);box-shadow:0 0 0 3px color-mix(in srgb,var(--wf-brand) 13%,transparent),0 14px 34px rgba(31,43,68,.14)}.wf-graph-node[data-status=succeeded]:before{background:var(--wf-success)}.wf-graph-node[data-status=running]:before,.wf-graph-node[data-status=waiting]:before{background:var(--wf-warning)}.wf-graph-node[data-status=failed]:before,.wf-graph-node[data-status=needs_attention]:before{background:var(--wf-danger)}
.wf-node-cap{align-items:center;color:var(--wf-brand);font:700 10px/1 var(--dsw-font-family),sans-serif}.wf-node-cap>span{display:grid;place-items:center;width:26px;height:26px;border-radius:8px;background:var(--wf-brand-soft)}.wf-node-cap em{padding:4px 6px;border-radius:999px;background:var(--wf-surface-soft);color:var(--wf-muted);font:650 7px/1 var(--ds-font-family-code),monospace;letter-spacing:.05em}.wf-graph-node h3{font:650 13px/1.25 var(--dsw-font-family),sans-serif;margin:11px 0 5px}.wf-graph-node code{color:var(--wf-muted);font:8px/1.2 var(--ds-font-family-code),monospace}.wf-node-foot{display:flex;justify-content:space-between;align-items:center;margin-top:12px;padding-top:8px;border-top:1px solid var(--wf-border);color:var(--wf-muted);font-size:8px;text-transform:uppercase}.wf-node-foot span:first-child{color:var(--wf-success)}.wf-handle{width:9px!important;height:9px!important;background:var(--wf-surface)!important;border:2px solid var(--wf-brand)!important}
.wf-inspector{background:var(--wf-surface);border-color:var(--wf-border)}.wf-inspector>nav{height:45px;padding:0 12px;border-color:var(--wf-border);gap:4px}.wf-inspector>nav button{flex:none;border:0;border-radius:7px;background:transparent;color:var(--wf-muted);font:600 10px/1 var(--dsw-font-family),sans-serif;letter-spacing:0;padding:0 12px}.wf-inspector>nav button:hover{background:var(--wf-surface-soft)}.wf-inspector>nav button[data-active=true]{color:var(--wf-brand);background:var(--wf-brand-soft);box-shadow:none}
.wf-panel-body,.wf-diagnostics,.wf-diff{height:calc(100% - 45px);padding:20px}.wf-eyebrow{color:var(--wf-brand);font-size:9px;font-weight:700;letter-spacing:.08em}.wf-panel-body h2{font:700 20px/1.2 var(--dsw-font-family),sans-serif}.wf-uses{color:var(--wf-muted);font:9px var(--ds-font-family-code),monospace;margin-bottom:20px}.wf-panel-body label{color:var(--wf-muted);font-size:9px;font-weight:650;letter-spacing:.035em;margin-bottom:15px}.wf-panel-body input,.wf-panel-body textarea,.wf-schema-form select{border:1px solid var(--wf-border);border-radius:8px;background:var(--wf-surface-soft);color:var(--wf-text);font:10px/1.55 var(--ds-font-family-code),monospace;padding:9px 10px;outline:none}.wf-panel-body input:focus,.wf-panel-body textarea:focus,.wf-schema-form select:focus{border-color:var(--wf-brand);box-shadow:0 0 0 3px color-mix(in srgb,var(--wf-brand) 10%,transparent)}
.wf-schema-form{border:1px solid var(--wf-border);border-radius:10px;padding:12px;margin-bottom:16px;background:color-mix(in srgb,var(--wf-surface-soft) 60%,transparent)}.wf-schema-form legend{color:var(--wf-brand);font-size:8px;font-weight:700}.wf-schema-form input[type=checkbox]{accent-color:var(--wf-brand)}.wf-danger{border:1px solid color-mix(in srgb,var(--wf-danger) 32%,var(--wf-border));border-radius:8px;background:color-mix(in srgb,var(--wf-danger) 8%,var(--wf-surface));color:var(--wf-danger);font:650 10px var(--dsw-font-family),sans-serif}.wf-danger:hover{background:color-mix(in srgb,var(--wf-danger) 13%,var(--wf-surface))}.wf-panel-empty{color:var(--wf-muted)}.wf-panel-empty b{color:var(--wf-text)}
.wf-diagnostics>button{border:1px solid var(--wf-border);border-radius:9px;background:var(--wf-surface-soft);color:var(--wf-text)}.wf-diagnostics>button:hover{border-color:var(--wf-brand)}.wf-diagnostics>button>span{color:var(--wf-warning)}.wf-diagnostics>button[data-severity=error]>span{color:var(--wf-danger)}.wf-diagnostics p{color:var(--wf-muted)}.wf-diff-flags span{border-color:var(--wf-border);border-radius:999px;color:var(--wf-muted)}.wf-diff-flags span[data-on=true]{border-color:var(--wf-brand);background:var(--wf-brand-soft);color:var(--wf-brand)}.wf-diff section{border-color:var(--wf-border)}
.wf-trace{background:var(--wf-surface);border-color:var(--wf-border);grid-template-rows:48px 1fr 24px}.wf-trace-head{border-color:var(--wf-border);align-items:center}.wf-trace-head .wf-section-label{min-width:272px;padding:0 17px}.wf-trace-head textarea{align-self:stretch;width:320px;border:0;border-left:1px solid var(--wf-border);border-right:1px solid var(--wf-border);background:var(--wf-surface-soft);color:var(--wf-text);font:9px/1.45 var(--ds-font-family-code),monospace;padding:8px 11px}.wf-trace-head .wf-run{margin-left:10px;background:var(--wf-brand);border-color:var(--wf-brand);color:#fff}.wf-trace-head .wf-run:hover{background:var(--wf-brand-strong)}.wf-run-state{margin-left:auto;margin-right:16px;border:1px solid var(--wf-border);border-radius:999px;background:var(--wf-surface-soft);color:var(--wf-muted);font:650 8px/1 var(--ds-font-family-code),monospace;padding:6px 9px}.wf-run-state.wf-completed{color:var(--wf-success);border-color:color-mix(in srgb,var(--wf-success) 32%,var(--wf-border));background:color-mix(in srgb,var(--wf-success) 7%,var(--wf-surface))}.wf-run-state.wf-failed,.wf-run-state.wf-paused{color:var(--wf-danger);border-color:color-mix(in srgb,var(--wf-danger) 30%,var(--wf-border))}
.wf-events{gap:7px;padding:10px 14px}.wf-events button{flex-basis:188px;border:1px solid var(--wf-border);border-radius:9px;background:var(--wf-surface-soft);color:var(--wf-text);padding:8px}.wf-events button:hover{border-color:var(--wf-brand);background:var(--wf-surface-hover)}.wf-events button span{color:var(--wf-brand);font-weight:700}.wf-events button small{color:var(--wf-muted)}.wf-empty-line{color:var(--wf-muted);font-size:10px}.wf-statusbar{height:24px;border-top:1px solid var(--wf-border);background:var(--wf-surface-soft);color:var(--wf-muted);font:650 8px/1 var(--ds-font-family-code),monospace;letter-spacing:.035em;padding:0 11px}
html[style*="color-scheme: dark"] .wf-studio{--wf-bg:#111318;--wf-surface:#181b21;--wf-surface-soft:#20242c;--wf-surface-hover:#222b3d;--wf-border:#2b303a;--wf-border-strong:#3b424f;--wf-text:#eef1f6;--wf-muted:#98a2b3;--wf-brand:#6d9cff;--wf-brand-strong:#8aafff;--wf-brand-soft:#1d2b47;--wf-success:#42c77a;--wf-warning:#e5ad4f;--wf-danger:#f07070;--wf-shadow:0 16px 46px rgba(0,0,0,.28);color-scheme:dark}
html[style*="color-scheme: dark"] .wf-topbar{box-shadow:0 1px 0 #0005}html[style*="color-scheme: dark"] .wf-canvas:before{background:radial-gradient(circle at 50% 32%,rgba(68,105,180,.12),transparent 44%)}html[style*="color-scheme: dark"] .wf-graph-node{box-shadow:0 12px 34px rgba(0,0,0,.26)}
@media(prefers-color-scheme:dark){html:not([style*="color-scheme: light"]) .wf-studio{--wf-bg:#111318;--wf-surface:#181b21;--wf-surface-soft:#20242c;--wf-surface-hover:#222b3d;--wf-border:#2b303a;--wf-border-strong:#3b424f;--wf-text:#eef1f6;--wf-muted:#98a2b3;--wf-brand:#6d9cff;--wf-brand-strong:#8aafff;--wf-brand-soft:#1d2b47;--wf-success:#42c77a;--wf-warning:#e5ad4f;--wf-danger:#f07070;--wf-shadow:0 16px 46px rgba(0,0,0,.28);color-scheme:dark}}
@media(max-width:1400px){.wf-doc-title code{display:none}}
@media(max-width:1180px){.wf-studio{grid-template-columns:232px minmax(0,1fr) 310px}.wf-brand{width:232px}.wf-guardrails{display:none}.wf-trace-head .wf-section-label{min-width:232px}.wf-actions button{padding-inline:8px}}
@media(max-width:900px){.wf-studio{grid-template-columns:210px minmax(0,1fr) 280px}.wf-brand{width:210px}.wf-doc-title code{display:none}.wf-actions button:nth-child(-n+2){display:none}.wf-trace-head{min-width:0;overflow-x:auto}.wf-trace-head button,.wf-run-state{flex:none;white-space:nowrap}.wf-trace-head .wf-section-label{min-width:210px}.wf-trace-head textarea{width:240px}}
`

const EXPERIENCE_CSS = String.raw`
.wf-studio button:focus-visible,.wf-studio input:focus-visible,.wf-studio textarea:focus-visible,.wf-studio select:focus-visible,.wf-studio summary:focus-visible{outline:2px solid var(--wf-brand);outline-offset:2px}
.wf-status-dot[data-connection=disconnected]{background:var(--wf-danger);box-shadow:0 0 0 4px color-mix(in srgb,var(--wf-danger) 14%,transparent)}.wf-status-dot[data-connection=reconnecting],.wf-status-dot[data-connection=connecting]{background:var(--wf-warning);box-shadow:0 0 0 4px color-mix(in srgb,var(--wf-warning) 14%,transparent)}
.wf-document-state{flex:none;padding:5px 8px;border:1px solid var(--wf-border);border-radius:999px;background:var(--wf-surface-soft);color:var(--wf-muted);font-size:9px;white-space:nowrap}.wf-document-state[data-state=dirty],.wf-document-state[data-state=unsaved],.wf-document-state[data-state=validated-dirty]{border-color:color-mix(in srgb,var(--wf-warning) 40%,var(--wf-border));color:var(--wf-warning)}.wf-document-state[data-state=validated],.wf-document-state[data-state=published]{border-color:color-mix(in srgb,var(--wf-success) 40%,var(--wf-border));color:var(--wf-success)}
.wf-system-banner,.wf-error-banner{position:absolute;z-index:12;top:76px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:11px;width:min(720px,calc(100% - 48px));padding:10px 12px;border:1px solid var(--wf-border);border-radius:10px;background:var(--wf-surface);box-shadow:var(--wf-shadow);font-size:10px}.wf-system-banner b{color:var(--wf-text)}.wf-system-banner span{flex:1;color:var(--wf-muted)}.wf-system-banner button,.wf-error-banner button{border:1px solid var(--wf-border);border-radius:7px;background:var(--wf-surface-soft);color:var(--wf-text);padding:6px 9px;cursor:pointer}.wf-system-banner[data-kind=danger]{border-color:color-mix(in srgb,var(--wf-danger) 40%,var(--wf-border))}.wf-system-banner[data-kind=warning]{border-color:color-mix(in srgb,var(--wf-warning) 40%,var(--wf-border))}.wf-recovery{top:120px}.wf-error-banner{top:120px;align-items:flex-start;border-color:color-mix(in srgb,var(--wf-danger) 40%,var(--wf-border))}.wf-error-banner>div:first-child{display:grid;gap:4px;flex:1}.wf-error-banner span{color:var(--wf-muted);line-height:1.5}.wf-error-banner details{color:var(--wf-muted)}.wf-error-banner code{display:block;max-height:80px;overflow:auto;margin-top:5px;padding:7px;border-radius:6px;background:var(--wf-surface-soft);white-space:pre-wrap}.wf-error-banner>div:last-child{display:flex;gap:6px}
.wf-section-row{display:flex;align-items:center;justify-content:space-between}.wf-section-row .wf-section-label{margin-bottom:10px}.wf-section-row>button{width:26px;height:26px;border:1px solid var(--wf-border);border-radius:7px;background:transparent;color:var(--wf-muted);cursor:pointer}.wf-palette-tabs{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:9px;padding:3px;border-radius:9px;background:var(--wf-surface-soft)}.wf-palette-tabs button{display:flex;justify-content:center;gap:5px;border:0;border-radius:7px;background:transparent;color:var(--wf-muted);font:600 10px var(--dsw-font-family),sans-serif;padding:7px;cursor:pointer}.wf-palette-tabs button[data-active=true]{background:var(--wf-surface);color:var(--wf-brand);box-shadow:0 2px 7px rgba(31,43,68,.08)}.wf-palette-tabs span{font-size:8px}.wf-list-empty{padding:24px 8px;text-align:center;color:var(--wf-muted);font-size:10px}
.wf-welcome{position:absolute;z-index:4;left:50%;top:50%;width:min(690px,calc(100% - 80px));transform:translate(-50%,-50%);padding:31px;border:1px solid var(--wf-border);border-radius:18px;background:color-mix(in srgb,var(--wf-surface) 96%,transparent);box-shadow:0 22px 65px rgba(31,43,68,.14);backdrop-filter:blur(18px)}.wf-welcome-kicker{color:var(--wf-brand);font-size:10px;font-weight:700}.wf-welcome h1{margin:9px 0 8px;color:var(--wf-text);font-size:25px;letter-spacing:-.025em}.wf-welcome>p{max-width:570px;margin:0;color:var(--wf-muted);font-size:11px;line-height:1.7}.wf-welcome-actions{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-top:24px}.wf-welcome-actions button{display:grid;grid-template-columns:28px 1fr;min-height:94px;padding:13px;border:1px solid var(--wf-border);border-radius:11px;background:var(--wf-surface-soft);color:var(--wf-text);text-align:left;cursor:pointer}.wf-welcome-actions button:hover:not(:disabled){border-color:var(--wf-brand);transform:translateY(-2px)}.wf-welcome-actions button>span{grid-row:1/3;color:var(--wf-brand);font-size:9px;font-weight:750}.wf-welcome-actions b{font-size:11px}.wf-welcome-actions small{margin-top:5px;color:var(--wf-muted);font-size:9px;line-height:1.4}.wf-welcome-actions .wf-welcome-primary{background:var(--wf-brand);border-color:var(--wf-brand);color:#fff}.wf-welcome-actions .wf-welcome-primary span,.wf-welcome-actions .wf-welcome-primary small{color:#dce8ff}
.wf-advanced{margin:2px 0 18px;border:1px solid var(--wf-border);border-radius:10px;background:color-mix(in srgb,var(--wf-surface-soft) 58%,transparent)}.wf-advanced>summary{padding:11px 12px;color:var(--wf-text);font-size:10px;font-weight:650;cursor:pointer}.wf-advanced>p{margin:0;padding:0 12px 11px;color:var(--wf-muted);font-size:9px;line-height:1.55}.wf-advanced[open]{padding-bottom:2px}.wf-advanced[open]>summary{margin-bottom:10px;border-bottom:1px solid var(--wf-border)}.wf-advanced>label{margin-inline:12px}.wf-field-error{float:right;color:var(--wf-danger);font-weight:500;letter-spacing:0}.wf-node-run{margin:2px 0 16px;padding:11px;border:1px solid var(--wf-border);border-radius:10px;background:var(--wf-surface-soft)}.wf-node-run header{display:flex;justify-content:space-between;font-size:10px}.wf-node-run header span{color:var(--wf-success)}.wf-node-run details{margin-top:9px;color:var(--wf-muted);font-size:9px}.wf-node-run pre{max-height:150px;overflow:auto;padding:8px;border-radius:7px;background:var(--wf-surface);color:var(--wf-text);font:9px/1.45 var(--ds-font-family-code),monospace;white-space:pre-wrap}
.wf-node-security{margin:0 0 16px;padding:11px;border:1px solid var(--wf-border);border-radius:10px;background:var(--wf-surface-soft)}.wf-node-security header{display:flex;justify-content:space-between;gap:8px;font-size:10px}.wf-node-security header span{color:var(--wf-danger);font-size:8px}.wf-node-security header span[data-complete=true]{color:var(--wf-success)}.wf-node-security>div{display:flex;flex-wrap:wrap;gap:5px;margin-top:9px}.wf-node-security code{padding:5px 7px;border:1px solid color-mix(in srgb,var(--wf-danger) 40%,var(--wf-border));border-radius:6px;background:var(--wf-surface);color:var(--wf-danger);font-size:8px}.wf-node-security code[data-declared=true]{border-color:color-mix(in srgb,var(--wf-success) 35%,var(--wf-border));color:var(--wf-success)}.wf-node-security p{margin:9px 0 0;color:var(--wf-muted);font-size:8px;line-height:1.45}
.wf-trace-head .wf-subtle,.wf-trace-head .wf-copy-run{font-size:9px;color:var(--wf-muted)}.wf-run-failure{flex:0 0 270px;display:grid;grid-template-columns:30px 1fr;align-items:center;padding:8px 10px;border:1px solid color-mix(in srgb,var(--wf-danger) 38%,var(--wf-border));border-radius:9px;background:color-mix(in srgb,var(--wf-danger) 7%,var(--wf-surface));color:var(--wf-text)}.wf-run-failure>span{color:var(--wf-danger);font-size:18px}.wf-run-failure div{display:grid;gap:4px}.wf-run-failure small{color:var(--wf-muted);font-size:8px;line-height:1.35}.wf-events button[data-tone=danger]{border-color:color-mix(in srgb,var(--wf-danger) 45%,var(--wf-border))}.wf-events button[data-tone=success]{border-color:color-mix(in srgb,var(--wf-success) 34%,var(--wf-border))}.wf-events button[data-tone=warning]{border-color:color-mix(in srgb,var(--wf-warning) 40%,var(--wf-border))}
.wf-studio[data-surface=operations]>.wf-palette,.wf-studio[data-surface=operations]>.wf-canvas,.wf-studio[data-surface=operations]>.wf-inspector,.wf-studio[data-surface=operations]>.wf-trace{display:none}.wf-operations{grid-row:2/4;grid-column:1/-1;overflow:auto;padding:30px;background:var(--wf-bg);color:var(--wf-text)}.wf-operations>header{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;max-width:1320px;margin:0 auto 25px}.wf-operations>header p{margin:0 0 8px;color:var(--wf-brand);font-size:9px;font-weight:800;letter-spacing:.18em}.wf-operations>header h1{margin:0 0 8px;font-size:24px}.wf-operations>header span{color:var(--wf-muted);font-size:10px}.wf-operations>header button{height:36px;padding:0 14px;border:1px solid var(--wf-border);border-radius:8px;background:var(--wf-surface);color:var(--wf-text);cursor:pointer}.wf-operations-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;max-width:1320px;margin:auto}.wf-operations-grid>section{min-height:360px;padding:15px;border:1px solid var(--wf-border);border-radius:14px;background:var(--wf-surface)}.wf-operations-grid h2{display:flex;justify-content:space-between;margin:0 0 13px;font-size:12px}.wf-operations-grid h2 em{font-style:normal;color:var(--wf-brand)}.wf-operations-grid article{position:relative;display:grid;gap:6px;margin-bottom:8px;padding:12px;border:1px solid var(--wf-border);border-radius:9px;background:var(--wf-surface-soft)}.wf-operations-grid article[data-status=rejected],.wf-operations-grid article[data-status=unknown]{border-color:color-mix(in srgb,var(--wf-danger) 40%,var(--wf-border))}.wf-operations-grid article b{font-size:10px}.wf-operations-grid article code{color:var(--wf-brand);font-size:8px}.wf-operations-grid article span,.wf-operations-grid article small{overflow:hidden;color:var(--wf-muted);font-size:8px;text-overflow:ellipsis;white-space:nowrap}.wf-operations-grid article button{position:absolute;right:9px;top:9px;border:0;background:transparent;color:var(--wf-brand);font-size:8px;cursor:pointer}.wf-operation-empty{display:grid;place-items:center;min-height:260px;color:var(--wf-success);font-size:24px}.wf-operation-empty span{color:var(--wf-muted);font-size:9px}@media(max-width:900px){.wf-operations-grid{grid-template-columns:1fr}.wf-operations{padding:18px}}
.wf-modal-backdrop{position:absolute;inset:0;z-index:50;display:grid;place-items:center;background:rgba(16,24,40,.34);backdrop-filter:blur(4px)}.wf-modal{width:min(440px,calc(100% - 36px));padding:28px;border:1px solid var(--wf-border);border-radius:17px;background:var(--wf-surface);box-shadow:0 26px 80px rgba(16,24,40,.3);color:var(--wf-text)}.wf-modal-icon{display:grid;place-items:center;width:42px;height:42px;border-radius:12px;background:var(--wf-brand-soft);color:var(--wf-brand);font-size:22px}.wf-modal h2{margin:17px 0 8px;font-size:19px}.wf-modal p{margin:0;color:var(--wf-muted);font-size:11px;line-height:1.7}.wf-modal>div{display:flex;justify-content:flex-end;gap:8px;margin-top:24px}.wf-modal button{height:36px;padding:0 15px;border:1px solid var(--wf-border);border-radius:8px;background:var(--wf-surface-soft);color:var(--wf-text);cursor:pointer}.wf-modal .wf-primary{border-color:var(--wf-brand);background:var(--wf-brand);color:#fff}
@media(max-width:900px){.wf-welcome-actions{grid-template-columns:1fr}.wf-welcome{width:calc(100% - 36px);padding:22px}.wf-welcome-actions button{min-height:68px}.wf-document-state{display:none}.wf-actions button:nth-child(-n+2){display:inline-flex}.wf-system-banner,.wf-error-banner{width:calc(100% - 24px)}}
`
