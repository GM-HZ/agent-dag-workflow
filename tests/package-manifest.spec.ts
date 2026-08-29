import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

interface PackageManifest {
  version?: string
  name?: string
  repository?: { url?: string; directory?: string }
  dependencies?: Record<string, string>
  exports?: Record<string, unknown>
  files?: string[]
  dsh?: { bundle?: { patch?: string }; client?: { immediately?: boolean; platform?: string } }
}

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as PackageManifest

describe('published root package manifest', () => {
  it('is the canonical host-neutral single package', () => {
    expect(manifest.name).toBe('@gm-hz/agent-dag-workflow')
    expect(manifest.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/GM-HZ/agent-dag-workflow.git',
    })
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dsh?.client).toMatchObject({ platform: 'web', immediately: true })
    const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    expect(patch).toContain("name: '@gm-hz/agent-dag-workflow'")
    expect(patch).not.toContain('@gm-hz/agent-dag-workflow/dsh')
    expect(Object.keys(manifest.exports ?? {})).toEqual(expect.arrayContaining([
      '.', './core', './catalog', './sqlite', './dsh', './canvas', './client', './package.json',
    ]))
    expect(manifest.files).toEqual(expect.arrayContaining(['docs', 'examples', 'spec', 'skills', 'integrations/codex/agent-dag-workflow']))
    expect(Object.keys(manifest.exports ?? {})).toContain('./access')
    expect(manifest.dependencies?.['@modelcontextprotocol/sdk']).toBe('1.30.0')
    const plugin = JSON.parse(readFileSync(new URL('../integrations/codex/agent-dag-workflow/.codex-plugin/plugin.json', import.meta.url), 'utf8')) as { version?: string; name?: string }
    expect(plugin).toMatchObject({ name: 'agent-dag-workflow', version: manifest.version })
    expect(readFileSync(new URL('../integrations/codex/agent-dag-workflow/skills/workflow-builder/SKILL.md', import.meta.url), 'utf8')).toBe(
      readFileSync(new URL('../skills/workflow-builder/SKILL.md', import.meta.url), 'utf8'),
    )
  })

  it('does not publish workspace-only runtime dependency ranges', () => {
    expect(Object.values(manifest.dependencies ?? {})).not.toContainEqual(expect.stringMatching(/^workspace:/))
    expect(Object.keys(manifest.dependencies ?? {})).not.toContainEqual(expect.stringMatching(/^@gm-hz\/dsh-dag-workflow/))
  })
})
