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
  useState,
  type CSSProperties,
} from 'react'
import type {
  CanvasCatalogSummary,
  CanvasJsonObject,
  CanvasNodeDefinition,
  CanvasRunResult,
  CanvasTemplateDiff,
  CanvasTrace,
  CanvasWorkflowDiagnostic,
  CanvasWorkflowDraft,
  CanvasWorkflowNode,
  CanvasWorkflowTemplate,
} from '../types.js'
import type { WorkflowCanvasClientApi } from './api.js'
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

export interface WorkflowStudioProps {
  readonly api: WorkflowCanvasClientApi
  readonly sessionId: string
  readonly initialTemplate?: CanvasWorkflowTemplate
  readonly initialTarget?: WorkflowCanvasUiTarget
  readonly onClose?: () => void
}

type RightPanel = 'inspector' | 'diagnostics' | 'diff'

export function WorkflowStudio({ api, sessionId, initialTemplate, initialTarget, onClose }: WorkflowStudioProps) {
  const [definitions, setDefinitions] = useState<readonly CanvasNodeDefinition[]>([])
  const [catalog, setCatalog] = useState<readonly CanvasCatalogSummary[]>([])
  const [draft, setDraft] = useState<CanvasWorkflowDraft>()
  const [template, setTemplate] = useState<CanvasWorkflowTemplate>(() => initialTemplate ?? blankTemplate())
  const [selectedNode, setSelectedNode] = useState<string | undefined>(initialTarget?.nodeId)
  const [diagnostics, setDiagnostics] = useState<readonly CanvasWorkflowDiagnostic[]>([])
  const [diff, setDiff] = useState<CanvasTemplateDiff>()
  const [trace, setTrace] = useState<CanvasTrace>()
  const [runResult, setRunResult] = useState<CanvasRunResult>()
  const [rightPanel, setRightPanel] = useState<RightPanel>('inspector')
  const [inputsText, setInputsText] = useState('{}')
  const [paletteQuery, setPaletteQuery] = useState('')
  const [status, setStatus] = useState('READY / UNSAVED')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const execute = useCallback(async <T,>(label: string, operation: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true)
    setError(undefined)
    setStatus(`${label.toUpperCase()}…`)
    try {
      const value = await operation()
      setStatus(`${label.toUpperCase()} / OK`)
      return value
    } catch (cause: unknown) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message)
      setStatus(`${label.toUpperCase()} / FAILED`)
      return undefined
    } finally {
      setBusy(false)
    }
  }, [])

  const refreshCatalog = useCallback(async () => {
    const [nodeResult, templateResult] = await Promise.all([
      api.remote.nodes(sessionId),
      api.remote.templates(sessionId),
    ])
    setDefinitions(api.unwrap('workflowCanvas.nodes', nodeResult))
    setCatalog(api.unwrap('workflowCanvas.templates', templateResult))
  }, [api, sessionId])

  useEffect(() => { void execute('sync catalog', refreshCatalog) }, [execute, refreshCatalog])

  const flow = useMemo(() => templateToFlow(template, definitions, trace), [template, definitions, trace])
  const selected = template.spec.nodes.find(node => node.id === selectedNode)
  const filteredDefinitions = useMemo(() => {
    const query = paletteQuery.trim().toLocaleLowerCase()
    if (query.length === 0) return definitions
    return definitions.filter(definition => [definition.title, definition.description, definition.uses, definition.toolName]
      .some(value => value?.toLocaleLowerCase().includes(query)))
  }, [definitions, paletteQuery])

  const save = useCallback(async (): Promise<CanvasWorkflowDraft | undefined> => execute('save draft', async () => {
    const result = draft === undefined
      ? await api.remote.createDraft(sessionId, { template })
      : await api.remote.updateDraft(sessionId, { id: draft.id, expectedRevision: draft.revision, template })
    const next = api.unwrap('workflowCanvas.save', result)
    setDraft(next)
    setTemplate(next.template)
    await refreshCatalog()
    return next
  }), [api, draft, execute, refreshCatalog, sessionId, template])

  const validate = useCallback(async () => execute('validate', async () => {
    const result = api.unwrap('workflowCanvas.validate', await api.remote.validate(sessionId, { template }))
    setDiagnostics(result.diagnostics)
    setRightPanel('diagnostics')
    return result
  }), [api, execute, sessionId, template])

  const showDiff = useCallback(async () => {
    if (draft === undefined) { setError('Save the draft before requesting a catalog diff.'); return }
    await execute('diff', async () => {
      const value = api.unwrap('workflowCanvas.diff', await api.remote.diff(sessionId, { id: draft.id, candidate: template }))
      setDiff(value)
      setRightPanel('diff')
      return value
    })
  }, [api, draft, execute, sessionId, template])

  const publish = useCallback(async () => {
    const saved = await save()
    if (saved === undefined) return
    await execute('publish', async () => {
      const published = api.unwrap('workflowCanvas.publish', await api.remote.publish(sessionId, {
        id: saved.id,
        expectedRevision: saved.revision,
      }))
      await refreshCatalog()
      setStatus(`PUBLISHED / R${published.revision}`)
      return published
    })
  }, [api, execute, refreshCatalog, save, sessionId])

  const loadDraft = useCallback(async (id: string) => execute('open draft', async () => {
    const value = api.unwrap('workflowCanvas.readDraft', await api.remote.readDraft(sessionId, { id }))
    setDraft(value)
    setTemplate(value.template)
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
    void execute('open trace', async () => {
      const value = api.unwrap('workflowCanvas.trace', await api.remote.trace(sessionId, { runId: initialTarget.runId! }))
      setTrace(value)
      return value
    })
  }, [api, execute, initialTarget?.runId, sessionId])

  const runDraft = useCallback(async () => execute('test run', async () => {
    const parsed = JSON.parse(inputsText) as unknown
    if (!isObject(parsed)) throw new Error('Run inputs must be a JSON object.')
    const result = api.unwrap('workflowCanvas.runDraft', await api.remote.runDraft(sessionId, { template, inputs: parsed }))
    setRunResult(result)
    const nextTrace = api.unwrap('workflowCanvas.trace', await api.remote.trace(sessionId, { runId: result.runId }))
    setTrace(nextTrace)
    return result
  }), [api, execute, inputsText, sessionId, template])

  const refreshTrace = useCallback(async () => {
    const runId = runResult?.runId ?? trace?.runId
    if (runId === undefined) return
    await execute('refresh trace', async () => {
      const value = api.unwrap('workflowCanvas.trace', await api.remote.trace(sessionId, { runId }))
      setTrace(value)
      return value
    })
  }, [api, execute, runResult?.runId, sessionId, trace?.runId])

  const resumeRun = useCallback(async (resolution?: 'retry' | 'fail') => {
    if (runResult === undefined) return
    await execute('resume run', async () => {
      const unknownNodeResolutions = resolution === undefined || runResult.needsAttention === undefined
        ? undefined
        : Object.fromEntries(runResult.needsAttention.map(nodeId => [nodeId, resolution] as const))
      const result = api.unwrap('workflowCanvas.resume', await api.remote.resume(sessionId, {
        runId: runResult.runId,
        ...(unknownNodeResolutions === undefined ? {} : { unknownNodeResolutions }),
      }))
      setRunResult(result)
      setTrace(api.unwrap('workflowCanvas.trace', await api.remote.trace(sessionId, { runId: result.runId })))
      return result
    })
  }, [api, execute, runResult, sessionId])

  const mutate = useCallback((next: CanvasWorkflowTemplate) => {
    setTemplate(next)
    setStatus(draft === undefined ? 'READY / UNSAVED' : `DRAFT R${draft.revision} / DIRTY`)
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

  const nodes = flow.nodes
  const edges = flow.edges

  return <div className="wf-studio" data-workflow-studio>
    <style>{CANVAS_CSS + PRODUCT_CSS}</style>
    <header className="wf-topbar">
      <div className="wf-brand">
        <span className="wf-brand-mark">D</span>
        <span><b>DSH WORKFLOW</b><small>GUARDED DAG STUDIO</small></span>
      </div>
      <div className="wf-doc-title">
        <span className="wf-status-dot" data-busy={busy} />
        <input value={template.metadata.name} aria-label="Workflow name" onChange={event => mutate({
          ...template,
          metadata: { ...template.metadata, name: event.target.value },
        })} />
        <code>{template.metadata.id}</code>
      </div>
      <div className="wf-guardrails" aria-label="Workflow guardrails">
        <span><i />{template.spec.requires?.length ?? 0} 项依赖</span>
        <span><i />审计开启</span>
        <span><i />Schema 校验</span>
      </div>
      <div className="wf-actions">
        <button onClick={() => { setDraft(undefined); setTemplate(blankTemplate()); setTrace(undefined) }}>新建</button>
        <button onClick={() => void save()} disabled={busy}>保存</button>
        <button onClick={() => void validate()} disabled={busy}>校验</button>
        <button onClick={() => void showDiff()} disabled={busy || draft === undefined}>差异</button>
        <button className="wf-primary" onClick={() => void publish()} disabled={busy}>发布</button>
        {onClose === undefined ? null : <button className="wf-close" onClick={onClose} aria-label="Close studio">×</button>}
      </div>
    </header>

    <aside className="wf-palette">
      <SectionLabel index="01" text="工作流" />
      <select value={draft?.id ?? ''} onChange={event => { if (event.target.value !== '') void loadDraft(event.target.value) }}>
        <option value="">选择一个草稿…</option>
        {catalog.map(item => <option key={item.id} value={item.id}>{item.name} · D{item.draftRevision}</option>)}
      </select>
      <SectionLabel index="02" text="节点与工具" />
      <div className="wf-palette-search">
        <span>⌕</span>
        <input value={paletteQuery} onChange={event => setPaletteQuery(event.target.value)} placeholder="搜索节点、Tool 或能力…" aria-label="Search workflow nodes" />
      </div>
      <div className="wf-node-list">
        {filteredDefinitions.map((definition, index) => <button
          key={definition.catalogId}
          className="wf-palette-node"
          onClick={() => mutate(addNode(template, definition, { x: 140 + index % 2 * 280, y: 100 + index * 36 }))}
        >
          <span>{nodeGlyph(definition)}</span>
          <b>{definition.title}</b>
          <small>{definition.description}</small>
          <em>{definition.kind === 'tool' ? 'DSH TOOL' : definition.uses}</em>
        </button>)}
      </div>
      <div className="wf-palette-foot"><span>{filteredDefinitions.length} / {definitions.length} 个节点</span><span>V1α1</span></div>
    </aside>

    <main className="wf-canvas">
      <div className="wf-coordinate"><b>工作流画布</b><span>{template.spec.nodes.length} 个节点 · {template.spec.edges.length} 条连接</span></div>
      {definitions.length === 0
        ? <div className="wf-canvas-loading">INDEXING TOOLS + NODES…</div>
        : <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={{ workflow: WorkflowNodeView }}
        fitView
        minZoom={0.25}
        maxZoom={1.8}
        onNodeClick={(_event, node) => { setSelectedNode(node.id); setRightPanel('inspector') }}
        onNodeDragStop={(_event, node) => mutate(moveNode(template, node.id, node.position))}
        onConnect={onConnect}
        onEdgesDelete={onEdgesDelete}
        deleteKeyCode={['Backspace', 'Delete']}
      >
        <Background color="rgba(217, 214, 204, .13)" gap={24} size={1} variant={BackgroundVariant.Dots} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeColor={node => statusColor(String(node.data.status ?? 'pending'))} />
      </ReactFlow>}
    </main>

    <aside className="wf-inspector">
      <nav>
        {(['inspector', 'diagnostics', 'diff'] as const).map(panel => <button
          key={panel}
          data-active={rightPanel === panel}
          onClick={() => setRightPanel(panel)}
        >{panel === 'inspector' ? '配置' : panel === 'diagnostics' ? `问题${diagnostics.length > 0 ? ` ${diagnostics.length}` : ''}` : '变更'}</button>)}
      </nav>
      {rightPanel === 'inspector'
        ? selected === undefined
          ? <WorkflowInspector template={template} onChange={mutate} />
          : <NodeInspector node={selected} definition={findNodeDefinition(definitions, selected)} onChange={updateSelected} onDelete={() => {
              mutate(removeNode(template, selected.id)); setSelectedNode(undefined)
            }} />
        : rightPanel === 'diagnostics'
          ? <Diagnostics diagnostics={diagnostics} onSelect={id => { setSelectedNode(id); setRightPanel('inspector') }} />
          : <DiffView diff={diff} />}
    </aside>

    <section className="wf-trace">
      <div className="wf-trace-head">
        <SectionLabel index="03" text="运行与审计" />
        <textarea value={inputsText} onChange={event => setInputsText(event.target.value)} aria-label="Run inputs JSON" />
        <button className="wf-run" onClick={() => void runDraft()} disabled={busy}>▶ 试运行</button>
        <button onClick={() => void refreshTrace()} disabled={busy || trace === undefined}>刷新轨迹</button>
        {runResult?.status === 'paused' && (runResult.needsAttention?.length ?? 0) === 0
          ? <button onClick={() => void resumeRun()} disabled={busy}>▶ RESUME</button>
          : null}
        {(runResult?.needsAttention?.length ?? 0) > 0
          ? <><button onClick={() => void resumeRun('retry')} disabled={busy}>↻ RETRY UNKNOWN</button><button onClick={() => void resumeRun('fail')} disabled={busy}>× FAIL UNKNOWN</button></>
          : null}
        <span className={`wf-run-state wf-${trace?.status ?? 'idle'}`}>{trace?.status ?? 'IDLE'}</span>
      </div>
      <div className="wf-events">
        {trace === undefined
          ? <div className="wf-empty-line">No execution sampled. Run the current draft to project persisted events here.</div>
          : trace.events.map((event, index) => <button key={`${String(event.seq)}-${index}`} onClick={() => {
              if (typeof event.nodeId === 'string') { setSelectedNode(event.nodeId); setRightPanel('inspector') }
            }}>
              <span>{String(event.seq).padStart(3, '0')}</span>
              <b>{String(event.type)}</b>
              <small>{typeof event.nodeId === 'string' ? event.nodeId : typeof event.edgeId === 'string' ? event.edgeId : trace.runId}</small>
            </button>)}
      </div>
      <div className="wf-statusbar"><span>{status}</span><span>{error ?? trace?.error ?? `SESSION ${sessionId}`}</span></div>
    </section>
  </div>
}

function WorkflowNodeView({ data, selected }: NodeProps<WorkflowFlowNode>) {
  const renderer = workflowNodeRenderers.resolve(data.template.uses)
  const Custom = renderer
  const ports = data.definition?.outputPorts ?? ['default']
  return <article className="wf-graph-node" data-selected={selected} data-status={data.status ?? 'pending'}>
    <div className="wf-node-cap"><span>{nodeGlyph(data.definition)}</span><em>{data.definition?.kind === 'tool' ? 'TOOL' : data.status ?? 'draft'}</em></div>
    {Custom === undefined
      ? <><h3>{data.template.title ?? data.definition?.title ?? data.template.id}</h3><code>{data.template.uses}</code></>
      : <Custom data={data} selected={selected} />}
    <div className="wf-node-foot"><span>{data.status ?? 'draft'}</span><span>{data.definition?.capabilities.length ?? 0} capabilities</span></div>
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
    <p className="wf-eyebrow">WORKFLOW ENVELOPE</p>
    <label>ID<input value={template.metadata.id} onChange={event => onChange({ ...template, metadata: { ...template.metadata, id: event.target.value } })} /></label>
    <label>DESCRIPTION<textarea value={template.metadata.description ?? ''} onChange={event => onChange({
      ...template,
      metadata: { ...template.metadata, description: event.target.value },
    })} /></label>
    <JsonEditor label="INPUT SCHEMA" value={template.spec.inputSchema} onChange={value => onChange({ ...template, spec: { ...template.spec, inputSchema: value } })} />
    <RequirementsEditor value={template.spec.requires ?? []} onChange={value => onChange({
      ...template,
      spec: { ...template.spec, requires: value },
    })} />
    <JsonEditor label="OUTPUTS" value={template.spec.outputs as unknown as CanvasJsonObject} onChange={value => onChange({
      ...template,
      spec: { ...template.spec, outputs: value as unknown as CanvasWorkflowTemplate['spec']['outputs'] },
    })} />
  </div>
}

function NodeInspector({ node, definition, onChange, onDelete }: {
  readonly node: CanvasWorkflowNode
  readonly definition: CanvasNodeDefinition | undefined
  readonly onChange: (node: CanvasWorkflowNode) => void
  readonly onDelete: () => void
}) {
  return <div className="wf-panel-body">
    <p className="wf-eyebrow">SELECTED SIGNAL</p>
    <h2>{node.id}</h2>
    <code className="wf-uses">{node.uses}</code>
    <label>TITLE<input value={node.title ?? ''} onChange={event => onChange({ ...node, title: event.target.value })} /></label>
    <SchemaObjectEditor schema={definition?.configSchema} value={node.with} onChange={value => onChange({ ...node, with: value })} />
    <JsonEditor label="CONFIG / RAW" value={node.with} onChange={value => onChange({ ...node, with: value })} />
    <JsonEditor label="INPUT BINDINGS" value={node.inputs as unknown as CanvasJsonObject} onChange={value => onChange({
      ...node,
      inputs: value as unknown as CanvasWorkflowNode['inputs'],
    })} />
    <JsonEditor label="EXPECTED OUTPUT" value={(node.expects ?? {}) as unknown as CanvasJsonObject} onChange={value => {
      const { expects: _expects, ...withoutExpectation } = node
      onChange(Object.keys(value).length === 0
        ? withoutExpectation
        : { ...withoutExpectation, expects: value as unknown as NonNullable<CanvasWorkflowNode['expects']> })
    }} />
    <button className="wf-danger" onClick={onDelete}>REMOVE NODE</button>
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
  return <fieldset className="wf-schema-form"><legend>SCHEMA FIELDS</legend>{Object.entries(properties).map(([name, candidate]) => {
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
  return <label data-invalid={invalid}>{label}<textarea value={text} onChange={event => setText(event.target.value)} onBlur={() => {
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
  return <label data-invalid={invalid}>REQUIRES / ALLOWLIST<textarea value={text} onChange={event => setText(event.target.value)} onBlur={() => {
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

function Diagnostics({ diagnostics, onSelect }: { readonly diagnostics: readonly CanvasWorkflowDiagnostic[]; readonly onSelect: (id: string) => void }) {
  if (diagnostics.length === 0) return <div className="wf-panel-empty"><b>NO DIAGNOSTICS</b><span>Run CHECK to compile the current graph.</span></div>
  return <div className="wf-diagnostics">{diagnostics.map((item, index) => <button key={`${item.code}-${index}`} data-severity={item.severity} onClick={() => { if (item.nodeId !== undefined) onSelect(item.nodeId) }}>
    <span>{item.severity === 'error' ? '×' : '!'}</span><div><b>{item.code}</b><p>{item.message}</p><small>{item.nodeId ?? 'workflow'}</small></div>
  </button>)}</div>
}

function DiffView({ diff }: { readonly diff: CanvasTemplateDiff | undefined }) {
  if (diff === undefined) return <div className="wf-panel-empty"><b>NO DIFF</b><span>Save once, then compare the working graph.</span></div>
  return <div className="wf-diff">
    <div className="wf-diff-flags"><Flag on={diff.semanticChanged} text="SEMANTIC" /><Flag on={diff.layoutChanged} text="LAYOUT" /></div>
    <ChangeSet label="NODES" value={diff.nodes} />
    <ChangeSet label="EDGES" value={diff.edges} />
  </div>
}

function ChangeSet({ label, value }: { readonly label: string; readonly value: { readonly added: readonly string[]; readonly removed: readonly string[]; readonly changed: readonly string[] } }) {
  return <section><h3>{label}</h3>{(['added', 'changed', 'removed'] as const).map(kind => <div key={kind}><b>{kind}</b><span>{value[kind].join(', ') || '—'}</span></div>)}</section>
}

function Flag({ on, text }: { readonly on: boolean; readonly text: string }) { return <span data-on={on}>{on ? '●' : '○'} {text}</span> }
function SectionLabel({ index, text }: { readonly index: string; readonly text: string }) { return <h4 className="wf-section-label"><span>{index}</span>{text}</h4> }

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

function isObject(value: unknown): value is CanvasJsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const PRODUCT_CSS = String.raw`
/* Guarded Workflow Studio: light-first, host-aware product skin. */
.wf-studio{
  --wf-bg:#f6f7fb;--wf-surface:#ffffff;--wf-surface-soft:#f1f3f7;--wf-surface-hover:#eef3ff;
  --wf-border:#e2e6ed;--wf-border-strong:#cbd2dc;--wf-text:#171b24;--wf-muted:#667085;
  --wf-brand:#2563eb;--wf-brand-strong:#1d4ed8;--wf-brand-soft:#eaf1ff;--wf-success:#159455;
  --wf-warning:#b7791f;--wf-danger:#d64545;--wf-shadow:0 14px 42px rgba(27,39,66,.12);
  --ink:var(--wf-text);--muted:var(--wf-muted);--panel:var(--wf-surface);--line:var(--wf-border);
  --accent:var(--wf-brand);--green:var(--wf-success);color-scheme:light;background:var(--wf-bg);color:var(--wf-text);
  font-family:var(--dsw-font-family),"Avenir Next","PingFang SC",sans-serif;
  grid-template:64px minmax(0,1fr) 214px / 272px minmax(0,1fr) 348px;
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
