import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('DSH Canvas client artifact', () => {
  it('exports package.json so the DSH client scanner can discover dsh.client', () => {
    const require = createRequire(import.meta.url)
    expect(require.resolve('@gm-hz/dsh-dag-workflow-canvas/package.json')).toMatch(/packages\/canvas\/package\.json$/)
  })

  it('ships as one DSH module-loader bundle instead of raw ESM', async () => {
    const artifact = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

    expect(artifact).toContain('window.__ModuleLoader__.load({')
    expect(artifact).toContain('id: "@gm-hz/dsh-dag-workflow-canvas"')
    expect(artifact).toContain('return module.exports;')
    expect(artifact).not.toMatch(/^\s*import\s/m)
    expect(artifact).not.toMatch(/^\s*export\s/m)
  })
})
