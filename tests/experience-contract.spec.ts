import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const studio = readFileSync(new URL('../src/canvas/client/studio.tsx', import.meta.url), 'utf8')
const overlay = readFileSync(new URL('../src/canvas/client/overlay.tsx', import.meta.url), 'utf8')
const client = readFileSync(new URL('../src/canvas/client/index.ts', import.meta.url), 'utf8')
const model = readFileSync(new URL('../src/canvas/client/model.ts', import.meta.url), 'utf8')
const skill = readFileSync(new URL('../skills/workflow-builder/SKILL.md', import.meta.url), 'utf8')

describe('user experience contract', () => {
  it('uses one product name and Chinese workflow terminology in the shipped UI', () => {
    expect(studio).toContain('DSH DAG Workflow')
    expect(overlay).toContain('<b>工作流</b>')
    expect(client).toContain("label: 'DSH DAG Workflow'")
    expect(model).toContain("name: '未命名工作流'")
    for (const source of [studio, overlay, client, model]) {
      expect(source).not.toMatch(/GUARDED DAG STUDIO|Workflow Signal Studio|Untitled signal|>FLOW<|NO DIAGNOSTICS|RETRY UNKNOWN|>RESUME</)
    }
  })

  it('keeps recovery, first success, progressive disclosure, and run diagnosis visible', () => {
    for (const phrase of ['已恢复未保存内容', '从可运行示例开始', '高级配置 · Schema 与依赖', '显示底层事件', '发布不可变修订？']) {
      expect(studio).toContain(phrase)
    }
  })

  it('instructs the Agent to hand off a compact reference to the same template', () => {
    expect(skill).toContain('report the workflow name, draft id, current draft revision, validation counts')
    expect(skill).toContain('Do not paste the complete WorkflowTemplate into chat')
    expect(skill).toContain('Do not create a second DSL')
  })
})
