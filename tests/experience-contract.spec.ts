import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { canvasText } from '../src/canvas/client/messages.js'
import { blankTemplate } from '../src/canvas/client/model.js'

const studio = readFileSync(new URL('../src/canvas/client/studio.tsx', import.meta.url), 'utf8')
const overlay = readFileSync(new URL('../src/canvas/client/overlay.tsx', import.meta.url), 'utf8')
const client = readFileSync(new URL('../src/canvas/client/index.ts', import.meta.url), 'utf8')
const model = readFileSync(new URL('../src/canvas/client/model.ts', import.meta.url), 'utf8')
const skill = readFileSync(new URL('../skills/workflow-builder/SKILL.md', import.meta.url), 'utf8')

describe('user experience contract', () => {
  it('uses one product name and localized workflow terminology in the shipped UI', () => {
    expect(studio).toContain('AGENT DAG WORKFLOW')
    expect(overlay).toContain("<b>{t('Workflow')}</b>")
    expect(canvasText('zh')('Workflow')).toBe('工作流')
    expect(canvasText('en')('Workflow')).toBe('Workflow')
    expect(client).toContain("label: 'Agent DAG Workflow'")
    expect(blankTemplate(1, 'zh').metadata.name).toBe('未命名工作流')
    expect(blankTemplate(1, 'en').metadata.name).toBe('Untitled workflow')
    for (const source of [studio, overlay, client, model]) {
      expect(source).not.toMatch(/GUARDED DAG STUDIO|Workflow Signal Studio|Untitled signal|>FLOW<|NO DIAGNOSTICS|RETRY UNKNOWN|>RESUME</)
    }
  })

  it('binds Canvas authority to the DSH 0.2 selected UI session', () => {
    expect(client).toContain('scope.uiSession.adapter.current')
    expect(client).not.toContain('scope.sessions.list')
    expect(overlay).toContain('snapshot.key')
    expect(overlay).not.toContain('snapshot.current')
  })

  it('keeps recovery, first success, progressive disclosure, and run diagnosis visible', () => {
    for (const phrase of ['Unsaved changes restored', 'Start with a runnable example', 'Advanced · schemas and dependencies', 'Show infrastructure events', 'Publish an immutable revision?'] as const) {
      expect(studio).toContain(phrase)
      expect(canvasText('zh')(phrase)).toMatch(/[\p{Script=Han}]/u)
    }
  })

  it('ships one structural skin without retaining the legacy dark Canvas stylesheet', () => {
    expect(studio).toContain('const STRUCTURE_CSS')
    expect(studio).not.toContain('const CANVAS_CSS')
    expect(studio).not.toContain('#0d0f0e')
    expect(studio).not.toContain('IBM Plex Mono')
  })

  it('instructs the Agent to hand off a compact reference to the same template', () => {
    expect(skill).toContain('report only the Workflow name/id, current draft revision')
    expect(skill).toContain('Never print complete templates, execution plans, event histories')
    expect(skill).toContain('Do not create a second DSL')
    expect(skill).toContain('Do not start or require MCP when the CLI is available')
  })
})
