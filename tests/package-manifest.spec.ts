import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

interface PackageManifest {
  name?: string
  repository?: { url?: string; directory?: string }
  dependencies?: Record<string, string>
  dsh?: { bundle?: { patch?: string } }
}

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as PackageManifest

describe('published root package manifest', () => {
  it('is the canonical installable dsh-dag-workflow package', () => {
    expect(manifest.name).toBe('@gm-hz/dsh-dag-workflow')
    expect(manifest.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/GM-HZ/dsh-dag-workflow.git',
    })
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
  })

  it('does not publish workspace-only runtime dependency ranges', () => {
    expect(Object.values(manifest.dependencies ?? {})).not.toContainEqual(expect.stringMatching(/^workspace:/))
  })
})
