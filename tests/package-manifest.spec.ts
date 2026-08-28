import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

interface PackageManifest {
  name?: string
  repository?: { url?: string; directory?: string }
  dependencies?: Record<string, string>
  exports?: Record<string, unknown>
  dsh?: { bundle?: { patch?: string } }
}

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as PackageManifest

describe('published root package manifest', () => {
  it('is the canonical host-neutral single package', () => {
    expect(manifest.name).toBe('@gm-hz/agent-dag-workflow')
    expect(manifest.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/GM-HZ/dsh-dag-workflow.git',
    })
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(Object.keys(manifest.exports ?? {})).toEqual(expect.arrayContaining([
      '.', './core', './catalog', './sqlite', './dsh', './canvas', './client', './package.json',
    ]))
  })

  it('does not publish workspace-only runtime dependency ranges', () => {
    expect(Object.values(manifest.dependencies ?? {})).not.toContainEqual(expect.stringMatching(/^workspace:/))
    expect(Object.keys(manifest.dependencies ?? {})).not.toContainEqual(expect.stringMatching(/^@gm-hz\/dsh-dag-workflow/))
  })
})
