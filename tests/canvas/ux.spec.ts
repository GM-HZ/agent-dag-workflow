import { describe, expect, it } from 'vitest'
import type { CanvasTrace, CanvasWorkflowDraft } from '../../src/canvas/types.js'
import {
  classifyWorkflowError,
  definitionDisplayDescription,
  definitionDisplayTitle,
  diagnosticTitle,
  documentStateLabel,
  hasUnsavedChanges,
  parseRecoverySnapshot,
  serializeRecoverySnapshot,
  starterTemplate,
  visibleTraceEvents,
} from '../../src/canvas/client/ux.js'

describe('Canvas experience model', () => {
  it('provides a dependency-free starter that is ready for a first test run', () => {
    const template = starterTemplate(42)
    expect(template.metadata).toMatchObject({ id: 'hello-workflow-42', name: '第一个工作流' })
    expect(template.spec.nodes.map(node => node.uses)).toEqual(['core.start@1', 'core.end@1'])
    expect(template.spec.edges).toEqual([{ id: 'start-end', source: 'start', target: 'end' }])
    expect(template.spec.outputs).toEqual({ message: { output: { nodeId: 'end', path: ['message'] } } })
  })

  it('round-trips a complete recovery snapshot and rejects corrupt local state', () => {
    const template = starterTemplate(7)
    const draft: CanvasWorkflowDraft = {
      id: template.metadata.id, revision: 3, template,
      contentHash: 'content', semanticHash: 'semantic', createdAt: 1, updatedAt: 2,
    }
    const snapshot = { version: 1 as const, template, draft, inputsText: '{"message":"saved"}', savedAt: 10 }
    expect(parseRecoverySnapshot(serializeRecoverySnapshot(snapshot))).toEqual(snapshot)
    expect(parseRecoverySnapshot('{"version":1,"template":{}}')).toBeUndefined()
    expect(parseRecoverySnapshot('not json')).toBeUndefined()
  })

  it('keeps unsaved and validated-but-unsaved states explicit', () => {
    expect(hasUnsavedChanges('validated-dirty')).toBe(true)
    expect(hasUnsavedChanges('validated')).toBe(false)
    expect(hasUnsavedChanges('pristine')).toBe(false)
    expect(documentStateLabel('validated-dirty')).toBe('校验通过 · 未保存')
  })

  it.each([
    ['TypeError: Failed to fetch', 'connection', true],
    ['CATALOG_REVISION_CONFLICT: expected revision 2', 'conflict', false],
    ['workflow canvas access denied', 'permission', false],
    ['NODE_OUTPUT_EXPECTATION_FAILED: schema mismatch', 'validation', false],
    ["internal: / must have required property 'message'", 'validation', false],
    ['workflow run not found', 'not-found', false],
    ['DSH_TOOL_FAILED: upstream rejected', 'execution', false],
  ] as const)('classifies %s as an actionable %s error', (message, kind, retryable) => {
    expect(classifyWorkflowError(message)).toMatchObject({ kind, retryable })
  })

  it('projects human-readable trace events and hides persistence noise by default', () => {
    const trace: CanvasTrace = {
      runId: 'run-1', templateId: 'hello', semanticHash: 'hash', createdAt: 1, status: 'failed', checkpointSeq: 4,
      nodeStates: { start: 'succeeded', call: 'failed' }, edgeStates: { edge: 'taken' }, nodeOutputs: {}, nodeProgress: {},
      events: [
        { seq: 1, type: 'run.started', runId: 'run-1' },
        { seq: 2, type: 'edge.taken', runId: 'run-1', edgeId: 'edge' },
        { seq: 3, type: 'node.failed', runId: 'run-1', nodeId: 'call', error: 'DSH_TOOL_FAILED' },
        { seq: 4, type: 'checkpoint.committed', runId: 'run-1', checkpointSeq: 4 },
      ], error: 'DSH_TOOL_FAILED',
    }
    expect(visibleTraceEvents(trace).map(event => event.title)).toEqual(['开始运行', '节点执行失败'])
    expect(visibleTraceEvents(trace, true)).toHaveLength(4)
    expect(visibleTraceEvents(trace)[1]).toMatchObject({ nodeId: 'call', tone: 'danger', detail: 'DSH_TOOL_FAILED' })
  })

  it('maps stable compiler diagnostics to user-facing titles', () => {
    expect(diagnosticTitle({ code: 'WORKFLOW_REQUIREMENT_UNDECLARED', severity: 'error', message: 'missing' })).toBe('依赖尚未声明')
  })

  it('localizes built-in nodes without renaming external DSH Tools', () => {
    const start = {
      catalogId: 'core.start@1', kind: 'node' as const, uses: 'core.start@1', title: 'Start', description: 'English', role: 'start' as const,
      configSchema: {}, inputSchema: {}, outputSchema: {}, outputPorts: ['success'], requiredOutputPorts: [], capabilities: [], dependencyKinds: [], defaultRequirements: [], retry: 'safe' as const,
    }
    const tool = { ...start, catalogId: 'tool:web_search', kind: 'tool' as const, uses: 'tool.call@1', title: 'web_search', description: 'Search the web.', role: 'regular' as const }
    expect(definitionDisplayTitle(start)).toBe('开始')
    expect(definitionDisplayDescription(start)).toContain('工作流输入')
    expect(definitionDisplayTitle(tool)).toBe('web_search')
  })
})
