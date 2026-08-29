import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('DSH Canvas client artifact', () => {
  it('exports package.json so the DSH client scanner can discover dsh.client', () => {
    const require = createRequire(import.meta.url)
    expect(require.resolve('@gm-hz/agent-dag-workflow/package.json')).toMatch(/package\.json$/)
  })

  it('ships as one DSH module-loader bundle instead of raw ESM', async () => {
    const artifact = await readFile(new URL('../../lib/canvas/client.js', import.meta.url), 'utf8')

    expect(artifact).toContain('window.__ModuleLoader__.load({')
    expect(artifact).toContain('id: "@gm-hz/agent-dag-workflow"')
    expect(artifact).toContain('return module.exports;')
    expect(artifact).not.toMatch(/^\s*import\s/m)
    expect(artifact).not.toMatch(/^\s*export\s/m)
  })

  it('ships the recoverable light-first studio and follows the DSH theme signal', async () => {
    const artifact = await readFile(new URL('../../lib/canvas/client.js', import.meta.url), 'utf8')

    expect(artifact).toContain('AGENT DAG WORKFLOW')
    expect(artifact).toContain('Agent DAG Workflow')
    expect(artifact).not.toContain('DSH DAG Workflow')
    expect(artifact).toContain('已恢复未保存内容')
    expect(artifact).toContain('搜索工作流节点')
    expect(artifact).toContain('显示底层事件')
    expect(artifact).toContain('color-scheme: dark')
    expect(artifact).toContain('color-scheme: light')
    expect(artifact).toContain('prefers-color-scheme:dark')
  })
})
