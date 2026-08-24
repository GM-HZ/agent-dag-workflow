import { createRoot } from 'react-dom/client'
import { WorkflowStudio } from '../../src/client/studio.js'
import type { WorkflowCanvasClientApi } from '../../src/client/api.js'
import type { CanvasNodeDefinition, CanvasWorkflowTemplate } from '../../src/types.js'

const definitions: CanvasNodeDefinition[] = [
  node('core.start@1', 'Start', 'start', ['success']),
  node('dsh.agent@1', 'Agent delegate', 'regular', ['success']),
  node('core.condition@1', 'Quality gate', 'regular', ['true', 'false']),
  node('dsh.human-approval@1', 'Human approval', 'regular', ['approved', 'rejected']),
  node('core.end@1', 'End', 'end', []),
]

const template: CanvasWorkflowTemplate = {
  apiVersion: 'dsh.workflow/v1alpha1', kind: 'WorkflowTemplate',
  metadata: { id: 'research-signal', name: 'Research quality signal', description: 'Visual fixture' },
  spec: {
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, outputs: {},
    nodes: [
      { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
      { id: 'research', uses: 'dsh.agent@1', title: 'Collect evidence', with: { provider: 'spawn' }, inputs: {} },
      { id: 'quality', uses: 'core.condition@1', title: 'Evidence ≥ 3?', with: { op: 'gte' }, inputs: {} },
      { id: 'approve', uses: 'dsh.human-approval@1', title: 'Editorial sign-off', with: { action: 'publish' }, inputs: {} },
      { id: 'end', uses: 'core.end@1', with: {}, inputs: {} },
    ],
    edges: [
      { id: 's-r', source: 'start', target: 'research' },
      { id: 'r-q', source: 'research', target: 'quality' },
      { id: 'q-a', source: 'quality', target: 'approve', sourcePort: 'true' },
      { id: 'q-e', source: 'quality', target: 'end', sourcePort: 'false' },
      { id: 'a-e', source: 'approve', target: 'end', sourcePort: 'approved' },
    ],
  },
  layout: { canvas: { positions: {
    start: { x: 40, y: 220 }, research: { x: 330, y: 100 }, quality: { x: 630, y: 210 }, approve: { x: 930, y: 80 }, end: { x: 930, y: 350 },
  } } },
}

const ok = <T,>(value: T) => Promise.resolve({ ok: true as const, value })
const api = {
  remote: {
    nodes: () => ok(definitions), templates: () => ok([]),
  },
  unwrap: <T,>(_operation: string, result: { readonly ok: true; readonly value: T }) => result.value,
} as unknown as WorkflowCanvasClientApi

createRoot(document.getElementById('root')!).render(<WorkflowStudio api={api} sessionId="visual-session" initialTemplate={template} />)

function node(uses: string, title: string, role: CanvasNodeDefinition['role'], outputPorts: string[]): CanvasNodeDefinition {
  return { catalogId: uses, kind: 'node', uses, title, role, outputPorts, description: title, configSchema: {}, inputSchema: {}, outputSchema: {}, requiredOutputPorts: [], capabilities: [], dependencyKinds: [], defaultRequirements: [], retry: 'safe' }
}
