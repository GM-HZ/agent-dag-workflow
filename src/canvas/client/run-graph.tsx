import { Background, Controls, ReactFlow } from '@xyflow/react'
import { useMemo } from 'react'
import type { CanvasRunDetails, CanvasTrace } from '../types.js'
import { useCanvasCopy } from './locale.js'
import { templateToFlow } from './model.js'

interface FrozenRunGraphProps {
  readonly details: CanvasRunDetails
  readonly trace: CanvasTrace
  readonly selectedNode: string | undefined
  readonly onSelect: (id: string | undefined) => void
  readonly onOpenRelated: (id: string) => void
}

export function FrozenRunGraph({ details, trace, selectedNode, onSelect, onOpenRelated }: FrozenRunGraphProps) {
  const { t } = useCanvasCopy()
  const layout = useMemo(() => templateToFlow(details.template, [], trace), [details.template, trace])
  const nodes = layout.nodes.map(node => ({
    id: node.id, position: node.position, selected: selectedNode === node.id,
    data: { label: <><strong>{node.data.template.title ?? node.id}</strong><small>{node.data.status ?? t('Pending')}</small></> },
    className: 'wf-frozen-node', ...(node.data.status === 'failed' ? { style: { borderColor: 'var(--wf-danger)' } } : {}),
  }))
  const edges = layout.edges.map(({ sourceHandle, ...edge }) => ({
    ...edge, label: sourceHandle,
    ...(trace.edgeStates[edge.id] === 'taken' ? { style: { stroke: 'var(--wf-brand)', strokeWidth: 2 } } : {}),
  }))
  const node = details.template.spec.nodes.find(item => item.id === selectedNode)
  const refs = node === undefined ? undefined : details.nodeInputs?.[node.id]
  const related = details.relatedRuns?.filter(item => item.nodeId === node?.id) ?? []
  return <section className="wf-frozen-run" aria-label={t('Executed graph')}>
    <h3>{t('Executed graph')}</h3>
    <div className="wf-frozen-graph">
      <ReactFlow nodes={nodes} edges={edges} fitView minZoom={0.2} maxZoom={2} nodesDraggable={false} nodesConnectable={false}
        elementsSelectable onNodeClick={(_, value) => onSelect(value.id)} onPaneClick={() => onSelect(undefined)}>
        <Background gap={18} size={1} /><Controls showInteractive={false} />
      </ReactFlow>
    </div>
    {node === undefined ? null : <div className="wf-frozen-node-details">
      <h4>{node.title ?? node.id} · <code>{node.uses}</code></h4>
      {refs === undefined ? <details><summary>{t('Input bindings')}</summary><pre>{JSON.stringify(node.inputs, null, 2)}</pre></details>
        : <details open><summary>{t('Resolved bindings')}</summary><pre>{JSON.stringify(refs, null, 2)}</pre></details>}
      {trace.nodeOutputs[node.id] === undefined ? null : <details open><summary>{t('Node output')}</summary><pre>{JSON.stringify(trace.nodeOutputs[node.id], null, 2)}</pre></details>}
      {trace.nodeProgress[node.id] === undefined ? null : <details><summary>{t('View saved progress')}</summary><pre>{JSON.stringify(trace.nodeProgress[node.id], null, 2)}</pre></details>}
      {related.map(item => <p key={`${item.kind}:${item.runId}`}>{item.kind === 'agent' ? <>{t('Host agent run')} <code>{item.runId}</code></>
        : <button onClick={() => onOpenRelated(item.runId)}>{t('Open child workflow run')} <code>{item.runId}</code></button>}</p>)}
    </div>}
  </section>
}
