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
  useId,
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
  CanvasPublishedRevision,
  CanvasRunDetails,
  CanvasRunStartRequest,
  CanvasTemplateDiff,
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
import { WorkflowRunHistory } from './run-history.js'
import { useRunStop, useRunWatch } from './run-watch.js'
import { WorkflowResultView } from './result-view.js'
import { clearPendingRunIdentity, downloadCanvasFile, getPendingRunIdentity, parseCanvasTemplate, readFavorites, readInputPresets, readLastDraft, rememberLastDraft, writeFavorites, writeInputPresets } from './personal.js'
import { WorkflowRevisions } from './revisions.js'
import { BindingPicker } from './binding-picker.js'
import { DraftFieldsContext, DraftJsonField, focusDraftField, type PendingDraftField } from './draft-fields.js'
import { WorkflowHome, type CanvasHomeScope } from './home.js'
import { WorkflowOperationsPanel } from './operations.js'
import { RunInputForm, runInputFields } from './input-form.js'
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
  runStatusLabel,
  serializeRecoverySnapshot,
  starterInputs,
  starterTemplate,
  visibleTraceEvents,
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
interface DocumentVersion { readonly generation: number; readonly edits: number }
interface DraftWrite extends DocumentVersion {
  readonly template: CanvasWorkflowTemplate
  readonly draft: CanvasWorkflowDraft | undefined
}
interface ActiveRun {
  readonly runId: string
  readonly template: CanvasWorkflowTemplate
  readonly revision?: number
}
interface HistoryTarget {
  readonly runId: string
  readonly graph?: boolean
  readonly nodeId?: string
}
const nodeTypes = { workflow: WorkflowNodeView }

export function WorkflowStudio({ api, sessionId, initialTemplate, initialTarget, onClose, locale }: WorkflowStudioProps) {
  const language = useCanvasLocale(locale)
  const t = canvasText(language)
  const paletteId = useId()
  const graphLabels = useMemo(() => ({
    'controls.ariaLabel': t('Canvas controls'),
    'controls.zoomIn.ariaLabel': t('Zoom in'),
    'controls.zoomOut.ariaLabel': t('Zoom out'),
    'controls.fitView.ariaLabel': t('Fit view'),
    'minimap.ariaLabel': t('Canvas minimap'),
  }), [t])
  const [initialRecovery] = useState(() => {
    if (initialTemplate !== undefined) return undefined
    const snapshot = readRecovery(sessionId)
    return initialTarget?.templateId === undefined || snapshot?.template.metadata.id === initialTarget.templateId ? snapshot : undefined
  })
  const recoveryId = useRef(initialRecovery?.template.metadata.id)
  const recoveryWritable = useRef(true)
  const [definitions, setDefinitions] = useState<readonly CanvasNodeDefinition[]>([])
  const [catalog, setCatalog] = useState<readonly CanvasCatalogSummary[]>([])
  const [draft, setDraft] = useState<CanvasWorkflowDraft | undefined>(initialRecovery?.draft)
  const [template, setTemplate] = useState<CanvasWorkflowTemplate>(() => initialTemplate ?? initialRecovery?.template ?? blankTemplate(undefined, language))
  const [pendingFields, setPendingFields] = useState(() => new Map(initialRecovery?.pendingFields?.map(field => [field.id, field])))
  const pendingFieldsRef = useRef(pendingFields)
  const [requestedField, setRequestedField] = useState<PendingDraftField>()
  const documentVersion = useRef<DocumentVersion>({ generation: 0, edits: 0 })
  const writer = useRef<DraftWrite>()
  const markEdited = useCallback(() => {
    const version = documentVersion.current
    documentVersion.current = { ...version, edits: version.edits + 1 }
  }, [])
  const markReplaced = useCallback(() => {
    documentVersion.current = { generation: documentVersion.current.generation + 1, edits: 0 }
  }, [])
  const [selectedNode, setSelectedNode] = useState<string | undefined>(initialTarget?.nodeId)
  const [diagnostics, setDiagnostics] = useState<readonly CanvasWorkflowDiagnostic[]>([])
  const [diff, setDiff] = useState<CanvasTemplateDiff>()
  const [activeRun, setActiveRun] = useState<ActiveRun>()
  const runId = activeRun?.runId
  const runWatch = useRunWatch(api, sessionId, runId, 200)
  const runStop = useRunStop(api, sessionId, runId)
  const { trace, read: readTrace } = runWatch
  const startRequest = useRef<Awaited<ReturnType<typeof getPendingRunIdentity>>>()
  const [rightPanel, setRightPanel] = useState<RightPanel>('inspector')
  const [inputsText, renderInputsText] = useState(initialRecovery?.inputsText ?? '{}')
  const latestInputs = useRef(inputsText)
  const setInputsText = useCallback((value: string) => {
    latestInputs.current = value
    renderInputsText(value)
  }, [])
  const [formInputs, setFormInputs] = useState<CanvasJsonObject>()
  const runInputsByDraft = useRef(new Map<string, string>())
  const runInputEditor = useRef<HTMLTextAreaElement>(null)
  const [presetName, setPresetName] = useState('')
  const [presetRevision, setPresetRevision] = useState(0)
  const [favorites, setFavorites] = useState(() => readFavorites(sessionId))
  const [lastOpened, setLastOpened] = useState(() => readLastDraft(sessionId))
  const [scope, setScope] = useState<CanvasHomeScope>({ sessionId })
  const [revisionPanel, setRevisionPanel] = useState<{ id: string; inputs: string; revision?: number }>()
  const [previous, setPrevious] = useState<readonly CanvasWorkflowTemplate[]>([])
  const [redo, setRedo] = useState<readonly CanvasWorkflowTemplate[]>([])
  const [paletteQuery, setPaletteQuery] = useState('')
  const [paletteGroup, setPaletteGroup] = useState<PaletteGroup>('nodes')
  const [documentState, setDocumentState] = useState<WorkflowDocumentState>(initialRecovery !== undefined ? 'dirty' : initialTemplate === undefined ? 'pristine' : 'unsaved')
  const currentDocument = useRef({ id: template.metadata.id, state: documentState })
  currentDocument.current = { id: template.metadata.id, state: documentState }
  const [connectionState, setConnectionState] = useState<WorkflowConnectionState>('connecting')
  const [activity, setActivity] = useState<Activity>({ message: initialRecovery === undefined ? 'Ready to work' : 'Unsaved Canvas restored' })
  const [busy, setBusy] = useState(false)
  const pendingActions = useRef(0)
  const [requestError, setError] = useState<WorkflowErrorPresentation>()
  const error = requestError === undefined ? undefined : classifyWorkflowError(requestError.detail, language)
  const [showInfrastructureEvents, setShowInfrastructureEvents] = useState(false)
  const [confirmPublish, setConfirmPublish] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const [surface, setSurface] = useState<'home' | 'design' | 'operations' | 'history'>(() =>
    initialTemplate === undefined && initialTarget?.templateId === undefined && initialTarget?.runId === undefined && initialRecovery === undefined ? 'home' : 'design')
  const [historyTarget, setHistoryTarget] = useState<HistoryTarget>()
  const [operations, setOperations] = useState<CanvasOperationsSnapshot>({ bindings: [], ingress: [], deliveryAttention: [] })
  const [recoveryNotice, setRecoveryNotice] = useState(initialRecovery !== undefined)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>()
  const runStatus = trace?.status ?? (runId === undefined ? undefined : 'running')
  const stopping = runStatus === 'running' && runStop.phase === 'requesting'
  const inputFields = useMemo(() => runInputFields(template.spec.inputSchema), [template.spec.inputSchema])
  const presets = useMemo(() => readInputPresets(sessionId, template.metadata.id), [presetRevision, sessionId, template.metadata.id])
  const recordLastDraft = useCallback((id: string) => { setLastOpened(id); rememberLastDraft(sessionId, id) }, [sessionId])
  const replacePendingFields = useCallback((next: typeof pendingFields) => {
    pendingFieldsRef.current = next
    setPendingFields(next)
  }, [])
  const updatePendingField = useCallback((field: PendingDraftField, valid: boolean) => {
    const current = pendingFieldsRef.current.get(field.id)
    if (valid ? current === undefined : current?.text === field.text) return
    const next = new Map(pendingFieldsRef.current)
    if (valid) next.delete(field.id)
    else next.set(field.id, field)
    markEdited()
    replacePendingFields(next)
    setDocumentState(draft === undefined ? 'unsaved' : 'dirty')
  }, [draft, markEdited, replacePendingFields])
  const focusUnfinishedField = useCallback(() => {
    const field = pendingFieldsRef.current.values().next().value
    if (field === undefined) return false
    setSelectedNode(field.nodeId)
    setRightPanel('inspector')
    setSurface('design')
    setRequestedField(field)
    setActivity({ message: 'Fix the highlighted draft field before continuing' })
    return true
  }, [])
  const draftFields = useMemo(() => ({ pending: pendingFields, update: updatePendingField }), [pendingFields, updatePendingField])
  useEffect(() => {
    if (requestedField === undefined) return
    if (focusDraftField(requestedField.id)) setRequestedField(undefined)
  }, [requestedField, rightPanel, selectedNode, surface])

  const execute = useCallback(async <T,>(action: CanvasMessage, operation: () => Promise<T>): Promise<T | undefined> => {
    pendingActions.current++
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
      if (--pendingActions.current === 0) setBusy(false)
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
  const refreshAfterMutation = useCallback(() => {
    void refreshCatalog().catch(() => setConnectionState('disconnected'))
  }, [refreshCatalog])

  const refreshOperations = useCallback(() => execute('Refresh trigger and delivery records', async () => {
    const value = await api.request('workflowCanvas.operations', () => api.remote.operations(sessionId, { limit: 200 }), { retries: 1 })
    setOperations(value)
    return value
  }), [api, execute, sessionId])

  useEffect(() => { void syncCatalog() }, [syncCatalog])
  useEffect(() => {
    let current = true
    void api.request('workflowCanvas.context', () => api.remote.context(sessionId), { retries: 1 })
      .then(value => { if (current && value.sessionId === sessionId) setScope(value) }).catch(() => { /* Scoped session ID remains available locally. */ })
    return () => { current = false }
  }, [api, sessionId])

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

  const clearOwnRecovery = useCallback(() => {
    if (recoveryId.current !== undefined) clearRecovery(sessionId, recoveryId.current)
    recoveryId.current = undefined
  }, [sessionId])
  const persistRecovery = useCallback(() => {
    if (!recoveryWritable.current) return false
    const written = writeRecovery(sessionId, {
      version: 1, template, ...(draft === undefined ? {} : { draft }), inputsText: latestInputs.current,
      pendingFields: [...pendingFieldsRef.current.values()], savedAt: Date.now(),
    })
    if (written) recoveryId.current = template.metadata.id
    return written
  }, [draft, sessionId, template])

  useEffect(() => {
    if (!hasUnsavedChanges(documentState)) return
    const timer = setTimeout(persistRecovery, 250)
    const flushWhenHidden = () => { if (document.visibilityState === 'hidden') persistRecovery() }
    document.addEventListener('visibilitychange', flushWhenHidden)
    window.addEventListener('pagehide', persistRecovery)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', flushWhenHidden)
      window.removeEventListener('pagehide', persistRecovery)
    }
  }, [documentState, inputsText, pendingFields, persistRecovery])

  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedChanges(documentState)) return
      event.preventDefault()
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [documentState])

  const editorTrace = activeRun?.revision === undefined && activeRun?.template === template ? trace : undefined
  const flow = useMemo(() => templateToFlow(template, definitions, editorTrace), [template, definitions, editorTrace])
  const selected = template.spec.nodes.find(node => node.id === selectedNode)
  const filteredDefinitions = useMemo(() => {
    const query = paletteQuery.trim().toLocaleLowerCase()
    return definitions.filter(definition => definitionGroup(definition) === paletteGroup)
      .filter(definition => query.length === 0 || [definitionDisplayTitle(definition, language), definitionDisplayDescription(definition, language), definition.title, definition.description, definition.uses, definition.toolName]
      .some(value => value?.toLocaleLowerCase().includes(query)))
  }, [definitions, language, paletteGroup, paletteQuery])

  const storeDraft = useCallback(async (snapshot: DraftWrite): Promise<CanvasWorkflowDraft> => {
    const { draft, template } = snapshot
    const next = draft === undefined
      ? await api.request('workflowCanvas.createDraft', () => api.remote.createDraft(sessionId, { template }))
      : await api.request('workflowCanvas.updateDraft', () => api.remote.updateDraft(sessionId, {
          id: draft.id, expectedRevision: draft.revision, template,
        }))
    if (documentVersion.current.generation === snapshot.generation) {
      setDraft(next)
      recordLastDraft(next.id)
      runInputsByDraft.current.set(next.id, latestInputs.current)
      if (versionMatches(documentVersion.current, snapshot)) {
        setTemplate(next.template)
        setDocumentState('saved')
        clearOwnRecovery()
      } else setDocumentState('dirty')
    }
    refreshAfterMutation()
    return next
  }, [api, clearOwnRecovery, recordLastDraft, refreshAfterMutation, sessionId])

  const writeDocument = useCallback(async <T,>(action: CanvasMessage, perform: (snapshot: DraftWrite) => Promise<T>) => {
    if (writer.current !== undefined) return undefined
    const snapshot = { ...documentVersion.current, draft, template }
    writer.current = snapshot
    try { return await execute(action, () => perform(snapshot)) }
    finally { writer.current = undefined }
  }, [draft, execute, template])

  const save = useCallback(() => focusUnfinishedField() ? undefined : writeDocument('Save draft', storeDraft), [focusUnfinishedField, storeDraft, writeDocument])
  useEffect(() => {
    const onSaveShortcut = (event: KeyboardEvent) => {
      if (surface !== 'design' || (!event.metaKey && !event.ctrlKey) || event.key.toLowerCase() !== 's') return
      const target = event.target
      if (!(target instanceof Element) || target.closest('[data-workflow-studio]') === null || target.closest('dialog[open]') !== null) return
      event.preventDefault()
      if (!busy && hasUnsavedChanges(documentState)) void save()
    }
    window.addEventListener('keydown', onSaveShortcut)
    return () => window.removeEventListener('keydown', onSaveShortcut)
  }, [busy, documentState, save, surface])

  const checkReadiness = useCallback(async (candidate: CanvasWorkflowTemplate, inputs: CanvasJsonObject | undefined): Promise<readonly CanvasWorkflowDiagnostic[]> => {
    if (inputs === undefined) return [{ code: 'CANVAS_RUN_INPUT_JSON_INVALID', severity: 'error', message: '', path: ['inputs'] }]
    const { diagnostics: issues } = await api.request('workflowCanvas.validate', () => api.remote.validate(sessionId, { template: candidate, inputs }), { retries: 1 })
    return issues
  }, [api, sessionId])

  const validate = useCallback(async () => {
    if (focusUnfinishedField()) return
    const requested = documentVersion.current
    const source = latestInputs.current
    const valid = await execute('Validate workflow', async () => {
      const issues = await checkReadiness(template, parseRunInputs(source))
      if (!versionMatches(documentVersion.current, requested) || latestInputs.current !== source) return undefined
      setDiagnostics(issues)
      setRightPanel('diagnostics')
      if (issues.some(item => item.severity === 'error')) return false
      setDocumentState(current => hasUnsavedChanges(current) ? 'validated-dirty' : 'validated')
      return true
    })
    if (valid === false) setActivity({ message: 'Fix the reported issues before running' })
  }, [checkReadiness, execute, focusUnfinishedField, template])

  const showDiff = useCallback(async () => {
    if (focusUnfinishedField()) return
    if (draft === undefined) { setError(classifyWorkflowError('catalog diff requires a saved draft')); return }
    const requested = documentVersion.current
    await execute('Compare changes', async () => {
      const value = await api.request('workflowCanvas.diff', () => api.remote.diff(sessionId, { id: draft.id, candidate: template }), { retries: 1 })
      if (!versionMatches(documentVersion.current, requested)) return undefined
      setDiff(value)
      setRightPanel('diff')
      return value
    })
  }, [api, draft, execute, focusUnfinishedField, sessionId, template])

  const publish = useCallback(async () => {
    setConfirmPublish(false)
    if (focusUnfinishedField()) return
    const result = await writeDocument('Publish workflow', async snapshot => {
      const saved = snapshot.draft !== undefined && !hasUnsavedChanges(documentState) ? snapshot.draft : await storeDraft(snapshot)
      const published = await api.request('workflowCanvas.publish', () => api.remote.publish(sessionId, {
        id: saved.id,
        expectedRevision: saved.revision,
      }))
      const unchanged = versionMatches(documentVersion.current, snapshot)
      if (unchanged) setDocumentState('published')
      refreshAfterMutation()
      return { revision: published.revision, unchanged }
    })
    if (result !== undefined) setActivity({
      message: result.unchanged ? 'Published as immutable revision {revision}' : 'Published revision {revision}. Newer edits remain in the draft.',
      values: { revision: result.revision },
    })
  }, [api, documentState, focusUnfinishedField, refreshAfterMutation, sessionId, storeDraft, writeDocument])

  const loadDraft = useCallback(async (id: string) => execute('Open draft', async () => {
    if (writer.current !== undefined) return undefined
    const requested = documentVersion.current
    const value = await api.request('workflowCanvas.readDraft', () => api.remote.readDraft(sessionId, { id }), { retries: 1 })
    if (writer.current !== undefined || !versionMatches(documentVersion.current, requested)) return undefined
    markReplaced()
    replacePendingFields(new Map())
    setDraft(value)
    setTemplate(value.template)
    recordLastDraft(value.id)
    setPrevious([])
    setRedo([])
    setInputsText(runInputsByDraft.current.get(value.id) ?? '{}')
    setDocumentState('saved')
    clearOwnRecovery()
    setSelectedNode(undefined)
    setDiagnostics([])
    setDiff(undefined)
    setActiveRun(undefined)
    setRightPanel('inspector')
    setSurface('design')
    return value
  }), [api, clearOwnRecovery, execute, markReplaced, recordLastDraft, replacePendingFields, sessionId, setInputsText])

  useEffect(() => {
    const { templateId, nodeId, runId: targetRun } = initialTarget ?? {}
    async function openTarget() {
      if (targetRun !== undefined) {
        setHistoryTarget({ runId: targetRun, ...(nodeId === undefined ? {} : { graph: true, nodeId }) })
        setSurface('history')
        return
      }
      if (templateId !== undefined && currentDocument.current.id !== templateId) {
        if (hasUnsavedChanges(currentDocument.current.state) && !window.confirm(t('Discard the unsaved changes to this workflow?'))) return
        if (await loadDraft(templateId) === undefined) return
      }
      if (templateId !== undefined) setSurface('design')
      if (nodeId !== undefined) setSelectedNode(nodeId)
    }
    void openTarget()
  }, [initialTarget, loadDraft, t])

  const hasHostEffects = useCallback((candidate: CanvasWorkflowTemplate) =>
    candidate.spec.nodes.some(node => findNodeDefinition(definitions, node)?.effects !== 'deterministic'), [definitions])

  const admitRun = useCallback(async (target: CanvasRunStartRequest['target'], inputs: CanvasJsonObject) => {
    const identity = await getPendingRunIdentity(sessionId, { target, inputs }, startRequest.current)
    startRequest.current = identity
    const receipt = await api.request('workflowCanvas.startRun', () => api.remote.startRun(sessionId, { target, inputs, requestId: identity.requestId }), { retries: 1 })
    clearPendingRunIdentity(sessionId, identity)
    if (startRequest.current === identity) startRequest.current = undefined
    return receipt
  }, [api, sessionId])

  const restartWorkflow = useCallback(async (details: CanvasRunDetails, inputs: CanvasJsonObject) => {
    const diagnostics = await checkReadiness(details.template, inputs)
    if (diagnostics.some(item => item.severity === 'error')) return { diagnostics }
    const target: CanvasRunStartRequest['target'] = details.revision === undefined
      ? { type: 'draft', template: details.template }
      : { type: 'published', id: details.template.metadata.id, revision: details.revision }
    const receipt = await admitRun(target, inputs)
    return { runId: receipt.runId, diagnostics }
  }, [admitRun, checkReadiness])

  const runWorkflow = useCallback(async (published?: CanvasPublishedRevision, publishedInputs?: CanvasJsonObject) => {
    if (published === undefined && focusUnfinishedField()) return
    const candidate = published?.template ?? template
    const requested = documentVersion.current
    const source = latestInputs.current
    const inputs = publishedInputs ?? parseRunInputs(source)
    const launched = await execute(published === undefined ? 'Run draft' : 'Run published revision', async () => {
      const diagnostics = await checkReadiness(candidate, inputs)
      if (published === undefined && versionMatches(documentVersion.current, requested) && latestInputs.current === source) {
        setDiagnostics(diagnostics)
        if (diagnostics.length > 0) setRightPanel('diagnostics')
      }
      if (inputs === undefined || diagnostics.some(item => item.severity === 'error')) return { diagnostics }
      if (hasHostEffects(candidate) && !window.confirm(t('This run may call real host tools or agents. Start the run?'))) return
      const target: CanvasRunStartRequest['target'] = published === undefined
        ? { type: 'draft', template }
        : { type: 'published', id: published.id, revision: published.revision }
      const receipt = await admitRun(target, inputs)
      setRevisionPanel(undefined)
      if (documentVersion.current.generation === requested.generation) {
        if (published === undefined || candidate.metadata.id === template.metadata.id) {
          setActiveRun({ runId: receipt.runId, template: candidate, ...(published === undefined ? {} : { revision: published.revision }) })
        }
        if (published !== undefined) {
          setHistoryTarget({ runId: receipt.runId, graph: true })
          setSurface('history')
        }
      }
      return { accepted: true as const }
    })
    if (launched?.accepted) setActivity({ message: 'Run accepted' })
    if (launched?.diagnostics !== undefined && published === undefined && versionMatches(documentVersion.current, requested)) {
      setActivity({ message: 'Fix the reported issues before running' })
    }
    return launched?.diagnostics
  }, [admitRun, checkReadiness, execute, focusUnfinishedField, hasHostEffects, t, template])

  const cancelRun = useCallback(async () => {
    if (runId === undefined || !window.confirm(t('Request stop? A running Host action may finish first.'))) return
    await execute('Cancel run', async () => {
      const result = await runStop.stop(runId, 'cancelled from Canvas')
      await readTrace()
      return result
    })
  }, [execute, readTrace, runId, runStop.stop, t])

  const removeOrphanPendingFields = useCallback((next: CanvasWorkflowTemplate) => {
    const fields = pendingFieldsRef.current
    const valid = [...fields].filter(([, field]) => field.nodeId === undefined || next.spec.nodes.some(node => node.id === field.nodeId))
    if (valid.length !== fields.size) replacePendingFields(new Map(valid))
  }, [replacePendingFields])

  const mutate = useCallback((next: CanvasWorkflowTemplate) => {
    if (next === template) return
    markEdited()
    removeOrphanPendingFields(next)
    setPrevious(items => [...items.slice(-49), template])
    setRedo([])
    setTemplate(bindWorkflowId(next, draft?.id ?? writer.current?.template.metadata.id))
    setDiagnostics([])
    setDocumentState(draft === undefined ? 'unsaved' : 'dirty')
    setActivity(draft === undefined
      ? { message: 'Unsaved' }
      : { message: 'Draft revision {revision} has unsaved changes', values: { revision: draft.revision } })
  }, [draft, markEdited, removeOrphanPendingFields, template])

  const stepEdit = (direction: 'undo' | 'redo') => {
    const stack = direction === 'undo' ? previous : redo
    const next = stack.at(-1)
    if (next === undefined) return
    markEdited()
    removeOrphanPendingFields(next)
    if (direction === 'undo') {
      setPrevious(stack.slice(0, -1))
      setRedo(items => [...items, template])
    } else {
      setRedo(stack.slice(0, -1))
      setPrevious(items => [...items.slice(-49), template])
    }
    setTemplate(bindWorkflowId(next, draft?.id ?? writer.current?.template.metadata.id))
    setDiagnostics([])
    setSelectedNode(undefined)
    setDocumentState(draft === undefined ? 'unsaved' : 'dirty')
  }

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
  const onNodesDelete = useCallback((nodes: WorkflowFlowNode[]) => {
    if (nodes.length === 0) return
    mutate(nodes.reduce((candidate, node) => removeNode(candidate, node.id), template))
    setSelectedNode(undefined)
  }, [mutate, template])

  const confirmDiscard = useCallback(() => !hasUnsavedChanges(documentState)
    || window.confirm(t('Discard the unsaved changes to this workflow?')), [documentState, t])
  const startNew = useCallback(() => {
    if (writer.current !== undefined || !confirmDiscard()) return
    markReplaced()
    replacePendingFields(new Map())
    setDraft(undefined)
    setTemplate(blankTemplate(undefined, language))
    setPrevious([])
    setRedo([])
    setInputsText('{}')
    setSelectedNode(undefined)
    setActiveRun(undefined)
    setDiagnostics([])
    setDiff(undefined)
    setRightPanel('inspector')
    setSurface('design')
    setDocumentState('pristine')
    setRecoveryNotice(false)
    setActivity({ message: 'Created a blank workflow' })
    clearOwnRecovery()
  }, [clearOwnRecovery, confirmDiscard, language, markReplaced, replacePendingFields, setInputsText])
  const openDraftSafely = useCallback((id: string) => {
    if (id === '' || !confirmDiscard()) return
    void loadDraft(id)
  }, [confirmDiscard, loadDraft])
  const closeSafely = useCallback(() => {
    if (onClose === undefined) return
    if (writer.current !== undefined) { setActivity({ message: 'Wait for the current action to finish' }); return }
    if (hasUnsavedChanges(documentState)) setConfirmClose(true)
    else onClose()
  }, [documentState, onClose])
  const useStarter = useCallback(() => {
    if (writer.current !== undefined || !confirmDiscard()) return
    clearOwnRecovery()
    markReplaced()
    replacePendingFields(new Map())
    setDraft(undefined)
    setTemplate(starterTemplate(undefined, language))
    setPrevious([])
    setRedo([])
    setSelectedNode(undefined)
    setActiveRun(undefined)
    setDiagnostics([])
    setDiff(undefined)
    setRightPanel('inspector')
    setSurface('design')
    setInputsText(JSON.stringify(starterInputs(language), null, 2))
    setDocumentState('unsaved')
    setRecoveryNotice(false)
    setActivity({ message: 'Example ready for a test run' })
  }, [clearOwnRecovery, confirmDiscard, language, markReplaced, replacePendingFields, setInputsText])
  const copyRunText = useCallback(async (text: string, feedback: CanvasMessage) => {
    try {
      await navigator.clipboard.writeText(text)
      setError(undefined)
      setActivity({ message: feedback })
    } catch (cause: unknown) { setError(classifyWorkflowError(cause)) }
  }, [])
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
  const failureDetail = trace?.error
  const runFailure = runStatus === 'failed' && failureDetail !== undefined ? classifyWorkflowError(failureDetail, language) : undefined
  const failedNodeId = activeRun?.template.spec.nodes.find(node => trace?.nodeStates[node.id] === 'failed')?.id
  const outputs = trace?.outputs
  const selectedOutput = selectedNode === undefined ? undefined : editorTrace?.nodeOutputs[selectedNode]
  const selectedProgress = selectedNode === undefined ? undefined : editorTrace?.nodeProgress[selectedNode]
  const selectedFailure = selectedNode === undefined || editorTrace === undefined ? undefined : traceEvents.findLast(event => event.nodeId === selectedNode && event.tone === 'danger')?.detail
  const inputInvalid = diagnostics.some(isRunInputIssue)

  const inspectNode = (id: string) => { setSelectedNode(id); setRightPanel('inspector') }
  const addPaletteNode = (definition: CanvasNodeDefinition) => {
    const reference = nodes.find(node => node.id === selectedNode)?.position
    const origin = reference === undefined ? { x: 140, y: 100 } : { x: reference.x + 276, y: reference.y }
    let position = origin
    for (let index = 0; nodes.some(node => Math.abs(node.position.x - position.x) < 240 && Math.abs(node.position.y - position.y) < 134); index++) {
      position = { x: origin.x + ((index + 1) % 3) * 276, y: origin.y + Math.floor((index + 1) / 3) * 144 }
    }
    const next = addNode(template, definition, position)
    mutate(next)
    const id = next.spec.nodes.at(-1)?.id
    if (id !== undefined) inspectNode(id)
  }
  const updateRunInput = (value: string) => {
    setInputsText(value)
    if (draft !== undefined) runInputsByDraft.current.set(draft.id, value)
    setDiagnostics(current => current.filter(item => !isRunInputIssue(item)))
  }

  const reportLocalError = (cause: unknown) => setError(classifyWorkflowError(cause))
  const favorite = favorites.includes(template.metadata.id)
  const toggleFavorite = () => {
    const next = favorite ? favorites.filter(id => id !== template.metadata.id) : [...favorites, template.metadata.id]
    try { writeFavorites(sessionId, next); setFavorites(next) } catch (cause: unknown) { reportLocalError(cause) }
  }
  const orderedCatalog = [...catalog].sort((left, right) => Number(favorites.includes(right.id)) - Number(favorites.includes(left.id)))

  const savePreset = () => {
    const name = presetName.trim()
    const inputs = parseRunInputs(inputsText)
    if (name.length === 0 || name.length > 100 || inputs === undefined) return
    if (presets.some(item => item.name === name) && !window.confirm(t('Replace this input preset?'))) return
    try {
      writeInputPresets(sessionId, template.metadata.id, [...presets.filter(item => item.name !== name), { name, inputs }])
      setPresetName('')
      setPresetRevision(current => current + 1)
      setActivity({ message: 'Input preset saved' })
    } catch (cause: unknown) { reportLocalError(cause) }
  }
  const deletePreset = (name: string) => {
    try {
      writeInputPresets(sessionId, template.metadata.id, presets.filter(item => item.name !== name))
      setPresetRevision(current => current + 1)
    } catch (cause: unknown) { reportLocalError(cause) }
  }
  const clearPresets = () => {
    if (!window.confirm(t('Remove all saved input presets for this workflow on this device?'))) return
    try {
      writeInputPresets(sessionId, template.metadata.id, [])
      setPresetRevision(current => current + 1)
      setActivity({ message: 'Saved input presets cleared' })
    } catch (cause: unknown) { reportLocalError(cause) }
  }
  const importInputs = async (file: File) => {
    try {
      if (file.size > 1_000_000) throw new Error(t('JSON file exceeds the Canvas import limit'))
      const text = await file.text()
      if (parseRunInputs(text) === undefined) throw new Error(t('Run input must be a valid JSON object.'))
      updateRunInput(text)
      setActivity({ message: 'Inputs imported' })
    } catch (cause: unknown) { reportLocalError(cause) }
  }
  const changeDocument = (next: CanvasWorkflowTemplate) => {
    if (writer.current !== undefined) return false
    markReplaced()
    replacePendingFields(new Map())
    setDraft(undefined)
    setTemplate(next)
    setPrevious([])
    setRedo([])
    setSelectedNode(undefined)
    setActiveRun(undefined)
    setDiagnostics([])
    setDiff(undefined)
    setRightPanel('inspector')
    setSurface('design')
    setDocumentState('unsaved')
    setRecoveryNotice(false)
    clearOwnRecovery()
    return true
  }
  const useOrdersStarter = async () => {
    if (writer.current !== undefined || !confirmDiscard()) return
    const before = documentVersion.current
    await execute('Load order example', async () => {
      const sample = await api.request('workflowCanvas.starterOrders', () => api.remote.starterOrders(sessionId), { retries: 1 })
      if (!versionMatches(before, documentVersion.current) || writer.current !== undefined) return
      const example = { ...sample.template, metadata: { ...sample.template.metadata, id: `orders-starter-${Date.now()}`, name: t('Order normalization') } }
      if (!changeDocument(example)) return
      setInputsText(JSON.stringify(sample.inputs, null, 2))
      setSurface('design')
    })
  }
  const importTemplate = async (file: File) => {
    try {
      if (file.size > 1_000_000) throw new Error(t('JSON file exceeds the Canvas import limit'))
      const next = parseCanvasTemplate(await file.text())
      if (next === undefined) throw new Error(t('File does not contain a valid WorkflowTemplate JSON document'))
      if (confirmDiscard() && changeDocument(next)) {
        setInputsText('{}')
        setActivity({ message: 'Workflow JSON imported' })
      }
    } catch (cause: unknown) { reportLocalError(cause) }
  }
  const duplicate = () => {
    const ids = new Set(catalog.map(item => item.id))
    const stem = `${template.metadata.id}-copy`
    let id = stem
    for (let suffix = 2; ids.has(id); suffix++) id = `${stem}-${suffix}`
    if (changeDocument({ ...template, metadata: { ...template.metadata, id, name: t('{name} copy', { name: template.metadata.name }) } })) {
      setActivity({ message: 'Workflow copied as a new draft' })
    }
  }

  const openHistory = (targetRun?: string, nodeId?: string, graph = false) => {
    setHistoryTarget(targetRun === undefined ? undefined : { runId: targetRun, graph, ...(nodeId === undefined ? {} : { nodeId }) })
    setSurface('history')
  }
  const inspectRunNode = (id: string) => {
    if (editorTrace !== undefined) inspectNode(id)
    else if (runId !== undefined) openHistory(runId, id, true)
  }
  const openOperations = () => {
    setSurface('operations')
    void refreshOperations()
  }
  const openFixedRevision = (id: string, revision: number) => {
    setError(undefined)
    setRevisionPanel({ id, revision, inputs: '{}' })
  }

  return <CanvasLocaleContext.Provider value={language}><DraftFieldsContext.Provider value={draftFields}><div className="wf-studio" data-workflow-studio data-surface={surface} data-has-run={runId !== undefined} lang={language}>
    <style>{STRUCTURE_CSS + PRODUCT_CSS + EXPERIENCE_CSS + PERSONAL_CSS}</style>
    <header className="wf-topbar">
      <div className="wf-brand">
        <span className="wf-brand-mark">D</span>
        <span><b>AGENT DAG WORKFLOW</b><small title={`${t('Current DSH session')} · ${scope.sessionId}`}>{t('Current DSH session')} · {scope.sessionId}</small></span>
      </div>
      {surface === 'design' ? <><div className="wf-doc-title">
        <span className="wf-status-dot" data-busy={busy} data-connection={connectionState} />
        <input value={template.metadata.name} aria-label={t('Workflow name')} onChange={event => mutate({
          ...template, metadata: { ...template.metadata, name: event.target.value },
        })} />
        <span className="wf-document-state" data-state={documentState}>{documentStateLabel(documentState, language)}</span>
        <code>{template.metadata.id}</code>
      </div>
      <div className="wf-guardrails" aria-label={t('Workflow safeguards')}>
        <span><i />{t('Dependencies: {count}', { count: template.spec.requires?.length ?? 0 })}</span><span><i />{t('Audited')}</span><span><i />{t('Schema validation')}</span>
      </div></> : <div className="wf-doc-title" />}
      <div className="wf-actions">
        {surface === 'design' ? null : <button onClick={() => setSurface('design')} disabled={busy}>{t('Back to Canvas')}</button>}
        {surface === 'home' ? null : <button onClick={() => setSurface('home')} disabled={busy}>{t('My workflows')}</button>}
        {surface === 'history' ? null : <button onClick={() => openHistory()} disabled={busy}>{t('Run history')}</button>}
        {surface === 'operations' ? null : <button onClick={openOperations} disabled={busy}>{t('Triggers & delivery')}</button>}
        {surface !== 'design' ? null : <>
        <button onClick={startNew} disabled={busy} title={busy ? t('Wait for the current action to finish') : t('Create a workflow')}>{t('New')}</button>
        <button onClick={() => void save()} disabled={busy || !hasUnsavedChanges(documentState)} title={busy ? t('Wait for the current action to finish') : !hasUnsavedChanges(documentState) ? t('The draft has no changes to save') : t('Save current draft')}>{t('Save')}</button>
        <button onClick={() => void validate()} disabled={busy} title={busy ? t('Wait for the current action to finish') : t('Validate using the runtime rules')}>{t('Validate')}</button>
        <details className="wf-local-menu">
          <summary>{t('Workflow actions')}</summary>
          <div>
            <button onClick={() => void showDiff()} disabled={busy || draft === undefined}>{t('Changes')}</button>
            <button onClick={() => stepEdit('undo')} disabled={busy || previous.length === 0}>{t('Undo')}</button>
            <button onClick={() => stepEdit('redo')} disabled={busy || redo.length === 0}>{t('Redo')}</button>
            <button onClick={duplicate} disabled={busy}>{t('Duplicate workflow')}</button>
            <button disabled={busy} onClick={() => downloadCanvasFile(new Blob([JSON.stringify(template, null, 2)], { type: 'application/json' }), `${template.metadata.id}.workflow.json`)}>{t('Export workflow JSON')}</button>
            <label>{t('Import workflow JSON')}<input type="file" accept=".json,application/json" disabled={busy} onChange={event => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''
              if (file !== undefined) void importTemplate(file)
            }} /></label>
          </div>
        </details>
        <button className="wf-primary" onClick={() => { if (!focusUnfinishedField()) setConfirmPublish(true) }} disabled={busy} title={busy ? t('Wait for the current action to finish') : t('Publish an immutable revision')}>{t('Publish')}</button>
        </>}
        {onClose === undefined ? null : <button className="wf-close" onClick={closeSafely} aria-label={t('Close workflow Canvas')}>×</button>}
      </div>
    </header>

    {connectionState !== 'connected' ? <div className="wf-system-banner" data-kind={connectionState === 'disconnected' ? 'danger' : 'info'}>
      <b>{connectionStateLabel(connectionState, language)}</b><span>{connectionState === 'disconnected' ? t('Your changes were kept. Sync will resume when the connection returns.') : t('Syncing nodes, tools, and drafts.')}</span>
      <button onClick={() => void syncCatalog()} disabled={busy}>{t('Retry now')}</button>
    </div> : null}
    {recoveryNotice ? <div className="wf-system-banner wf-recovery" data-kind="warning"><b>{t('Unsaved changes restored')}</b><span>{t('We restored the Canvas and run inputs from your previous session.')}</span><button onClick={() => setRecoveryNotice(false)}>{t('Dismiss')}</button></div> : null}
    {pendingFields.size === 0 || surface !== 'design' ? null : <div className="wf-system-banner wf-pending-fields" role="status" data-kind="warning"><b>{t('Unfinished draft fields')}</b><button onClick={focusUnfinishedField}>{t('Review unfinished fields')}</button></div>}
    {error === undefined || error.kind === 'connection' ? null : <div className="wf-error-banner" data-kind={error.kind}>
      <div><b>{error.title}</b><span>{error.message} {error.remedy}</span><details><summary>{t('Technical details')}</summary><code>{error.detail}</code></details></div>
      <div>{error.retryable ? <button onClick={() => void syncCatalog()}>{t('Retry')}</button> : null}
        {error.kind === 'conflict' ? <><button onClick={() => void copyTemplate()}>{t('Copy current JSON')}</button>{draft === undefined ? null : <button onClick={() => void loadDraft(draft.id)}>{t('Reload')}</button>}</> : null}
        <button onClick={() => setError(undefined)}>{t('Close')}</button></div>
    </div>}

    <aside className="wf-palette">
      <div className="wf-section-row"><SectionLabel index="01" text={t('Workflow')} /><div><button aria-pressed={favorite} disabled={draft === undefined || busy} onClick={toggleFavorite} aria-label={t(favorite ? 'Remove workflow favorite' : 'Favorite workflow')}>{favorite ? '★' : '☆'}</button><button onClick={() => void syncCatalog()} disabled={busy} title={t('Refresh drafts created by agents')}>↻</button></div></div>
      <select aria-label={t('Select workflow draft')} value={draft?.id ?? ''} disabled={busy} onChange={event => openDraftSafely(event.target.value)}>
        <option value="">{t('Select a draft…')}</option>
        {orderedCatalog.map(item => <option key={item.id} value={item.id}>{favorites.includes(item.id) ? '★ ' : ''}{item.name} · {t('Draft revision {revision}', { revision: item.draftRevision })}{item.publishedRevision === undefined ? '' : ` · ${t('Published {revision}', { revision: item.publishedRevision })}`}</option>)}
      </select>
      <SectionLabel index="02" text={t('Add nodes')} />
      <div className="wf-palette-tabs" role="tablist" aria-label={t('Node categories')} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        const group = event.key === 'Home' ? 'nodes' : event.key === 'End' ? 'tools' : paletteGroup === 'nodes' ? 'tools' : 'nodes'
        event.preventDefault()
        setPaletteGroup(group)
        document.getElementById(`${paletteId}-${group}`)?.focus()
      }}>
        <button role="tab" id={`${paletteId}-nodes`} aria-controls={`${paletteId}-panel`} aria-selected={paletteGroup === 'nodes'} tabIndex={paletteGroup === 'nodes' ? 0 : -1} data-active={paletteGroup === 'nodes'} onClick={() => setPaletteGroup('nodes')}>{t('Workflow nodes')} <span>{definitions.filter(item => item.kind === 'node').length}</span></button>
        <button role="tab" id={`${paletteId}-tools`} aria-controls={`${paletteId}-panel`} aria-selected={paletteGroup === 'tools'} tabIndex={paletteGroup === 'tools' ? 0 : -1} data-active={paletteGroup === 'tools'} onClick={() => setPaletteGroup('tools')}>{t('Agent tools')} <span>{definitions.filter(item => item.kind === 'tool').length}</span></button>
      </div>
      <div className="wf-palette-search"><span>⌕</span><input value={paletteQuery} onChange={event => setPaletteQuery(event.target.value)} placeholder={paletteGroup === 'nodes' ? t('Search workflow nodes…') : t('Search available agent tools…')} aria-label={t('Search workflow nodes')} /></div>
      <div className="wf-node-list" id={`${paletteId}-panel`} role="tabpanel" aria-labelledby={`${paletteId}-${paletteGroup}`}>
        {filteredDefinitions.length === 0 ? <p className="wf-list-empty">{t('No matches in this category')}</p> : filteredDefinitions.map(definition => <button
          key={definition.catalogId} className="wf-palette-node"
          onClick={() => addPaletteNode(definition)}
        ><span>{nodeGlyph(definition)}</span><b>{definitionDisplayTitle(definition, language)}</b><small>{definitionDisplayDescription(definition, language)}</small><em>{definition.kind === 'tool' ? t('Uses host permissions') : definition.uses}</em></button>)}
      </div>
      <div className="wf-palette-foot"><span>{t('Showing {count}', { count: filteredDefinitions.length })}</span><span>{t('Template v1')}</span></div>
    </aside>

    <main className="wf-canvas">
      <div className="wf-coordinate"><b>{t('Workflow Canvas')}</b><span>{t('Nodes: {nodes} · Edges: {edges}', { nodes: template.spec.nodes.length, edges: template.spec.edges.length })}</span></div>
      {definitions.length === 0 ? <div className="wf-canvas-loading">{t('Syncing nodes and tools…')}</div> : <ReactFlow
        nodes={nodes} edges={edges} nodeTypes={nodeTypes} ariaLabelConfig={graphLabels} fitView minZoom={0.25} maxZoom={1.8}
        onNodeClick={(_event, node) => inspectNode(node.id)}
        onPaneClick={() => setSelectedNode(undefined)}
        onNodeDragStop={(_event, node) => mutate(moveNode(template, node.id, node.position))}
        onConnect={onConnect} onEdgesDelete={onEdgesDelete} onNodesDelete={onNodesDelete} deleteKeyCode={['Backspace', 'Delete']}
      ><Background color="rgba(142, 153, 174, .24)" gap={24} size={1} variant={BackgroundVariant.Dots} /><Controls showInteractive={false} /><MiniMap pannable zoomable nodeColor={node => statusColor(String(node.data.status ?? 'pending'))} /></ReactFlow>}
      {definitions.length > 0 && template.spec.nodes.length === 0 ? <WelcomePanel catalog={catalog} onOpen={openDraftSafely} onStarter={useStarter} onAgentPrompt={() => void copyAgentPrompt()} /> : null}
    </main>

    <aside className="wf-inspector">
      <nav>{(['inspector', 'diagnostics', 'diff'] as const).map(panel => <button key={panel} data-active={rightPanel === panel} onClick={() => setRightPanel(panel)}>{panel === 'inspector' ? t('Settings') : panel === 'diagnostics' ? `${t('Issues')}${diagnostics.length > 0 ? ` ${diagnostics.length}` : ''}` : t('Changes')}</button>)}</nav>
      {rightPanel === 'inspector' ? selected === undefined
        ? <WorkflowInspector key={documentVersion.current.generation} template={template} saved={draft !== undefined || writer.current !== undefined} onChange={mutate} />
        : <NodeInspector key={`${documentVersion.current.generation}:${selected.id}`} template={template} definitions={definitions} node={selected} definition={findNodeDefinition(definitions, selected)}
            requirements={nodeRequirementPresentation(selected, findNodeDefinition(definitions, selected), template.spec.requires ?? [])}
            {...(editorTrace?.nodeStates[selected.id] === undefined ? {} : { status: editorTrace.nodeStates[selected.id] })}
            {...(selectedOutput === undefined ? {} : { output: selectedOutput })}
            {...(selectedProgress === undefined ? {} : { progress: selectedProgress })}
            {...(selectedFailure === undefined ? {} : { failure: selectedFailure })}
            onChange={updateSelected} onDelete={() => { mutate(removeNode(template, selected.id)); setSelectedNode(undefined) }} />
        : rightPanel === 'diagnostics' ? <Diagnostics diagnostics={diagnostics} documentState={documentState} onSelect={inspectNode} onEditInput={() => runInputEditor.current?.focus()} /> : <DiffView diff={diff} />}
    </aside>

    <section className="wf-trace">
      <div className="wf-trace-head">
        <SectionLabel index="03" text={t('Run & audit')} />
        <textarea ref={runInputEditor} value={inputsText} onChange={event => updateRunInput(event.target.value)} aria-label={t('Run input JSON')} title={t('Run input JSON')} aria-invalid={inputInvalid} readOnly={busy} />
        {inputFields.length === 0 ? null : <button onClick={() => {
          const current = parseRunInputs(inputsText)
          if (current === undefined) { runInputEditor.current?.focus(); return }
          setFormInputs(current)
        }} disabled={busy}>{t('Input form')}</button>}
        <details className="wf-local-menu wf-input-presets" onKeyDown={event => {
          if (event.key !== 'Escape' || !event.currentTarget.open) return
          event.stopPropagation()
          event.currentTarget.open = false
          event.currentTarget.querySelector('summary')?.focus()
        }}>
          <summary>{t('Input presets')}</summary>
          <div>
            {presets.map(preset => <span className="wf-input-preset" key={preset.name}><button disabled={busy} onClick={() => updateRunInput(JSON.stringify(preset.inputs, null, 2))}>{preset.name}</button><button disabled={busy} onClick={() => deletePreset(preset.name)} aria-label={t('Remove input preset {name}', { name: preset.name })}>×</button></span>)}
            <label>{t('Preset name')}<input value={presetName} onChange={event => setPresetName(event.target.value)} maxLength={100} /></label>
            <button onClick={savePreset} disabled={busy || presetName.trim() === '' || parseRunInputs(inputsText) === undefined}>{t('Save inputs on this device')}</button>
            {presets.length === 0 ? null : <button onClick={clearPresets} disabled={busy}>{t('Clear saved presets')}</button>}
            <label>{t('Import input JSON')}<input type="file" accept=".json,application/json" disabled={busy} onChange={event => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''
              if (file !== undefined) void importInputs(file)
            }} /></label>
          </div>
        </details>
        <span className="wf-run-launch"><button className="wf-run" onClick={() => void runWorkflow()} disabled={busy} aria-describedby="wf-draft-effects">▶ {t('Run draft')}</button>
          <small id="wf-draft-effects" data-host-effects={hasHostEffects(template)}>{t(hasHostEffects(template) ? 'Run may call real Host tools or agents.' : 'Run uses only local workflow nodes.')}</small></span>
        {draft === undefined || catalog.find(item => item.id === draft.id)?.publishedRevision === undefined ? null : <button onClick={() => {
          setError(undefined)
          setRevisionPanel({ id: draft.id, inputs: latestInputs.current })
        }} disabled={busy}>{t('Published revisions')}</button>}
        <button onClick={() => void readTrace()} disabled={runWatch.reading || runId === undefined} title={runId === undefined ? t('No run trace to refresh') : t('Load the latest saved trace')}>{t('Refresh')}</button>
        {runStatus === 'running' && (runStop.phase === undefined || stopping) ? <button onClick={() => void cancelRun()} disabled={busy || stopping}>{t(stopping ? 'Stop requested…' : 'Stop run')}</button> : null}
        {runId !== undefined && (runStatus === 'paused' || (runStatus === 'running' && trace?.active === false)) ? <button onClick={() => openHistory(runId, undefined, true)}>{t(runStatus === 'paused' ? 'Review paused run' : 'Review interrupted run')}</button> : null}
        {trace === undefined ? null : <button className="wf-subtle" onClick={() => setShowInfrastructureEvents(value => !value)}>{showInfrastructureEvents ? t('Hide infrastructure events') : t('Show infrastructure events')}</button>}
        <span className={`wf-run-state wf-${runStatus ?? 'idle'}`} aria-live="polite">{runStop.phase === 'cancelled' && runStatus === 'running' ? runStatusLabel('cancelled', language)
          : trace?.status === 'running' && trace.active === false ? t('Interrupted') : runStatusLabel(runStatus, language)}</span>
      </div>
      <div className="wf-trace-body">
        {runId === undefined ? null : <section className="wf-run-summary" aria-label={t('Run result')}>
          <header>
            <span>{t('Run ID')} <code title={runId}>{runId}</code></span>
            <button onClick={() => void copyRunText(runId, 'Run ID copied')}>{t('Copy run ID')}</button>
          </header>
          {activeRun === undefined ? null : <header className="wf-executing-target">
            <span><b>{activeRun.template.metadata.name}</b><code>{activeRun.revision === undefined ? t('Draft snapshot') : `${activeRun.template.metadata.id}@${activeRun.revision}`}</code></span>
            <button onClick={() => openHistory(runId, undefined, true)}>{t('Show executed graph')}</button>
          </header>}
          {stopping || runStop.phase === 'finished' ? <p className="wf-stop-note" role="status">{t(stopping ? 'Waiting for the Host to finish or stop the current action.' : 'Run finished before it could be stopped.')}</p> : null}
          {runStatus === 'completed' && outputs !== undefined ? <div className="wf-run-output">
            <div><b>{t('Run output')}</b><button onClick={() => void copyRunText(JSON.stringify(outputs, null, 2), 'Run output copied')}>{t('Copy output')}</button></div>
            <WorkflowResultView outputs={outputs} />
          </div> : null}
          {runFailure === undefined && failedNodeId === undefined ? null : <div className="wf-run-failure">
            {runFailure === undefined ? null : <p><b>{runFailure.title}</b> {runFailure.remedy}</p>}
            {failedNodeId === undefined ? null : <button onClick={() => inspectRunNode(failedNodeId)}>{t('Inspect failed node')} <code>{failedNodeId}</code></button>}
          </div>}
        </section>}
        <div className="wf-events">
          {runId === undefined ? <div className="wf-empty-line">{t('Enter inputs and run the draft to see executed and failed nodes.')}</div> : null}
          {traceEvents.map(event => {
            const Event = event.nodeId === undefined || !activeRun?.template.spec.nodes.some(node => node.id === event.nodeId) ? 'article' : 'button'
            return <Event className="wf-event" key={event.seq} data-tone={event.tone} {...(Event === 'button' && event.nodeId !== undefined ? {
              onClick: () => inspectRunNode(event.nodeId!),
              'aria-label': `${event.title} · ${t('Inspect node')} ${event.nodeId}`,
            } : {})}><span>{String(event.seq).padStart(3, '0')}</span><b>{event.title}</b><small>{event.detail}</small></Event>
          })}
          {runWatch.error === undefined ? null : <p className="wf-empty-line">{t('Waiting to reconnect to the run journal')}</p>}
          {trace?.nextAfterSeq === undefined ? null : <button className="wf-event wf-load-more" onClick={() => void readTrace()} disabled={runWatch.reading}><span>…</span><b>{t('Load more')}</b><small>{t('Read more events from the journal')}</small></button>}
        </div>
      </div>
      <div className="wf-statusbar"><span>{documentStateLabel(documentState, language)} · {connectionStateLabel(connectionState, language)}</span><span role="status">{error?.title ?? t(activity.message, activity.action === undefined ? activity.values : { action: t(activity.action) })}</span></div>
    </section>

    {surface === 'home' ? <WorkflowHome api={api} scope={scope} catalog={catalog} favorites={favorites} busy={busy}
      {...(lastOpened === undefined ? {} : { lastOpened })} onOpenDraft={openDraftSafely} onRunPublished={openFixedRevision}
      onOpenRun={id => openHistory(id, undefined, true)} onOrders={() => void useOrdersStarter()} onEcho={useStarter} onNew={startNew} onAgent={() => void copyAgentPrompt()} /> : null}
    {surface === 'operations' ? <WorkflowOperationsPanel snapshot={operations} busy={busy} onRefresh={() => void refreshOperations()} onOpenRun={openHistory}
      onRunSchedule={(id, revision, requestId, requestedAt) => api.request('workflowCanvas.runSchedule', () => api.remote.runSchedule(sessionId, { id, revision, requestId, requestedAt }), { retries: 1 })} /> : null}
    {surface === 'history' ? <WorkflowRunHistory key={historyTarget?.runId ?? 'browse'} api={api} sessionId={sessionId} templateId={template.metadata.id}
      {...(historyTarget === undefined ? {} : { initialRunId: historyTarget.runId,
        ...(historyTarget.graph === undefined ? {} : { initialGraph: historyTarget.graph }),
        ...(historyTarget.nodeId === undefined ? {} : { initialNodeId: historyTarget.nodeId }) })} onStartNewRun={restartWorkflow} hasHostEffects={hasHostEffects} /> : null}
    {revisionPanel !== undefined ? <WorkflowRevisions api={api} sessionId={sessionId} workflowId={revisionPanel.id} template={template} busy={busy}
      initialInputs={revisionPanel.inputs} {...(revisionPanel.revision === undefined ? {} : { fixedRevision: revisionPanel.revision })}
      {...(error === undefined ? {} : { actionError: error.detail })} onClose={() => setRevisionPanel(undefined)} onRun={runWorkflow} hasHostEffects={hasHostEffects} /> : null}

    {formInputs === undefined ? null : <RunInputForm inputs={formInputs} fields={inputFields} onCancel={() => setFormInputs(undefined)} onApply={value => {
      updateRunInput(JSON.stringify(value, null, 2))
      setFormInputs(undefined)
    }} />}

    {confirmPublish ? <StudioDialog title={t('Publish an immutable revision?')} onDismiss={() => setConfirmPublish(false)}><p>{t('Canvas saves your draft before publishing. Later edits stay in the draft until published again.')}</p><footer><button onClick={() => setConfirmPublish(false)}>{t('Cancel')}</button><button className="wf-primary" onClick={() => void publish()}>{t('Confirm publication')}</button></footer></StudioDialog> : null}
    {confirmClose ? <StudioDialog title={t('Unsaved draft changes')} onDismiss={() => setConfirmClose(false)}><p>{t('Keep a draft copy on this device or discard the unsaved changes.')}</p><footer>
      <button onClick={() => setConfirmClose(false)}>{t('Continue editing')}</button>
      <button className="wf-danger" onClick={() => { recoveryWritable.current = false; clearOwnRecovery(); onClose?.() }}>{t('Discard changes')}</button>
      <button className="wf-primary" onClick={() => { if (persistRecovery()) onClose?.(); else setError(classifyWorkflowError(t('Could not keep the draft on this device.'))) }}>{t('Keep for later')}</button>
    </footer>{error?.detail === t('Could not keep the draft on this device.') ? <p role="alert">{error.detail}</p> : null}</StudioDialog> : null}
  </div></DraftFieldsContext.Provider></CanvasLocaleContext.Provider>
}

function StudioDialog({ title, onDismiss, children }: { readonly title: string; readonly onDismiss: () => void; readonly children: React.ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const current = dialog.current
    current?.showModal()
    return () => { current?.close() }
  }, [])
  return <dialog ref={dialog} className="wf-modal wf-input-form wf-studio-dialog" aria-labelledby={titleId} onCancel={event => {
    event.preventDefault()
    onDismiss()
  }}><h2 id={titleId}>{title}</h2>{children}</dialog>
}

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

function WorkflowInspector({ template, saved, onChange }: { readonly template: CanvasWorkflowTemplate; readonly saved: boolean; readonly onChange: (value: CanvasWorkflowTemplate) => void }) {
  const { t } = useCanvasCopy()
  return <div className="wf-panel-body">
    <p className="wf-eyebrow">{t('Workflow settings')}</p>
    <label>{t('Workflow ID')}<input value={template.metadata.id} readOnly={saved} onChange={event => onChange({ ...template, metadata: { ...template.metadata, id: event.target.value } })} /></label>
    <label>{t('Description')}<textarea value={template.metadata.description ?? ''} onChange={event => onChange({
      ...template,
      metadata: { ...template.metadata, description: event.target.value },
    })} /></label>
    <details className="wf-advanced"><summary>{t('Advanced · schemas and dependencies')}</summary>
      <p>{t('These fields edit the WorkflowTemplate directly. Declare external capabilities in the dependency allowlist.')}</p>
      <JsonEditor fieldId="workflow:input-schema" label={t('Input schema')} value={template.spec.inputSchema} onChange={value => onChange({ ...template, spec: { ...template.spec, inputSchema: value } })} />
      <RequirementsEditor value={template.spec.requires ?? []} onChange={value => onChange({ ...template, spec: { ...template.spec, requires: value } })} />
      <JsonEditor fieldId="workflow:outputs" label={t('Workflow output bindings')} value={template.spec.outputs as unknown as CanvasJsonObject} onChange={value => onChange({ ...template, spec: { ...template.spec, outputs: value as unknown as CanvasWorkflowTemplate['spec']['outputs'] } })} />
    </details>
  </div>
}

function NodeInspector({ node, definitions, definition, template, requirements, status, output, progress, failure, onChange, onDelete }: {
  readonly node: CanvasWorkflowNode
  readonly template: CanvasWorkflowTemplate
  readonly definitions: readonly CanvasNodeDefinition[]
  readonly definition: CanvasNodeDefinition | undefined
  readonly requirements: ReturnType<typeof nodeRequirementPresentation>
  readonly status?: string
  readonly output?: CanvasJsonObject
  readonly progress?: CanvasJsonValue
  readonly failure?: string
  readonly onChange: (node: CanvasWorkflowNode) => void
  readonly onDelete: () => void
}) {
  const { language, t } = useCanvasCopy()
  const ancestors = new Set<string>()
  const pending = [node.id]
  for (let index = 0; index < pending.length; index++) {
    for (const edge of template.spec.edges) {
      if (edge.target !== pending[index] || edge.source === node.id || ancestors.has(edge.source)) continue
      ancestors.add(edge.source)
      pending.push(edge.source)
    }
  }
  const sources = [
    { kind: 'input' as const, id: 'input', label: t('Workflow input'), schema: template.spec.inputSchema },
    ...template.spec.nodes.filter(candidate => ancestors.has(candidate.id)).map(candidate => ({
      kind: 'output' as const, id: `output:${candidate.id}`, label: `${t('Node output')} · ${candidate.id}`,
      schema: candidate.expects?.schema ?? findNodeDefinition(definitions, candidate)?.outputSchema,
    })),
  ].map(({ schema, ...source }) => ({ ...source, ...(schema === undefined ? {} : { schema }) }))
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
    <BindingPicker nodeId={node.id} sources={sources} values={node.inputs} {...(definition === undefined ? {} : { schema: definition.inputSchema })}
      onChange={inputs => onChange({ ...node, inputs })} />
    {status === undefined ? null : <section className="wf-node-run"><header><b>{t('Current run')}</b><span data-status={status}>{nodeStatusLabel(status, language)}</span></header>
      {failure === undefined ? null : <details open><summary>{t('Node error')}</summary><pre>{failure}</pre></details>}
      {progress === undefined ? null : <details><summary>{t('View saved progress')}</summary><pre>{JSON.stringify(progress, null, 2)}</pre></details>}
      {output === undefined ? null : <details><summary>{t('View node output')}</summary><pre>{JSON.stringify(output, null, 2)}</pre></details>}
    </section>}
    <details className="wf-advanced"><summary>{t('Advanced · raw JSON and output contract')}</summary>
      <JsonEditor fieldId={`node:${node.id}:bindings`} nodeId={node.id} label={t('Input bindings')} value={node.inputs as unknown as CanvasJsonObject} onChange={value => onChange({
        ...node, inputs: value as unknown as CanvasWorkflowNode['inputs'],
      })} />
      <JsonEditor fieldId={`node:${node.id}:config`} nodeId={node.id} label={t('Raw node configuration')} value={node.with} onChange={value => onChange({ ...node, with: value })} />
      <JsonEditor fieldId={`node:${node.id}:expected`} nodeId={node.id} label={t('Expected output contract')} value={(node.expects ?? {}) as unknown as CanvasJsonObject} onChange={value => {
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
              onChange={event => {
                const entered = event.currentTarget.value
                if (type !== 'number' && type !== 'integer') { onChange({ ...value, [name]: entered }); return }
                if (event.currentTarget.validity.badInput) return
                const next = { ...value }
                if (entered === '') delete next[name]
                else next[name] = Number(entered)
                onChange(next)
              }}
            />}
    </label>
  })}</fieldset>
}

function JsonEditor({ fieldId, nodeId, label, value, onChange }: { readonly fieldId: string; readonly nodeId?: string; readonly label: string; readonly value: CanvasJsonObject; readonly onChange: (value: CanvasJsonObject) => void }) {
  const { t } = useCanvasCopy()
  return <DraftJsonField key={fieldId} fieldId={fieldId} {...(nodeId === undefined ? {} : { nodeId })} label={label} value={value} error={t('Enter a valid JSON object')}
    parse={text => { const parsed = parseRunInputs(text); if (parsed === undefined) throw new Error('object required'); return parsed }} onChange={onChange} />
}

function RequirementsEditor({ value, onChange }: {
  readonly value: NonNullable<CanvasWorkflowTemplate['spec']['requires']>
  readonly onChange: (value: NonNullable<CanvasWorkflowTemplate['spec']['requires']>) => void
}) {
  const { t } = useCanvasCopy()
  return <DraftJsonField fieldId="workflow:dependencies" label={t('Declared dependencies (allowlist)')}
    error={t('Each item requires kind and uses')} value={value as unknown as readonly CanvasJsonObject[]}
    parse={text => {
      const parsed = JSON.parse(text) as unknown
      if (!Array.isArray(parsed) || parsed.some(item => !isObject(item) || typeof item.kind !== 'string' || typeof item.uses !== 'string')) throw new Error('requirement array required')
      return parsed as CanvasJsonObject[]
    }} onChange={parsed => onChange(parsed as unknown as NonNullable<CanvasWorkflowTemplate['spec']['requires']>)} />
}

function Diagnostics({ diagnostics, documentState, onSelect, onEditInput }: {
  readonly diagnostics: readonly CanvasWorkflowDiagnostic[]
  readonly documentState: WorkflowDocumentState
  readonly onSelect: (id: string) => void
  readonly onEditInput: () => void
}) {
  const { language, t } = useCanvasCopy()
  if (diagnostics.length === 0) return <div className="wf-panel-empty"><b>{documentState === 'validated' || documentState === 'validated-dirty' ? t('Validation passed') : t('Not yet validated')}</b><span>{documentState === 'validated' || documentState === 'validated-dirty' ? t('No structure, dependency, or schema issues found.') : t('Select Validate to check this workflow with the runtime’s compile rules.')}</span></div>
  return <div className="wf-diagnostics">{diagnostics.map((item, index) => {
    const nodeId = item.nodeId
    const action = isRunInputIssue(item) ? onEditInput : nodeId === undefined ? undefined : () => onSelect(nodeId)
    const actionLabel = isRunInputIssue(item) ? t('Edit run input') : t('Inspect node')
    const Entry = action === undefined ? 'article' : 'button'
    const title = diagnosticTitle(item, language)
    return <Entry key={`${item.code}-${index}`} data-severity={item.severity} {...(action === undefined ? {} : {
      onClick: action, 'aria-label': `${title} · ${actionLabel}${nodeId === undefined ? '' : ` ${nodeId}`}`,
    })}>
      <span aria-hidden="true">{item.severity === 'error' ? '×' : '!'}</span>
      <div><b>{title}</b>{item.message === '' ? null : <p>{item.message}</p>}<small>{nodeId ?? t('Workflow')} · {item.code}</small></div>
    </Entry>
  })}</div>
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

function isObject(value: unknown): value is CanvasJsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function versionMatches(left: DocumentVersion, right: DocumentVersion): boolean {
  return left.generation === right.generation && left.edits === right.edits
}

function bindWorkflowId(template: CanvasWorkflowTemplate, id: string | undefined): CanvasWorkflowTemplate {
  return id === undefined || id === template.metadata.id ? template : { ...template, metadata: { ...template.metadata, id } }
}

function parseRunInputs(source: string): CanvasJsonObject | undefined {
  try {
    const value: unknown = JSON.parse(source)
    return isObject(value) ? value : undefined
  } catch {
    return undefined
  }
}

function isRunInputIssue(issue: CanvasWorkflowDiagnostic): boolean {
  return issue.code === 'CANVAS_RUN_INPUT_JSON_INVALID' || issue.code === 'WORKFLOW_INPUT_INVALID' || issue.code === 'WORKFLOW_INPUT_TOO_LARGE'
}

function readRecovery(sessionId: string) {
  if (typeof window === 'undefined') return undefined
  try { return parseRecoverySnapshot(window.localStorage.getItem(recoveryStorageKey(sessionId))) } catch { return undefined }
}

function writeRecovery(sessionId: string, snapshot: Parameters<typeof serializeRecoverySnapshot>[0]): boolean {
  if (typeof window === 'undefined') return false
  try { window.localStorage.setItem(recoveryStorageKey(sessionId), serializeRecoverySnapshot(snapshot)); return true } catch { return false }
}

function clearRecovery(sessionId: string, templateId: string): void {
  if (typeof window === 'undefined') return
  try { if (readRecovery(sessionId)?.template.metadata.id === templateId) window.localStorage.removeItem(recoveryStorageKey(sessionId)) } catch { /* best effort */ }
}

const STRUCTURE_CSS = String.raw`
.wf-studio{position:absolute;inset:0;z-index:40;display:grid;overflow:hidden;pointer-events:auto}
.wf-studio *{box-sizing:border-box}.wf-studio button{cursor:pointer}.wf-studio button:disabled{cursor:not-allowed;opacity:.4}
.wf-topbar{grid-column:1/-1;z-index:3;display:flex;align-items:center;border-bottom:1px solid}.wf-brand{height:100%;display:flex;align-items:center;border-right:1px solid}.wf-brand b,.wf-brand small{display:block}.wf-doc-title{min-width:0;flex:1;display:flex;align-items:center}.wf-status-dot{flex:none;border-radius:50%}.wf-doc-title input{width:min(42vw,420px);border:0;background:transparent;outline:0}.wf-actions{display:flex;height:100%}
.wf-palette{grid-row:2;grid-column:1;display:flex;min-height:0;flex-direction:column;border-right:1px solid}.wf-section-label{display:flex;align-items:center}.wf-palette select{width:100%}.wf-node-list{display:flex;overflow:auto;flex-direction:column}.wf-palette-node{display:grid;cursor:pointer}.wf-palette-foot{display:flex;justify-content:space-between;margin-top:auto;border-top:1px solid}
.wf-canvas{position:relative;grid-row:2;grid-column:2;min-width:0}.wf-canvas .react-flow__minimap{width:150px!important;height:92px!important}.wf-canvas-loading{position:absolute;inset:0;display:grid;place-items:center}.wf-coordinate{position:absolute;z-index:2}.wf-edge-skipped .react-flow__edge-path{stroke-dasharray:3 5;opacity:.35}
.wf-graph-node{position:relative}.wf-graph-node:before{content:"";position:absolute}.wf-node-cap{display:flex;justify-content:space-between}.wf-node-cap em{font-style:normal}.wf-handle{position:absolute}
.wf-inspector{grid-row:2;grid-column:3;min-height:0;overflow:hidden;border-left:1px solid}.wf-inspector>nav{display:flex;border-bottom:1px solid}.wf-panel-body,.wf-diagnostics,.wf-diff{overflow:auto}.wf-panel-body label{display:block}.wf-panel-body input,.wf-panel-body textarea,.wf-schema-form select{display:block;width:100%;margin-top:7px}.wf-panel-body textarea{min-height:82px;resize:vertical}.wf-panel-empty{display:flex;height:100%;flex-direction:column;align-items:center;justify-content:center;text-align:center}.wf-schema-form{margin:0 0 16px}.wf-schema-form input[type=checkbox]{display:inline-block;width:auto;margin-left:10px}.wf-danger{width:100%}
.wf-diagnostics>:is(button,article){display:grid;width:100%;grid-template-columns:25px 1fr;text-align:left}.wf-diff-flags{display:flex}.wf-diff section div{display:grid;grid-template-columns:65px 1fr}
.wf-trace{grid-row:3;grid-column:1/-1;display:grid;min-width:0;border-top:1px solid}.wf-trace-head{display:flex;align-items:stretch;border-bottom:1px solid}.wf-trace-head textarea{resize:none}.wf-events{display:flex;overflow:auto}.wf-event{display:grid;flex:0 0 188px;grid-template-columns:28px 1fr;text-align:left}.wf-event span{grid-row:1/3}.wf-statusbar{display:flex;align-items:center;justify-content:space-between;overflow:hidden;white-space:nowrap}
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
.wf-diagnostics>:is(button,article){border:1px solid var(--wf-border);border-radius:9px;background:var(--wf-surface-soft);color:var(--wf-text)}.wf-diagnostics>button:hover{border-color:var(--wf-brand)}.wf-diagnostics>:is(button,article)>span{color:var(--wf-warning)}.wf-diagnostics>:is(button,article)[data-severity=error]>span{color:var(--wf-danger)}.wf-diagnostics p{color:var(--wf-muted)}.wf-diff-flags span{border-color:var(--wf-border);border-radius:999px;color:var(--wf-muted)}.wf-diff-flags span[data-on=true]{border-color:var(--wf-brand);background:var(--wf-brand-soft);color:var(--wf-brand)}.wf-diff section{border-color:var(--wf-border)}
.wf-trace{background:var(--wf-surface);border-color:var(--wf-border);grid-template-rows:48px minmax(0,1fr) 24px}.wf-trace-head{border-color:var(--wf-border);align-items:center}.wf-trace-head .wf-section-label{min-width:272px;padding:0 17px}.wf-trace-head textarea{align-self:stretch;width:320px;border:0;border-left:1px solid var(--wf-border);border-right:1px solid var(--wf-border);background:var(--wf-surface-soft);color:var(--wf-text);font:9px/1.45 var(--ds-font-family-code),monospace;padding:8px 11px}.wf-trace-head .wf-run{margin-left:10px;background:var(--wf-brand);border-color:var(--wf-brand);color:#fff}.wf-trace-head .wf-run:hover{background:var(--wf-brand-strong)}.wf-run-state{margin-left:auto;margin-right:16px;border:1px solid var(--wf-border);border-radius:999px;background:var(--wf-surface-soft);color:var(--wf-muted);font:650 8px/1 var(--ds-font-family-code),monospace;padding:6px 9px}.wf-run-state.wf-completed{color:var(--wf-success);border-color:color-mix(in srgb,var(--wf-success) 32%,var(--wf-border));background:color-mix(in srgb,var(--wf-success) 7%,var(--wf-surface))}.wf-run-state.wf-failed,.wf-run-state.wf-paused{color:var(--wf-danger);border-color:color-mix(in srgb,var(--wf-danger) 30%,var(--wf-border))}
.wf-events{gap:7px;padding:10px 14px}.wf-event{flex-basis:188px;border:1px solid var(--wf-border);border-radius:9px;background:var(--wf-surface-soft);color:var(--wf-text);padding:8px}.wf-events button:hover{border-color:var(--wf-brand);background:var(--wf-surface-hover)}.wf-event span{color:var(--wf-brand);font-weight:700}.wf-event small{color:var(--wf-muted)}.wf-empty-line{color:var(--wf-muted);font-size:10px}.wf-statusbar{height:24px;border-top:1px solid var(--wf-border);background:var(--wf-surface-soft);color:var(--wf-muted);font:650 8px/1 var(--ds-font-family-code),monospace;letter-spacing:.035em;padding:0 11px}
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
.wf-trace-head .wf-subtle{font-size:9px;color:var(--wf-muted)}
.wf-trace-body{min-width:0;min-height:0;display:grid;grid-template-columns:minmax(0,1fr)}
.wf-studio[data-has-run=true]{grid-template-rows:64px minmax(0,1fr) 208px}
.wf-studio[data-has-run=true] .wf-trace-body{grid-template-columns:minmax(230px, .85fr) minmax(0, 1.65fr)}
.wf-run-summary{display:grid;align-content:start;gap:5px;overflow:auto;min-width:0;padding:7px 12px;border-right:1px solid var(--wf-border)}
.wf-run-summary header,.wf-run-output>div{display:flex;align-items:center;justify-content:space-between;gap:6px}
.wf-run-summary header span{display:flex;align-items:center;gap:6px;min-width:0;white-space:nowrap;color:var(--wf-muted);font-size:10px}
.wf-run-summary header code{overflow:hidden;text-overflow:ellipsis;color:var(--wf-text)}
.wf-run-summary button{flex:none;height:24px;padding:0 6px;color:var(--wf-brand);font-size:10px}
.wf-run-output b{font-size:11px}.wf-run-output pre{max-height:64px;margin:0;padding:5px 7px;overflow:auto;background:var(--wf-surface-soft);border:1px solid var(--wf-border);border-radius:6px;font:10px/1.4 var(--ds-font-family-code),monospace}
.wf-run-output pre:focus-visible{outline:2px solid var(--wf-brand);outline-offset:-2px}
.wf-run-failure{font-size:10px;color:var(--wf-muted)}.wf-run-failure p{margin:0}.wf-run-failure p b{color:var(--wf-danger)}
.wf-event[data-tone=danger]{border-color:color-mix(in srgb,var(--wf-danger) 45%,var(--wf-border))}
.wf-event[data-tone=success]{border-color:color-mix(in srgb,var(--wf-success) 34%,var(--wf-border))}
.wf-event[data-tone=warning]{border-color:color-mix(in srgb,var(--wf-warning) 40%,var(--wf-border))}
.wf-trace .wf-event{height:auto;align-content:start;font:600 11px/1.3 var(--dsw-font-family),sans-serif}
.wf-event small{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wf-trace-head textarea[aria-invalid=true]{border-color:var(--wf-danger);outline:1px solid var(--wf-danger);outline-offset:-1px}
.wf-studio[data-surface=operations]>.wf-palette,.wf-studio[data-surface=operations]>.wf-canvas,.wf-studio[data-surface=operations]>.wf-inspector,.wf-studio[data-surface=operations]>.wf-trace{display:none}.wf-operations{grid-row:2/4;grid-column:1/-1;overflow:auto;padding:30px;background:var(--wf-bg);color:var(--wf-text)}.wf-operations>header{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;max-width:1320px;margin:0 auto 25px}.wf-operations>header p{margin:0 0 8px;color:var(--wf-brand);font-size:9px;font-weight:800;letter-spacing:.18em}.wf-operations>header h1{margin:0 0 8px;font-size:24px}.wf-operations>header span{color:var(--wf-muted);font-size:10px}.wf-operations>header button{height:36px;padding:0 14px;border:1px solid var(--wf-border);border-radius:8px;background:var(--wf-surface);color:var(--wf-text);cursor:pointer}.wf-operations-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;max-width:1320px;margin:auto}.wf-operations-grid>section{min-height:360px;padding:15px;border:1px solid var(--wf-border);border-radius:14px;background:var(--wf-surface)}.wf-operations-grid h2{display:flex;justify-content:space-between;margin:0 0 13px;font-size:12px}.wf-operations-grid h2 em{font-style:normal;color:var(--wf-brand)}.wf-operations-grid article{position:relative;display:grid;gap:6px;margin-bottom:8px;padding:12px;border:1px solid var(--wf-border);border-radius:9px;background:var(--wf-surface-soft)}.wf-operations-grid article[data-status=rejected],.wf-operations-grid article[data-status=unknown]{border-color:color-mix(in srgb,var(--wf-danger) 40%,var(--wf-border))}.wf-operations-grid article b{font-size:10px}.wf-operations-grid article code{color:var(--wf-brand);font-size:8px}.wf-operations-grid article span,.wf-operations-grid article small{overflow:hidden;color:var(--wf-muted);font-size:8px;text-overflow:ellipsis;white-space:nowrap}.wf-operations-grid article button{position:absolute;right:9px;top:9px;border:0;background:transparent;color:var(--wf-brand);font-size:8px;cursor:pointer}.wf-operation-empty{display:grid;place-items:center;min-height:260px;color:var(--wf-success);font-size:24px}.wf-operation-empty span{color:var(--wf-muted);font-size:9px}@media(max-width:900px){.wf-operations-grid{grid-template-columns:1fr}.wf-operations{padding:18px}}
.wf-modal-backdrop{position:absolute;inset:0;z-index:50;display:grid;place-items:center;background:rgba(16,24,40,.34);backdrop-filter:blur(4px)}.wf-modal{width:min(440px,calc(100% - 36px));padding:28px;border:1px solid var(--wf-border);border-radius:17px;background:var(--wf-surface);box-shadow:0 26px 80px rgba(16,24,40,.3);color:var(--wf-text)}.wf-modal-icon{display:grid;place-items:center;width:42px;height:42px;border-radius:12px;background:var(--wf-brand-soft);color:var(--wf-brand);font-size:22px}.wf-modal h2{margin:17px 0 8px;font-size:19px}.wf-modal p{margin:0;color:var(--wf-muted);font-size:11px;line-height:1.7}.wf-modal>div{display:flex;justify-content:flex-end;gap:8px;margin-top:24px}.wf-modal button{height:36px;padding:0 15px;border:1px solid var(--wf-border);border-radius:8px;background:var(--wf-surface-soft);color:var(--wf-text);cursor:pointer}.wf-modal .wf-primary{border-color:var(--wf-brand);background:var(--wf-brand);color:#fff}
.wf-input-form::backdrop{background:#10182857;backdrop-filter:blur(3px)}.wf-input-form{max-height:min(85vh,620px);overflow:auto}.wf-input-form h2{margin-top:0;margin-bottom:18px}.wf-input-form form{display:grid;gap:13px}.wf-input-form label{display:grid;gap:6px;color:var(--wf-text);font-size:12px}.wf-input-form :is(input,select){width:100%;height:34px;padding:0 9px;border:1px solid var(--wf-border);border-radius:7px;background:var(--wf-surface-soft);color:var(--wf-text);font:inherit;font-size:12px}.wf-input-form footer{display:flex;justify-content:flex-end;gap:8px;margin-top:5px}
@media(max-width:900px){.wf-welcome-actions{grid-template-columns:1fr}.wf-welcome{width:calc(100% - 36px);padding:22px}.wf-welcome-actions button{min-height:68px}.wf-document-state{display:none}.wf-actions button:nth-child(-n+2){display:inline-flex}.wf-system-banner,.wf-error-banner{width:calc(100% - 24px)}}
`

const PERSONAL_CSS = String.raw`
.wf-local-menu{position:relative;flex:none;color:var(--wf-text);font-size:11px}.wf-local-menu summary{cursor:pointer;padding:8px;border-radius:7px;white-space:nowrap}.wf-local-menu summary:hover,.wf-local-menu[open] summary{background:var(--wf-surface-soft)}
.wf-local-menu>div{position:absolute;left:auto;right:0;z-index:12;display:grid;gap:5px;width:230px;padding:9px;border:1px solid var(--wf-border);border-radius:9px;background:var(--wf-surface);box-shadow:0 8px 18px #10182823}.wf-input-presets>div{bottom:calc(100% + 6px);left:0;right:auto}
.wf-local-menu button{text-align:left;width:100%;height:auto;min-height:28px;white-space:normal}.wf-local-menu label{display:grid;gap:3px;padding:4px}.wf-local-menu input{font:inherit;color:var(--wf-text);max-width:100%}.wf-input-preset{display:grid;grid-template-columns:minmax(0,1fr) 24px;gap:4px}.wf-trace-head>button{flex:none}.wf-trace-head textarea{min-width:130px}.wf-trace-head .wf-section-label{min-width:min(18vw,272px)}
.wf-revisions details,.wf-revisions label{margin-block:10px}.wf-revisions summary{cursor:pointer;color:var(--wf-brand);font-size:11px}.wf-revisions pre{max-height:160px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-size:10px}.wf-revision-changes{display:grid!important;gap:7px!important}
.wf-revisions h3{margin:11px 0;font-size:14px}.wf-revisions h3 code{color:var(--wf-muted);font-size:10px}.wf-revisions label textarea{width:100%;min-height:64px;resize:vertical;padding:7px;border:1px solid var(--wf-border);border-radius:7px;background:var(--wf-surface-soft);color:var(--wf-text);font:11px/1.5 var(--ds-font-family-code),monospace}.wf-revision-issues{color:var(--wf-danger);font-size:11px;padding-left:19px}
.wf-run-summary .wf-executing-target b{overflow:hidden;text-overflow:ellipsis;color:var(--wf-text);font-size:10px}.wf-executing-target code{flex:none;color:var(--wf-muted)!important;font-size:9px}
.wf-run-launch{display:grid;justify-items:start;gap:2px;flex:none}.wf-run-launch small{max-width:12em;font-size:9px;line-height:1.15;color:var(--wf-muted)}.wf-run-launch small[data-host-effects=true],.wf-run-effects[data-host-effects=true],.wf-stop-note{color:var(--wf-warning)}.wf-run-effects{font-size:12px;font-weight:600}.wf-stop-note{margin:4px 0 8px;font-size:11px}
.wf-input-field{display:grid;gap:4px}.wf-input-field small{color:var(--wf-muted);font-size:10px}.wf-input-value{display:grid;grid-template-columns:minmax(0,1fr) minmax(120px,.55fr);gap:6px}.wf-studio :is(button,input,select,textarea,summary):focus-visible{outline:2px solid var(--wf-brand);outline-offset:2px}
.wf-case-editor .wf-export-options{margin-bottom:8px;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:6px}.wf-export-options .wf-export-check{grid-column:1/-1;display:flex;align-items:center;gap:6px}.wf-export-options .wf-export-check input{width:16px;height:16px;accent-color:var(--wf-brand)}.wf-case-cli{margin:8px 0;font-size:11px}.wf-case-cli>div{margin-top:6px;display:flex;flex-wrap:wrap;gap:6px}.wf-case-cli code{display:block;padding:5px;background:var(--wf-surface-soft);overflow-wrap:anywhere}
.wf-run-compare{width:min(720px,calc(100vw - 24px))}.wf-run-compare-table{overflow:auto}.wf-run-compare table{width:100%;border-collapse:collapse;font-size:11px;text-align:left}.wf-run-compare th,.wf-run-compare td{padding:6px;border-bottom:1px solid var(--wf-border);overflow-wrap:anywhere}.wf-run-compare th code{display:block;color:var(--wf-muted)}.wf-run-compare tr[data-changed=true]{background:var(--wf-surface-soft)}.wf-compared-value{margin-top:8px;font-size:11px}.wf-compared-value summary{cursor:pointer}.wf-compared-value summary small{color:var(--wf-muted)}.wf-compared-value>div{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}.wf-compared-value pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--wf-surface-soft);padding:6px;margin:3px 0;max-height:155px;overflow:auto}
.wf-binding-picker section{padding:8px;border:1px solid var(--wf-border);border-radius:7px}.wf-binding-picker button{height:auto;padding:7px;border:1px solid var(--wf-border);border-radius:6px;background:var(--wf-surface);color:var(--wf-brand)}.wf-binding-picker small,.wf-input-form [role=alert]{color:var(--wf-danger)}
.wf-result-tabs{display:flex;gap:4px;margin:3px 0}.wf-result-tabs button[aria-pressed=true]{background:var(--wf-brand-soft);color:var(--wf-brand)}.wf-result-table{max-height:140px;overflow:auto}.wf-result-table table{width:100%;border-collapse:collapse;font-size:10px}.wf-result-table :is(th,td){padding:4px 6px;border-bottom:1px solid var(--wf-border);text-align:left;vertical-align:top;overflow-wrap:anywhere}.wf-result-text pre{white-space:pre-wrap}
.wf-result-markdown{max-height:240px;overflow:auto;overflow-wrap:anywhere;font:11px/1.55 var(--dsw-font-family),sans-serif;padding:8px;background:var(--wf-surface-soft);border-radius:7px}.wf-result-markdown :is(h3,h4,p,ol,ul){margin-block:4px 8px}
.wf-history-more-filters{display:grid;grid-template-columns:1fr 1fr;gap:6px;flex:1 0 100%}.wf-history-more-filters input{width:100%;min-width:0;font:inherit;background:var(--wf-surface);border:1px solid var(--wf-border);border-radius:6px;color:var(--wf-text)}
.wf-case-editor{width:min(680px,calc(100% - 36px))}.wf-case-editor textarea{height:min(48vh,360px);width:100%;resize:vertical;background:var(--wf-surface-soft);color:var(--wf-text);border:1px solid var(--wf-border);padding:7px;font:11px/1.5 var(--ds-font-family-code),monospace}.wf-case-editor label{margin-block:9px}
.wf-history-detail-actions{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:9px}.wf-history-decisions{display:grid;gap:6px;margin-bottom:8px;border:1px solid var(--wf-border);font-size:11px}.wf-history-decisions p{margin:0}.wf-history-decisions label{display:flex;justify-content:space-between;gap:7px}
.wf-frozen-run{padding:8px;margin-bottom:9px;border:1px solid var(--wf-border);border-radius:8px}.wf-frozen-run h3,.wf-frozen-run h4{margin:0 0 7px}.wf-frozen-graph{height:236px;overflow:hidden;border:1px solid var(--wf-border);border-radius:7px;background:var(--wf-bg)}.wf-frozen-node{background:var(--wf-surface)!important;color:var(--wf-text)!important;border-color:var(--wf-border)}.wf-frozen-node.selected{border-color:var(--wf-brand)}.wf-frozen-node small{display:block;margin-top:3px;color:var(--wf-muted)}.wf-frozen-node-details{margin-top:8px}
@media(max-width:1024px){.wf-guardrails{display:none}.wf-input-presets>div{position:fixed;left:calc(50% - 110px);bottom:190px}.wf-trace-head .wf-section-label{min-width:115px}}
`
