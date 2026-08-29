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
  readonly sessionId: string
  readonly initialTemplate?: CanvasWorkflowTemplate
  readonly initialTarget?: WorkflowCanvasUiTarget
  readonly onClose?: () => void
}

type RightPanel = 'inspector' | 'diagnostics' | 'diff'
type PaletteGroup = 'nodes' | 'tools'

export function WorkflowStudio({ api, sessionId, initialTemplate, initialTarget, onClose }: WorkflowStudioProps) {
  const initialRecovery = useMemo(() => initialTemplate === undefined && initialTarget?.templateId === undefined
    ? readRecovery(sessionId)
    : undefined, [initialTarget?.templateId, initialTemplate, sessionId])
  const [definitions, setDefinitions] = useState<readonly CanvasNodeDefinition[]>([])
  const [catalog, setCatalog] = useState<readonly CanvasCatalogSummary[]>([])
  const [draft, setDraft] = useState<CanvasWorkflowDraft | undefined>(initialRecovery?.draft)
  const [template, setTemplate] = useState<CanvasWorkflowTemplate>(() => initialTemplate ?? initialRecovery?.template ?? blankTemplate())
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
  const [activity, setActivity] = useState(initialRecovery === undefined ? '准备就绪' : '已恢复未保存的画布')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<WorkflowErrorPresentation>()
  const [showInfrastructureEvents, setShowInfrastructureEvents] = useState(false)
  const [confirmPublish, setConfirmPublish] = useState(false)
  const [surface, setSurface] = useState<'design' | 'operations'>('design')
  const [operations, setOperations] = useState<CanvasOperationsSnapshot>({ bindings: [], ingress: [], deliveryAttention: [] })
  const [recoveryNotice, setRecoveryNotice] = useState(initialRecovery !== undefined)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>()

  const execute = useCallback(async <T,>(label: string, operation: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true)
    setError(undefined)
    setActivity(`${label}…`)
    try {
      const value = await operation()
      setActivity(`${label}完成`)
      return value
    } catch (cause: unknown) {
      const presentation = cause instanceof WorkflowCanvasRequestError ? cause.presentation : classifyWorkflowError(cause)
      setError(presentation)
      setActivity(`${label}未完成`)
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

  const syncCatalog = useCallback(() => execute('同步工作流目录', refreshCatalog), [execute, refreshCatalog])

  const refreshOperations = useCallback(() => execute('刷新触发与投递', async () => {
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
      .filter(definition => query.length === 0 || [definitionDisplayTitle(definition), definitionDisplayDescription(definition), definition.title, definition.description, definition.uses, definition.toolName]
      .some(value => value?.toLocaleLowerCase().includes(query)))
  }, [definitions, paletteGroup, paletteQuery])

  const save = useCallback(async (): Promise<CanvasWorkflowDraft | undefined> => execute('保存草稿', async () => {
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

  const validate = useCallback(async () => execute('校验工作流', async () => {
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
    await execute('比较变更', async () => {
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
    await execute('发布工作流', async () => {
      const published = await api.request('workflowCanvas.publish', () => api.remote.publish(sessionId, {
        id: saved.id,
        expectedRevision: saved.revision,
      }))
      await refreshCatalog()
      setDocumentState('published')
      setActivity(`已发布为不可变修订 ${published.revision}`)
      return published
    })
  }, [api, execute, refreshCatalog, save, sessionId])

  const loadDraft = useCallback(async (id: string) => execute('打开草稿', async () => {
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
    void execute('打开运行轨迹', async () => {
      const value = await api.request('workflowCanvas.trace', () => api.remote.trace(sessionId, { runId: initialTarget.runId! }), { retries: 1 })
      setTrace(value)
      return value
    })
  }, [api, execute, initialTarget?.runId, sessionId])

  const runDraft = useCallback(async () => execute('试运行', async () => {
    const parsed = JSON.parse(inputsText) as unknown
    if (!isObject(parsed)) throw new Error('运行输入必须是 JSON object')
    const result = await api.request('workflowCanvas.runDraft', () => api.remote.runDraft(sessionId, { template, inputs: parsed }))
    setRunResult(result)
    const nextTrace = await api.request('workflowCanvas.trace', () => api.remote.trace(sessionId, { runId: result.runId }), { retries: 1 })
    setTrace(nextTrace)
    return result
  }), [api, execute, inputsText, sessionId, template])

  const refreshTrace = useCallback(async () => {
    const runId = runResult?.runId ?? trace?.runId
    if (runId === undefined) return
    await execute('刷新运行轨迹', async () => {
      const value = await api.request('workflowCanvas.trace', () => api.remote.trace(sessionId, { runId }), { retries: 1 })
      setTrace(value)
      return value
    })
  }, [api, execute, runResult?.runId, sessionId, trace?.runId])

  const resumeRun = useCallback(async (resolution?: 'retry' | 'fail') => {
    if (runResult === undefined) return
    await execute('继续运行', async () => {
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

  const mutate = useCallback((next: CanvasWorkflowTemplate) => {
    setTemplate(next)
    setDocumentState(draft === undefined ? 'unsaved' : 'dirty')
    setActivity(draft === undefined ? '尚未保存' : `草稿修订 ${draft.revision} 有未保存更改`)
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
    || window.confirm('当前工作流有未保存的更改。确定放弃这些更改吗？'), [documentState])
  const startNew = useCallback(() => {
    if (!confirmDiscard()) return
    setDraft(undefined)
    setTemplate(blankTemplate())
    setSelectedNode(undefined)
    setTrace(undefined)
    setRunResult(undefined)
    setDiagnostics([])
    setDocumentState('pristine')
    setRecoveryNotice(false)
    setActivity('已新建空白工作流')
    clearRecovery(sessionId)
  }, [confirmDiscard, sessionId])
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
    setTemplate(starterTemplate())
    setInputsText('{\n  "message": "你好，DSH Workflow"\n}')
    setDocumentState('unsaved')
    setRecoveryNotice(false)
    setActivity('示例已就绪，可以直接试运行')
  }, [confirmDiscard])
  const copyTemplate = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(template, null, 2))
      setActivity('当前 WorkflowTemplate JSON 已复制')
    } catch (cause: unknown) { setError(classifyWorkflowError(cause)) }
  }, [template])
  const copyAgentPrompt = useCallback(async () => {
    try {
      await navigator.clipboard.writeText('请使用 workflow-builder Skill 创建一个可复用的 DAG workflow。先创建并校验草稿，不要发布；完成后告诉我草稿名称、修订和校验结果，我会在工作流画布中确认。')
      setActivity('已复制给 Agent 的创建指令')
    } catch (cause: unknown) { setError(classifyWorkflowError(cause)) }
  }, [])

  const nodes = flow.nodes
  const edges = flow.edges
  const traceEvents = useMemo(() => trace === undefined ? [] : visibleTraceEvents(trace, showInfrastructureEvents), [showInfrastructureEvents, trace])
  const runFailure = workflowFailurePresentation(trace)
  const selectedOutput = selectedNode === undefined ? undefined : trace?.nodeOutputs[selectedNode]
  const selectedProgress = selectedNode === undefined ? undefined : trace?.nodeProgress[selectedNode]

  return <div className="wf-studio" data-workflow-studio data-surface={surface}>
    <style>{CANVAS_CSS + PRODUCT_CSS + EXPERIENCE_CSS}</style>
    <header className="wf-topbar">
      <div className="wf-brand">
        <span className="wf-brand-mark">D</span>
        <span><b>AGENT DAG WORKFLOW</b><small>可审计工作流</small></span>
      </div>
      <div className="wf-doc-title">
        <span className="wf-status-dot" data-busy={busy} data-connection={connectionState} />
        <input value={template.metadata.name} aria-label="工作流名称" onChange={event => mutate({
          ...template, metadata: { ...template.metadata, name: event.target.value },
        })} />
        <span className="wf-document-state" data-state={documentState}>{documentStateLabel(documentState)}</span>
        <code>{template.metadata.id}</code>
      </div>
      <div className="wf-guardrails" aria-label="工作流安全边界">
        <span><i />{template.spec.requires?.length ?? 0} 项依赖</span><span><i />全程审计</span><span><i />Schema 校验</span>
      </div>
      <div className="wf-actions">
        <button onClick={() => { const next = surface === 'design' ? 'operations' : 'design'; setSurface(next); if (next === 'operations') void refreshOperations() }} disabled={busy}>{surface === 'design' ? '触发与投递' : '返回设计'}</button>
        <button onClick={startNew} disabled={busy} title={busy ? '请等待当前操作完成' : '新建工作流'}>新建</button>
        <button onClick={() => void save()} disabled={busy || !hasUnsavedChanges(documentState)} title={busy ? '请等待当前操作完成' : !hasUnsavedChanges(documentState) ? '当前草稿没有待保存内容' : '保存当前草稿'}>保存</button>
        <button onClick={() => void validate()} disabled={busy} title={busy ? '请等待当前操作完成' : '使用同一套运行时规则校验'}>校验</button>
        <button onClick={() => void showDiff()} disabled={busy || draft === undefined} title={draft === undefined ? '先保存一次草稿才能比较变更' : '比较当前画布与已保存草稿'}>变更</button>
        <button className="wf-primary" onClick={() => setConfirmPublish(true)} disabled={busy} title={busy ? '请等待当前操作完成' : '发布不可变修订'}>发布</button>
        {onClose === undefined ? null : <button className="wf-close" onClick={closeSafely} aria-label="关闭工作流画布">×</button>}
      </div>
    </header>

    {connectionState !== 'connected' ? <div className="wf-system-banner" data-kind={connectionState === 'disconnected' ? 'danger' : 'info'}>
      <b>{connectionStateLabel(connectionState)}</b><span>{connectionState === 'disconnected' ? '当前内容已保留，恢复后将自动同步。' : '正在同步节点、Tool 和草稿目录。'}</span>
      <button onClick={() => void syncCatalog()} disabled={busy}>立即重试</button>
    </div> : null}
    {recoveryNotice ? <div className="wf-system-banner wf-recovery" data-kind="warning"><b>已恢复未保存内容</b><span>上次连接中断前的画布和运行输入已经找回。</span><button onClick={() => setRecoveryNotice(false)}>知道了</button></div> : null}
    {error === undefined || error.kind === 'connection' ? null : <div className="wf-error-banner" data-kind={error.kind}>
      <div><b>{error.title}</b><span>{error.message} {error.remedy}</span><details><summary>技术详情</summary><code>{error.detail}</code></details></div>
      <div>{error.retryable ? <button onClick={() => void syncCatalog()}>重试</button> : null}
        {error.kind === 'conflict' ? <><button onClick={() => void copyTemplate()}>复制当前 JSON</button>{draft === undefined ? null : <button onClick={() => void loadDraft(draft.id)}>重新加载</button>}</> : null}
        <button onClick={() => setError(undefined)}>关闭</button></div>
    </div>}

    <aside className="wf-palette">
      <div className="wf-section-row"><SectionLabel index="01" text="工作流" /><button onClick={() => void syncCatalog()} disabled={busy} title="刷新 Agent 创建的草稿">↻</button></div>
      <select aria-label="选择工作流草稿" value={draft?.id ?? ''} onChange={event => openDraftSafely(event.target.value)}>
        <option value="">选择一个草稿…</option>
        {catalog.map(item => <option key={item.id} value={item.id}>{item.name} · 草稿修订 {item.draftRevision}{item.publishedRevision === undefined ? '' : ` · 已发布 ${item.publishedRevision}`}</option>)}
      </select>
      <SectionLabel index="02" text="添加节点" />
      <div className="wf-palette-tabs" role="tablist" aria-label="节点分类">
        <button role="tab" data-active={paletteGroup === 'nodes'} onClick={() => setPaletteGroup('nodes')}>流程节点 <span>{definitions.filter(item => item.kind === 'node').length}</span></button>
        <button role="tab" data-active={paletteGroup === 'tools'} onClick={() => setPaletteGroup('tools')}>Agent Tool <span>{definitions.filter(item => item.kind === 'tool').length}</span></button>
      </div>
      <div className="wf-palette-search"><span>⌕</span><input value={paletteQuery} onChange={event => setPaletteQuery(event.target.value)} placeholder={paletteGroup === 'nodes' ? '搜索流程节点…' : '搜索当前 Agent 可用的 Tool…'} aria-label="搜索工作流节点" /></div>
      <div className="wf-node-list">
        {filteredDefinitions.length === 0 ? <p className="wf-list-empty">当前分类没有匹配项</p> : filteredDefinitions.map((definition, index) => <button
          key={definition.catalogId} className="wf-palette-node"
          onClick={() => mutate(addNode(template, definition, { x: 140 + index % 2 * 280, y: 100 + index * 42 }))}
        ><span>{nodeGlyph(definition)}</span><b>{definitionDisplayTitle(definition)}</b><small>{definitionDisplayDescription(definition)}</small><em>{definition.kind === 'tool' ? '通过 Host 权限边界执行' : definition.uses}</em></button>)}
      </div>
      <div className="wf-palette-foot"><span>显示 {filteredDefinitions.length} 项</span><span>模板 v1alpha1</span></div>
    </aside>

    <main className="wf-canvas">
      <div className="wf-coordinate"><b>工作流画布</b><span>{template.spec.nodes.length} 个节点 · {template.spec.edges.length} 条连接</span></div>
      {definitions.length === 0 ? <div className="wf-canvas-loading">正在同步节点和 Tool…</div> : <ReactFlow
        nodes={nodes} edges={edges} nodeTypes={{ workflow: WorkflowNodeView }} fitView minZoom={0.25} maxZoom={1.8}
        onNodeClick={(_event, node) => { setSelectedNode(node.id); setRightPanel('inspector') }}
        onNodeDragStop={(_event, node) => mutate(moveNode(template, node.id, node.position))}
        onConnect={onConnect} onEdgesDelete={onEdgesDelete} deleteKeyCode={['Backspace', 'Delete']}
      ><Background color="rgba(142, 153, 174, .24)" gap={24} size={1} variant={BackgroundVariant.Dots} /><Controls showInteractive={false} /><MiniMap pannable zoomable nodeColor={node => statusColor(String(node.data.status ?? 'pending'))} /></ReactFlow>}
      {definitions.length > 0 && template.spec.nodes.length === 0 ? <WelcomePanel catalog={catalog} onOpen={openDraftSafely} onStarter={useStarter} onAgentPrompt={() => void copyAgentPrompt()} /> : null}
    </main>

    <aside className="wf-inspector">
      <nav>{(['inspector', 'diagnostics', 'diff'] as const).map(panel => <button key={panel} data-active={rightPanel === panel} onClick={() => setRightPanel(panel)}>{panel === 'inspector' ? '配置' : panel === 'diagnostics' ? `问题${diagnostics.length > 0 ? ` ${diagnostics.length}` : ''}` : '变更'}</button>)}</nav>
      {rightPanel === 'inspector' ? selected === undefined
        ? <WorkflowInspector template={template} onChange={mutate} />
        : <NodeInspector node={selected} definition={findNodeDefinition(definitions, selected)}
            {...(trace?.nodeStates[selected.id] === undefined ? {} : { status: trace.nodeStates[selected.id] })}
            {...(selectedOutput === undefined ? {} : { output: selectedOutput })}
            {...(selectedProgress === undefined ? {} : { progress: selectedProgress })}
            onChange={updateSelected} onDelete={() => { mutate(removeNode(template, selected.id)); setSelectedNode(undefined) }} />
        : rightPanel === 'diagnostics' ? <Diagnostics diagnostics={diagnostics} documentState={documentState} onSelect={id => { setSelectedNode(id); setRightPanel('inspector') }} /> : <DiffView diff={diff} />}
    </aside>

    <section className="wf-trace">
      <div className="wf-trace-head">
        <SectionLabel index="03" text="运行与审计" />
        <textarea value={inputsText} onChange={event => setInputsText(event.target.value)} aria-label="运行输入 JSON" title="运行输入 JSON" />
        <button className="wf-run" onClick={() => void runDraft()} disabled={busy}>▶ 试运行</button>
        <button onClick={() => void refreshTrace()} disabled={busy || trace === undefined} title={trace === undefined ? '还没有可刷新的运行轨迹' : '读取已持久化的最新轨迹'}>刷新</button>
        {runResult?.status === 'paused' && (runResult.needsAttention?.length ?? 0) === 0 ? <button onClick={() => void resumeRun()} disabled={busy}>▶ 继续运行</button> : null}
        {(runResult?.needsAttention?.length ?? 0) > 0 ? <><button onClick={() => void resumeRun('retry')} disabled={busy}>↻ 重试未确认节点</button><button onClick={() => void resumeRun('fail')} disabled={busy}>× 标记失败</button></> : null}
        {trace === undefined ? null : <><button className="wf-subtle" onClick={() => setShowInfrastructureEvents(value => !value)}>{showInfrastructureEvents ? '隐藏底层事件' : '显示底层事件'}</button><button className="wf-copy-run" onClick={() => void navigator.clipboard.writeText(trace.runId)} title={trace.runId}>复制运行 ID</button></>}
        <span className={`wf-run-state wf-${trace?.status ?? 'idle'}`}>{runStatusLabel(trace?.status)}</span>
      </div>
      <div className="wf-events">
        {runFailure === undefined ? null : <article className="wf-run-failure"><span>!</span><div><b>{runFailure.title}</b><small>{runFailure.remedy}</small></div></article>}
        {trace === undefined ? <div className="wf-empty-line">填写左侧 JSON 输入并试运行，执行路径和失败节点会显示在这里。</div> : traceEvents.map(event => <button key={`${event.seq}-${event.title}`} data-tone={event.tone} onClick={() => { if (event.nodeId !== undefined) { setSelectedNode(event.nodeId); setRightPanel('inspector') } }}><span>{String(event.seq).padStart(3, '0')}</span><b>{event.title}</b><small>{event.detail}</small></button>)}
      </div>
      <div className="wf-statusbar"><span>{documentStateLabel(documentState)} · {connectionStateLabel(connectionState)}</span><span>{error?.title ?? activity}</span></div>
    </section>

    {surface === 'operations' ? <WorkflowOperationsPanel snapshot={operations} busy={busy} onRefresh={() => void refreshOperations()} onOpenRun={runId => {
      setSurface('design')
      void execute('打开运行轨迹', async () => {
        const value = await api.request('workflowCanvas.trace', () => api.remote.trace(sessionId, { runId }), { retries: 1 })
        setTrace(value)
        return value
      })
    }} /> : null}

    {confirmPublish ? <div className="wf-modal-backdrop" role="presentation"><section className="wf-modal" role="dialog" aria-modal="true" aria-labelledby="wf-publish-title"><span className="wf-modal-icon">↗</span><h2 id="wf-publish-title">发布不可变修订？</h2><p>发布前会自动保存并再次使用当前草稿修订。发布后的运行必须明确引用该修订，后续编辑会产生新的草稿修订。</p><div><button onClick={() => setConfirmPublish(false)}>取消</button><button className="wf-primary" onClick={() => void publish()}>确认发布</button></div></section></div> : null}
  </div>
}

function WorkflowOperationsPanel({ snapshot, busy, onRefresh, onOpenRun }: {
  readonly snapshot: CanvasOperationsSnapshot
  readonly busy: boolean
  readonly onRefresh: () => void
  readonly onOpenRun: (runId: string) => void
}) {
  return <section className="wf-operations" aria-label="触发与投递审计">
    <header><div><p>OPERATIONS / TRIGGER</p><h1>触发、运行与投递</h1><span>这里展示 Host 提供的绑定、去重入口记录和需要人工关注的投递。所有入口都引用不可变工作流修订。</span></div><button onClick={onRefresh} disabled={busy}>↻ 刷新</button></header>
    <div className="wf-operations-grid">
      <section><h2>绑定 <em>{snapshot.bindings.length}</em></h2>{snapshot.bindings.length === 0 ? <EmptyOperation text="当前 Host 没有暴露触发绑定" /> : snapshot.bindings.map(binding => <article key={`${binding.metadata.id}@${binding.metadata.revision}`}><b>{binding.metadata.id}</b><code>{binding.spec.trigger.uses}</code><span>{binding.spec.workflow.id}@{binding.spec.workflow.revision}</span><small>{binding.spec.authorityRef} · {binding.spec.enabled === false ? '已停用' : '启用中'}</small></article>)}</section>
      <section><h2>入口审计 <em>{snapshot.ingress.length}</em></h2>{snapshot.ingress.length === 0 ? <EmptyOperation text="还没有收到外部触发" /> : snapshot.ingress.map(record => <article key={record.triggerId} data-status={record.status}><b>{record.source} / {record.sourceEventId}</b><code>{record.status}</code><span>{record.binding.id}@{record.binding.revision}</span><small>{record.runId ?? record.reasonCode ?? '尚未关联运行'} · 重复 {record.duplicateCount ?? 0} 次</small>{record.runId === undefined ? null : <button onClick={() => onOpenRun(record.runId!)}>查看 Trace</button>}</article>)}</section>
      <section><h2>投递待处理 <em>{snapshot.deliveryAttention.length}</em></h2>{snapshot.deliveryAttention.length === 0 ? <EmptyOperation text="没有状态不确定的投递" /> : snapshot.deliveryAttention.map(record => <article key={record.invocationId} data-status="unknown"><b>{record.deliveryRef}</b><code>{record.phase} / {record.status}</code><span>{record.runId}</span><small>尝试 {record.attempts} 次 · {record.error ?? '等待确认'}</small><button onClick={() => onOpenRun(record.runId)}>查看 Trace</button></article>)}</section>
    </div>
  </section>
}

function EmptyOperation({ text }: { readonly text: string }) { return <div className="wf-operation-empty">✓<span>{text}</span></div> }

function WorkflowNodeView({ data, selected }: NodeProps<WorkflowFlowNode>) {
  const renderer = workflowNodeRenderers.resolve(data.template.uses)
  const Custom = renderer
  const ports = data.definition?.outputPorts ?? ['default']
  return <article className="wf-graph-node" data-selected={selected} data-status={data.status ?? 'pending'}>
    <div className="wf-node-cap"><span>{nodeGlyph(data.definition)}</span><em>{data.definition?.kind === 'tool' ? 'DSH TOOL' : nodeStatusLabel(data.status)}</em></div>
    {Custom === undefined
      ? <><h3>{data.template.title ?? (data.definition === undefined ? data.template.id : definitionDisplayTitle(data.definition))}</h3><code>{data.template.uses}</code></>
      : <Custom data={data} selected={selected} />}
    <div className="wf-node-foot"><span>{nodeStatusLabel(data.status)}</span><span>{data.definition?.capabilities.length ?? 0} 项能力声明</span></div>
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
  return <div className="wf-panel-body">
    <p className="wf-eyebrow">工作流配置</p>
    <label>工作流 ID<input value={template.metadata.id} onChange={event => onChange({ ...template, metadata: { ...template.metadata, id: event.target.value } })} /></label>
    <label>说明<textarea value={template.metadata.description ?? ''} onChange={event => onChange({
      ...template,
      metadata: { ...template.metadata, description: event.target.value },
    })} /></label>
    <details className="wf-advanced"><summary>高级配置 · Schema 与依赖</summary>
      <p>这里直接编辑唯一真源 WorkflowTemplate。外部能力必须在依赖清单中声明。</p>
      <JsonEditor label="输入 Schema" value={template.spec.inputSchema} onChange={value => onChange({ ...template, spec: { ...template.spec, inputSchema: value } })} />
      <RequirementsEditor value={template.spec.requires ?? []} onChange={value => onChange({ ...template, spec: { ...template.spec, requires: value } })} />
      <JsonEditor label="工作流输出绑定" value={template.spec.outputs as unknown as CanvasJsonObject} onChange={value => onChange({ ...template, spec: { ...template.spec, outputs: value as unknown as CanvasWorkflowTemplate['spec']['outputs'] } })} />
    </details>
  </div>
}

function NodeInspector({ node, definition, status, output, progress, onChange, onDelete }: {
  readonly node: CanvasWorkflowNode
  readonly definition: CanvasNodeDefinition | undefined
  readonly status?: string
  readonly output?: CanvasJsonObject
  readonly progress?: CanvasJsonValue
  readonly onChange: (node: CanvasWorkflowNode) => void
  readonly onDelete: () => void
}) {
  return <div className="wf-panel-body">
    <p className="wf-eyebrow">节点配置</p>
    <h2>{node.id}</h2>
    <code className="wf-uses">{node.uses}</code>
    <label>节点名称<input value={node.title ?? ''} onChange={event => onChange({ ...node, title: event.target.value })} /></label>
    <SchemaObjectEditor schema={definition?.configSchema} value={node.with} onChange={value => onChange({ ...node, with: value })} />
    <JsonEditor label="输入绑定" value={node.inputs as unknown as CanvasJsonObject} onChange={value => onChange({
      ...node,
      inputs: value as unknown as CanvasWorkflowNode['inputs'],
    })} />
    {status === undefined ? null : <section className="wf-node-run"><header><b>本次运行</b><span data-status={status}>{nodeStatusLabel(status)}</span></header>
      {progress === undefined ? null : <details><summary>查看已保存进度</summary><pre>{JSON.stringify(progress, null, 2)}</pre></details>}
      {output === undefined ? null : <details><summary>查看节点输出</summary><pre>{JSON.stringify(output, null, 2)}</pre></details>}
    </section>}
    <details className="wf-advanced"><summary>高级配置 · 原始 JSON 与输出契约</summary>
      <JsonEditor label="节点原始配置" value={node.with} onChange={value => onChange({ ...node, with: value })} />
      <JsonEditor label="预期输出契约" value={(node.expects ?? {}) as unknown as CanvasJsonObject} onChange={value => {
        const { expects: _expects, ...withoutExpectation } = node
        onChange(Object.keys(value).length === 0 ? withoutExpectation : { ...withoutExpectation, expects: value as unknown as NonNullable<CanvasWorkflowNode['expects']> })
      }} />
    </details>
    <button className="wf-danger" onClick={onDelete}>删除节点</button>
  </div>
}

function SchemaObjectEditor({ schema, value, onChange }: {
  readonly schema: CanvasJsonObject | undefined
  readonly value: CanvasJsonObject
  readonly onChange: (value: CanvasJsonObject) => void
}) {
  const properties = isObject(schema?.properties) ? schema.properties : undefined
  if (properties === undefined || Object.keys(properties).length === 0) return null
  const required = new Set(Array.isArray(schema?.required) ? schema.required.filter(item => typeof item === 'string') : [])
  return <fieldset className="wf-schema-form"><legend>节点参数</legend>{Object.entries(properties).map(([name, candidate]) => {
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
  const serialized = JSON.stringify(value, null, 2)
  const [text, setText] = useState(serialized)
  const [invalid, setInvalid] = useState(false)
  useEffect(() => { setText(serialized); setInvalid(false) }, [serialized])
  return <label data-invalid={invalid}>{label}{invalid ? <span className="wf-field-error">需要一个合法的 JSON object</span> : null}<textarea value={text} onChange={event => setText(event.target.value)} onBlur={() => {
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
  const serialized = JSON.stringify(value, null, 2)
  const [text, setText] = useState(serialized)
  const [invalid, setInvalid] = useState(false)
  useEffect(() => { setText(serialized); setInvalid(false) }, [serialized])
  return <label data-invalid={invalid}>声明的依赖（Allowlist）{invalid ? <span className="wf-field-error">每项必须包含 kind 和 uses</span> : null}<textarea value={text} onChange={event => setText(event.target.value)} onBlur={() => {
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
  if (diagnostics.length === 0) return <div className="wf-panel-empty"><b>{documentState === 'validated' || documentState === 'validated-dirty' ? '校验通过' : '尚未校验'}</b><span>{documentState === 'validated' || documentState === 'validated-dirty' ? '当前模板没有发现结构、依赖或 Schema 问题。' : '点击顶部“校验”，使用与运行时相同的编译规则检查当前工作流。'}</span></div>
  return <div className="wf-diagnostics">{diagnostics.map((item, index) => <button key={`${item.code}-${index}`} data-severity={item.severity} onClick={() => { if (item.nodeId !== undefined) onSelect(item.nodeId) }}>
    <span>{item.severity === 'error' ? '×' : '!'}</span><div><b>{diagnosticTitle(item)}</b><p>{item.message}</p><small>{item.nodeId === undefined ? `工作流 · ${item.code}` : `${item.nodeId} · ${item.code}`}</small></div>
  </button>)}</div>
}

function DiffView({ diff }: { readonly diff: CanvasTemplateDiff | undefined }) {
  if (diff === undefined) return <div className="wf-panel-empty"><b>尚未比较变更</b><span>先保存一次草稿，再比较当前画布与已保存修订。</span></div>
  return <div className="wf-diff">
    <div className="wf-diff-flags"><Flag on={diff.semanticChanged} text="语义变更" /><Flag on={diff.layoutChanged} text="仅布局变更" /></div>
    <ChangeSet label="节点" value={diff.nodes} />
    <ChangeSet label="连接" value={diff.edges} />
  </div>
}

function ChangeSet({ label, value }: { readonly label: string; readonly value: { readonly added: readonly string[]; readonly removed: readonly string[]; readonly changed: readonly string[] } }) {
  const labels = { added: '新增', changed: '修改', removed: '删除' }
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
  return <section className="wf-welcome">
    <span className="wf-welcome-kicker">一个 JSON 模板，一条可审计执行链</span>
    <h1>从一个明确的结果开始</h1>
    <p>Agent、画布和 DAG Engine 始终操作同一份 WorkflowTemplate。你可以直接跑示例，也可以让 Agent 把离散步骤编排成 DAG。</p>
    <div className="wf-welcome-actions">
      <button className="wf-welcome-primary" onClick={onStarter}><span>01</span><b>从可运行示例开始</b><small>两节点回显工作流，不需要外部 Tool</small></button>
      <button onClick={onAgentPrompt}><span>02</span><b>让 Agent 创建</b><small>复制一条遵循 workflow-builder 的创建指令</small></button>
      {catalog[0] === undefined ? <button disabled><span>03</span><b>打开已有草稿</b><small>当前还没有草稿</small></button> : <button onClick={() => onOpen(catalog[0]!.id)}><span>03</span><b>继续最近草稿</b><small>{catalog[0]!.name} · 草稿修订 {catalog[0]!.draftRevision}</small></button>}
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

function nodeStatusLabel(status: string | undefined): string {
  const labels: Record<string, string> = {
    pending: '等待', ready: '就绪', running: '运行中', waiting: '等待人工处理', succeeded: '已完成',
    failed: '失败', cancelled: '已取消', skipped: '已跳过', needs_attention: '需要处理', draft: '草稿',
  }
  return labels[status ?? 'draft'] ?? status ?? '草稿'
}

function runStatusLabel(status: CanvasTrace['status'] | undefined): string {
  if (status === undefined) return '尚未运行'
  return { running: '运行中', completed: '运行完成', failed: '运行失败', cancelled: '已取消', paused: '等待处理' }[status]
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
@media(max-width:900px){.wf-studio{grid-template-columns:210px minmax(0,1fr) 280px}.wf-brand{width:210px}.wf-doc-title code{display:none}.wf-actions button:nth-child(-n+2){display:none}.wf-trace-head .wf-section-label{min-width:210px}.wf-trace-head textarea{width:240px}}
`

const CANVAS_CSS = String.raw`
.wf-canvas .react-flow__minimap{width:150px!important;height:92px!important}.wf-canvas-loading{position:absolute;inset:0;display:grid;place-items:center;color:var(--muted);font-size:9px;letter-spacing:.16em}
.wf-schema-form{border:1px solid var(--line);padding:11px;margin:0 0 16px}.wf-schema-form legend{color:var(--accent);font-size:8px;letter-spacing:.12em;padding:0 6px}.wf-schema-form label{margin-bottom:10px}.wf-schema-form select{display:block;width:100%;margin-top:7px;background:#191c1a;border:1px solid var(--line);color:var(--ink);font:10px inherit;padding:8px}.wf-schema-form input[type=checkbox]{display:inline-block;width:auto;margin-left:10px;accent-color:var(--accent)}
.wf-studio{--ink:#e7e4da;--muted:#85847e;--panel:#151716;--line:#343732;--accent:#ed5a3d;--green:#70c77b;position:absolute;inset:0;pointer-events:auto;background:#0d0f0e;color:var(--ink);font-family:"IBM Plex Mono","SFMono-Regular",monospace;display:grid;grid-template:58px minmax(0,1fr) 190px / 248px minmax(0,1fr) 336px;overflow:hidden;z-index:40}.wf-studio *{box-sizing:border-box}.wf-topbar{grid-column:1/-1;display:flex;align-items:center;border-bottom:1px solid var(--line);background:#111312;z-index:3}.wf-brand{width:248px;height:100%;display:flex;align-items:center;gap:12px;padding:0 18px;border-right:1px solid var(--line)}.wf-brand-mark{font:900 24px/1 Arial;color:var(--accent);transform:skew(-8deg)}.wf-brand b{display:block;letter-spacing:.14em;font-size:12px}.wf-brand small{display:block;color:var(--muted);font-size:8px;letter-spacing:.25em;margin-top:3px}.wf-doc-title{min-width:0;flex:1;display:flex;align-items:center;gap:10px;padding:0 18px}.wf-status-dot{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 12px var(--green)}.wf-status-dot[data-busy=true]{background:#e7b44e;animation:wf-pulse 1s infinite}.wf-doc-title input{width:min(42vw,420px);background:transparent;border:0;color:var(--ink);font:600 15px/1 "IBM Plex Mono",monospace;outline:none}.wf-doc-title code{color:var(--muted);font-size:10px}.wf-actions{display:flex;height:100%}.wf-actions button,.wf-trace button{border:0;border-left:1px solid var(--line);background:transparent;color:var(--ink);font:700 10px/1 inherit;letter-spacing:.08em;padding:0 14px;cursor:pointer}.wf-actions button:hover,.wf-trace button:hover{background:#252823}.wf-actions button:disabled,.wf-trace button:disabled{opacity:.35;cursor:not-allowed}.wf-actions .wf-primary{background:var(--accent);color:#160d09}.wf-actions .wf-close{font-size:22px;padding:0 18px}.wf-palette{grid-row:2;grid-column:1;border-right:1px solid var(--line);background:#121413;padding:16px 12px 8px;display:flex;flex-direction:column;min-height:0}.wf-section-label{display:flex;gap:9px;color:#c1bfb7;font-size:9px;letter-spacing:.18em;margin:3px 4px 10px}.wf-section-label span{color:var(--accent)}.wf-palette select{width:100%;background:#1b1e1b;border:1px solid var(--line);color:var(--ink);padding:9px;font:10px inherit;margin-bottom:22px}.wf-node-list{overflow:auto;display:flex;flex-direction:column;gap:6px}.wf-palette-node{text-align:left;display:grid;grid-template-columns:28px 1fr;border:1px solid #2c2f2b;background:#171a18;color:var(--ink);padding:9px;cursor:pointer}.wf-palette-node:hover{border-color:var(--accent);transform:translateX(2px)}.wf-palette-node>span{grid-row:1/3;color:var(--accent);font-size:16px}.wf-palette-node b{font-size:10px}.wf-palette-node small{color:var(--muted);font-size:8px;margin-top:4px}.wf-palette-foot{margin-top:auto;padding:12px 3px 2px;display:flex;justify-content:space-between;color:var(--muted);font-size:8px;border-top:1px solid var(--line)}.wf-canvas{grid-row:2;grid-column:2;position:relative;min-width:0;background:radial-gradient(circle at 50% 40%,#1c211d 0,#0d0f0e 62%)}.wf-coordinate{position:absolute;z-index:2;top:12px;left:14px;color:#73766e;font-size:8px;letter-spacing:.12em}.wf-canvas .react-flow__controls{background:#171a18;border:1px solid var(--line);box-shadow:none}.wf-canvas .react-flow__controls button{background:#171a18;color:var(--ink);border-bottom-color:var(--line)}.wf-canvas .react-flow__minimap{background:#111311;border:1px solid var(--line)}.wf-canvas .react-flow__edge-path{stroke:#706f69;stroke-width:1.5}.wf-canvas .react-flow__edge.selected .react-flow__edge-path{stroke:var(--accent)}.wf-edge-skipped .react-flow__edge-path{stroke-dasharray:3 5;opacity:.35}.wf-graph-node{position:relative;width:210px;min-height:86px;background:#191c1a;border:1px solid #41443f;padding:17px 14px 12px;box-shadow:0 12px 34px #0007}.wf-graph-node:before{content:"";position:absolute;left:-1px;top:-1px;width:4px;height:calc(100% + 2px);background:#77766f}.wf-graph-node[data-selected=true]{border-color:var(--accent);box-shadow:0 0 0 1px #ed5a3d55,0 18px 45px #0009}.wf-graph-node[data-status=succeeded]:before{background:var(--green)}.wf-graph-node[data-status=running]:before,.wf-graph-node[data-status=waiting]:before{background:#e7b44e}.wf-graph-node[data-status=failed]:before,.wf-graph-node[data-status=needs_attention]:before{background:var(--accent)}.wf-node-cap{display:flex;justify-content:space-between;color:var(--accent);font:700 10px/1 inherit}.wf-node-cap em{font-style:normal;color:var(--muted);font-size:7px;text-transform:uppercase}.wf-graph-node h3{font:700 12px/1.2 inherit;margin:13px 0 6px}.wf-graph-node code{color:#8d9189;font-size:8px}.wf-handle{width:8px!important;height:8px!important;background:#d9d6cc!important;border:2px solid #171a18!important}.wf-inspector{grid-row:2;grid-column:3;border-left:1px solid var(--line);background:#121413;min-height:0;overflow:hidden}.wf-inspector>nav{height:37px;border-bottom:1px solid var(--line);display:flex}.wf-inspector>nav button{flex:1;border:0;border-right:1px solid var(--line);background:transparent;color:var(--muted);font:700 8px inherit;letter-spacing:.15em;cursor:pointer}.wf-inspector>nav button[data-active=true]{color:var(--ink);box-shadow:inset 0 -2px var(--accent)}.wf-panel-body,.wf-diagnostics,.wf-diff{height:calc(100% - 37px);overflow:auto;padding:19px}.wf-eyebrow{color:var(--accent);font-size:8px;letter-spacing:.18em;margin:0 0 12px}.wf-panel-body h2{font:600 22px/1.1 "Georgia",serif;margin:0 0 8px}.wf-uses{display:block;color:var(--muted);font-size:9px;margin-bottom:24px}.wf-panel-body label{display:block;color:#8e8e88;font-size:8px;letter-spacing:.12em;margin:0 0 16px}.wf-panel-body input,.wf-panel-body textarea{display:block;width:100%;margin-top:7px;background:#191c1a;border:1px solid var(--line);color:var(--ink);font:10px/1.5 inherit;padding:9px;outline:none}.wf-panel-body textarea{min-height:82px;resize:vertical}.wf-panel-body label[data-invalid=true]{color:var(--accent)}.wf-panel-body label[data-invalid=true] textarea{border-color:var(--accent)}.wf-danger{width:100%;border:1px solid #773a2f;background:#241612;color:#ee765d;font:700 9px inherit;padding:11px;cursor:pointer}.wf-panel-empty{height:calc(100% - 37px);display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;color:var(--muted);padding:40px}.wf-panel-empty b{color:var(--ink);font-size:11px;margin-bottom:9px}.wf-panel-empty span{font-size:9px;line-height:1.7}.wf-diagnostics{padding:12px}.wf-diagnostics>button{width:100%;display:grid;grid-template-columns:25px 1fr;text-align:left;background:#171a18;border:1px solid var(--line);color:var(--ink);padding:11px;margin-bottom:7px;cursor:pointer}.wf-diagnostics>button>span{color:#e7b44e;font-size:18px}.wf-diagnostics>button[data-severity=error]>span{color:var(--accent)}.wf-diagnostics b{font-size:9px}.wf-diagnostics p{font-size:9px;line-height:1.5;color:#b3b1aa;margin:6px 0}.wf-diagnostics small{font-size:8px;color:var(--muted)}.wf-diff-flags{display:flex;gap:7px;margin-bottom:20px}.wf-diff-flags span{border:1px solid var(--line);padding:7px;font-size:8px;color:var(--muted)}.wf-diff-flags span[data-on=true]{border-color:var(--accent);color:var(--accent)}.wf-diff section{border-top:1px solid var(--line);padding:13px 0}.wf-diff section h3{font-size:10px}.wf-diff section div{display:grid;grid-template-columns:65px 1fr;font-size:8px;padding:6px 0}.wf-diff section div b{text-transform:uppercase;color:var(--muted)}.wf-trace{grid-row:3;grid-column:1/-1;border-top:1px solid var(--line);background:#101211;display:grid;grid-template-rows:44px 1fr 22px;min-width:0}.wf-trace-head{display:flex;align-items:stretch;border-bottom:1px solid var(--line)}.wf-trace-head .wf-section-label{align-items:center;margin:0;padding:0 18px;min-width:248px}.wf-trace-head textarea{width:290px;resize:none;background:#171a18;border:0;border-left:1px solid var(--line);color:var(--ink);font:9px/1.4 inherit;padding:7px 10px}.wf-trace-head .wf-run{background:#d8d5ca;color:#141514}.wf-run-state{margin-left:auto;align-self:center;margin-right:17px;border:1px solid var(--line);padding:6px 10px;color:var(--muted);font-size:8px;text-transform:uppercase}.wf-run-state.wf-completed{color:var(--green);border-color:#315f37}.wf-run-state.wf-failed,.wf-run-state.wf-paused{color:var(--accent);border-color:#6a3329}.wf-events{display:flex;gap:7px;padding:9px 12px;overflow:auto}.wf-events button{flex:0 0 180px;text-align:left;display:grid;grid-template-columns:28px 1fr;border:1px solid #292c29;background:#151815;color:var(--ink);padding:7px;cursor:pointer}.wf-events button span{grid-row:1/3;color:var(--accent);font-size:8px}.wf-events button b{font-size:8px}.wf-events button small{font-size:7px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:5px}.wf-empty-line{align-self:center;color:var(--muted);font-size:9px;padding-left:7px}.wf-statusbar{display:flex;justify-content:space-between;align-items:center;background:var(--accent);color:#190e0b;padding:0 9px;font:800 7px inherit;letter-spacing:.09em;white-space:nowrap;overflow:hidden}.wf-statusbar span:last-child{overflow:hidden;text-overflow:ellipsis;margin-left:30px}@keyframes wf-pulse{50%{opacity:.35;box-shadow:none}}@media(max-width:1000px){.wf-studio{grid-template-columns:210px minmax(0,1fr) 290px}.wf-brand{width:210px}.wf-actions button{padding:0 8px}.wf-doc-title code{display:none}}`

const EXPERIENCE_CSS = String.raw`
.wf-studio button:focus-visible,.wf-studio input:focus-visible,.wf-studio textarea:focus-visible,.wf-studio select:focus-visible,.wf-studio summary:focus-visible{outline:2px solid var(--wf-brand);outline-offset:2px}
.wf-status-dot[data-connection=disconnected]{background:var(--wf-danger);box-shadow:0 0 0 4px color-mix(in srgb,var(--wf-danger) 14%,transparent)}.wf-status-dot[data-connection=reconnecting],.wf-status-dot[data-connection=connecting]{background:var(--wf-warning);box-shadow:0 0 0 4px color-mix(in srgb,var(--wf-warning) 14%,transparent)}
.wf-document-state{flex:none;padding:5px 8px;border:1px solid var(--wf-border);border-radius:999px;background:var(--wf-surface-soft);color:var(--wf-muted);font-size:9px;white-space:nowrap}.wf-document-state[data-state=dirty],.wf-document-state[data-state=unsaved],.wf-document-state[data-state=validated-dirty]{border-color:color-mix(in srgb,var(--wf-warning) 40%,var(--wf-border));color:var(--wf-warning)}.wf-document-state[data-state=validated],.wf-document-state[data-state=published]{border-color:color-mix(in srgb,var(--wf-success) 40%,var(--wf-border));color:var(--wf-success)}
.wf-system-banner,.wf-error-banner{position:absolute;z-index:12;top:76px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:11px;width:min(720px,calc(100% - 48px));padding:10px 12px;border:1px solid var(--wf-border);border-radius:10px;background:var(--wf-surface);box-shadow:var(--wf-shadow);font-size:10px}.wf-system-banner b{color:var(--wf-text)}.wf-system-banner span{flex:1;color:var(--wf-muted)}.wf-system-banner button,.wf-error-banner button{border:1px solid var(--wf-border);border-radius:7px;background:var(--wf-surface-soft);color:var(--wf-text);padding:6px 9px;cursor:pointer}.wf-system-banner[data-kind=danger]{border-color:color-mix(in srgb,var(--wf-danger) 40%,var(--wf-border))}.wf-system-banner[data-kind=warning]{border-color:color-mix(in srgb,var(--wf-warning) 40%,var(--wf-border))}.wf-recovery{top:120px}.wf-error-banner{top:120px;align-items:flex-start;border-color:color-mix(in srgb,var(--wf-danger) 40%,var(--wf-border))}.wf-error-banner>div:first-child{display:grid;gap:4px;flex:1}.wf-error-banner span{color:var(--wf-muted);line-height:1.5}.wf-error-banner details{color:var(--wf-muted)}.wf-error-banner code{display:block;max-height:80px;overflow:auto;margin-top:5px;padding:7px;border-radius:6px;background:var(--wf-surface-soft);white-space:pre-wrap}.wf-error-banner>div:last-child{display:flex;gap:6px}
.wf-section-row{display:flex;align-items:center;justify-content:space-between}.wf-section-row .wf-section-label{margin-bottom:10px}.wf-section-row>button{width:26px;height:26px;border:1px solid var(--wf-border);border-radius:7px;background:transparent;color:var(--wf-muted);cursor:pointer}.wf-palette-tabs{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:9px;padding:3px;border-radius:9px;background:var(--wf-surface-soft)}.wf-palette-tabs button{display:flex;justify-content:center;gap:5px;border:0;border-radius:7px;background:transparent;color:var(--wf-muted);font:600 10px var(--dsw-font-family),sans-serif;padding:7px;cursor:pointer}.wf-palette-tabs button[data-active=true]{background:var(--wf-surface);color:var(--wf-brand);box-shadow:0 2px 7px rgba(31,43,68,.08)}.wf-palette-tabs span{font-size:8px}.wf-list-empty{padding:24px 8px;text-align:center;color:var(--wf-muted);font-size:10px}
.wf-welcome{position:absolute;z-index:4;left:50%;top:50%;width:min(690px,calc(100% - 80px));transform:translate(-50%,-50%);padding:31px;border:1px solid var(--wf-border);border-radius:18px;background:color-mix(in srgb,var(--wf-surface) 96%,transparent);box-shadow:0 22px 65px rgba(31,43,68,.14);backdrop-filter:blur(18px)}.wf-welcome-kicker{color:var(--wf-brand);font-size:10px;font-weight:700}.wf-welcome h1{margin:9px 0 8px;color:var(--wf-text);font-size:25px;letter-spacing:-.025em}.wf-welcome>p{max-width:570px;margin:0;color:var(--wf-muted);font-size:11px;line-height:1.7}.wf-welcome-actions{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-top:24px}.wf-welcome-actions button{display:grid;grid-template-columns:28px 1fr;min-height:94px;padding:13px;border:1px solid var(--wf-border);border-radius:11px;background:var(--wf-surface-soft);color:var(--wf-text);text-align:left;cursor:pointer}.wf-welcome-actions button:hover:not(:disabled){border-color:var(--wf-brand);transform:translateY(-2px)}.wf-welcome-actions button>span{grid-row:1/3;color:var(--wf-brand);font-size:9px;font-weight:750}.wf-welcome-actions b{font-size:11px}.wf-welcome-actions small{margin-top:5px;color:var(--wf-muted);font-size:9px;line-height:1.4}.wf-welcome-actions .wf-welcome-primary{background:var(--wf-brand);border-color:var(--wf-brand);color:#fff}.wf-welcome-actions .wf-welcome-primary span,.wf-welcome-actions .wf-welcome-primary small{color:#dce8ff}
.wf-advanced{margin:2px 0 18px;border:1px solid var(--wf-border);border-radius:10px;background:color-mix(in srgb,var(--wf-surface-soft) 58%,transparent)}.wf-advanced>summary{padding:11px 12px;color:var(--wf-text);font-size:10px;font-weight:650;cursor:pointer}.wf-advanced>p{margin:0;padding:0 12px 11px;color:var(--wf-muted);font-size:9px;line-height:1.55}.wf-advanced[open]{padding-bottom:2px}.wf-advanced[open]>summary{margin-bottom:10px;border-bottom:1px solid var(--wf-border)}.wf-advanced>label{margin-inline:12px}.wf-field-error{float:right;color:var(--wf-danger);font-weight:500;letter-spacing:0}.wf-node-run{margin:2px 0 16px;padding:11px;border:1px solid var(--wf-border);border-radius:10px;background:var(--wf-surface-soft)}.wf-node-run header{display:flex;justify-content:space-between;font-size:10px}.wf-node-run header span{color:var(--wf-success)}.wf-node-run details{margin-top:9px;color:var(--wf-muted);font-size:9px}.wf-node-run pre{max-height:150px;overflow:auto;padding:8px;border-radius:7px;background:var(--wf-surface);color:var(--wf-text);font:9px/1.45 var(--ds-font-family-code),monospace;white-space:pre-wrap}
.wf-trace-head .wf-subtle,.wf-trace-head .wf-copy-run{font-size:9px;color:var(--wf-muted)}.wf-run-failure{flex:0 0 270px;display:grid;grid-template-columns:30px 1fr;align-items:center;padding:8px 10px;border:1px solid color-mix(in srgb,var(--wf-danger) 38%,var(--wf-border));border-radius:9px;background:color-mix(in srgb,var(--wf-danger) 7%,var(--wf-surface));color:var(--wf-text)}.wf-run-failure>span{color:var(--wf-danger);font-size:18px}.wf-run-failure div{display:grid;gap:4px}.wf-run-failure small{color:var(--wf-muted);font-size:8px;line-height:1.35}.wf-events button[data-tone=danger]{border-color:color-mix(in srgb,var(--wf-danger) 45%,var(--wf-border))}.wf-events button[data-tone=success]{border-color:color-mix(in srgb,var(--wf-success) 34%,var(--wf-border))}.wf-events button[data-tone=warning]{border-color:color-mix(in srgb,var(--wf-warning) 40%,var(--wf-border))}
.wf-studio[data-surface=operations]>.wf-palette,.wf-studio[data-surface=operations]>.wf-canvas,.wf-studio[data-surface=operations]>.wf-inspector,.wf-studio[data-surface=operations]>.wf-trace{display:none}.wf-operations{grid-row:2/4;grid-column:1/-1;overflow:auto;padding:30px;background:var(--wf-bg);color:var(--wf-text)}.wf-operations>header{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;max-width:1320px;margin:0 auto 25px}.wf-operations>header p{margin:0 0 8px;color:var(--wf-brand);font-size:9px;font-weight:800;letter-spacing:.18em}.wf-operations>header h1{margin:0 0 8px;font-size:24px}.wf-operations>header span{color:var(--wf-muted);font-size:10px}.wf-operations>header button{height:36px;padding:0 14px;border:1px solid var(--wf-border);border-radius:8px;background:var(--wf-surface);color:var(--wf-text);cursor:pointer}.wf-operations-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;max-width:1320px;margin:auto}.wf-operations-grid>section{min-height:360px;padding:15px;border:1px solid var(--wf-border);border-radius:14px;background:var(--wf-surface)}.wf-operations-grid h2{display:flex;justify-content:space-between;margin:0 0 13px;font-size:12px}.wf-operations-grid h2 em{font-style:normal;color:var(--wf-brand)}.wf-operations-grid article{position:relative;display:grid;gap:6px;margin-bottom:8px;padding:12px;border:1px solid var(--wf-border);border-radius:9px;background:var(--wf-surface-soft)}.wf-operations-grid article[data-status=rejected],.wf-operations-grid article[data-status=unknown]{border-color:color-mix(in srgb,var(--wf-danger) 40%,var(--wf-border))}.wf-operations-grid article b{font-size:10px}.wf-operations-grid article code{color:var(--wf-brand);font-size:8px}.wf-operations-grid article span,.wf-operations-grid article small{overflow:hidden;color:var(--wf-muted);font-size:8px;text-overflow:ellipsis;white-space:nowrap}.wf-operations-grid article button{position:absolute;right:9px;top:9px;border:0;background:transparent;color:var(--wf-brand);font-size:8px;cursor:pointer}.wf-operation-empty{display:grid;place-items:center;min-height:260px;color:var(--wf-success);font-size:24px}.wf-operation-empty span{color:var(--wf-muted);font-size:9px}@media(max-width:900px){.wf-operations-grid{grid-template-columns:1fr}.wf-operations{padding:18px}}
.wf-modal-backdrop{position:absolute;inset:0;z-index:50;display:grid;place-items:center;background:rgba(16,24,40,.34);backdrop-filter:blur(4px)}.wf-modal{width:min(440px,calc(100% - 36px));padding:28px;border:1px solid var(--wf-border);border-radius:17px;background:var(--wf-surface);box-shadow:0 26px 80px rgba(16,24,40,.3);color:var(--wf-text)}.wf-modal-icon{display:grid;place-items:center;width:42px;height:42px;border-radius:12px;background:var(--wf-brand-soft);color:var(--wf-brand);font-size:22px}.wf-modal h2{margin:17px 0 8px;font-size:19px}.wf-modal p{margin:0;color:var(--wf-muted);font-size:11px;line-height:1.7}.wf-modal>div{display:flex;justify-content:flex-end;gap:8px;margin-top:24px}.wf-modal button{height:36px;padding:0 15px;border:1px solid var(--wf-border);border-radius:8px;background:var(--wf-surface-soft);color:var(--wf-text);cursor:pointer}.wf-modal .wf-primary{border-color:var(--wf-brand);background:var(--wf-brand);color:#fff}
@media(max-width:900px){.wf-welcome-actions{grid-template-columns:1fr}.wf-welcome{width:calc(100% - 36px);padding:22px}.wf-welcome-actions button{min-height:68px}.wf-document-state{display:none}.wf-actions button:nth-child(-n+2){display:inline-flex}.wf-system-banner,.wf-error-banner{width:calc(100% - 24px)}}
`
