import { describe, expect, it } from 'vitest'
import { renderWorkflowToolOutput } from '../../src/adapters/dsh/authoring.js'

describe('workflow authoring handoff output', () => {
  it('summarizes draft mutations without echoing the complete template into chat', () => {
    const rendered = renderWorkflowToolOutput('workflow_draft_create', {
      id: 'weekly-ai-model-news', revision: 4, contentHash: 'content', semanticHash: 'semantic', createdAt: 1, updatedAt: 2,
      template: {
        apiVersion: 'workflow.gm-hz.dev/v1', kind: 'WorkflowTemplate',
        metadata: { id: 'weekly-ai-model-news', name: 'AI 模型周报' },
        spec: { nodes: [{ id: 'large-node-that-must-not-be-rendered' }], edges: [] },
      },
    })
    expect(rendered).toContain('工作流草稿已保存：AI 模型周报')
    expect(rendered).toContain('草稿修订：4')
    expect(rendered).toContain('打开“工作流”')
    expect(rendered).not.toContain('large-node-that-must-not-be-rendered')
  })

  it('keeps actionable diagnostics and run identifiers in compact results', () => {
    expect(renderWorkflowToolOutput('workflow_validate', { diagnostics: [] })).toContain('0 个错误，0 个警告')
    expect(renderWorkflowToolOutput('workflow_run', {
      runId: 'run-audit-1', status: 'failed', error: 'DSH_TOOL_FAILED', needsAttention: ['search'],
    })).toContain('运行 ID：run-audit-1')
  })
})
