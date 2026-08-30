import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  compileWorkflow,
  parseWorkflowTemplate,
  registerCoreNodes,
  WorkflowNodeRegistry,
} from '../src/core/index.js'

const examplesDirectory = fileURLToPath(new URL('../examples/', import.meta.url))
const workflowFiles = readdirSync(examplesDirectory)
  .filter(name => /\.workflow\.(?:json|ya?ml)$/u.test(name))
  .sort()
const manifest = JSON.parse(readFileSync(`${examplesDirectory}/manifest.json`, 'utf8')) as {
  readonly schemaVersion: number
  readonly host: string
  readonly examples: readonly {
    readonly id: string
    readonly workflow: string
    readonly input: string
    readonly expected: string
    readonly revision: number
  }[]
}

describe('checked-in workflow examples', () => {
  it('keeps a meaningful showcase catalog', () => {
    expect(workflowFiles).toEqual(expect.arrayContaining([
      'weekly-ai-model-news.workflow.json',
      'secure-release-guardian.workflow.yaml',
      'contract-clause-review-worker.workflow.yaml',
      'batch-contract-review.workflow.yaml',
      'multi-source-due-diligence.workflow.yaml',
    ]))
    expect(workflowFiles.length).toBeGreaterThanOrEqual(8)
  })

  it('binds every template to one executable manifest case', () => {
    expect(manifest.schemaVersion).toBe(1)
    expect(readFileSync(`${examplesDirectory}/${manifest.host}`, 'utf8')).toContain('deterministic-offline')
    expect(manifest.examples.map(example => example.workflow).sort()).toEqual(workflowFiles)
    expect(new Set(manifest.examples.map(example => example.id)).size).toBe(manifest.examples.length)
    for (const example of manifest.examples) {
      const template = parseWorkflowTemplate(readFileSync(`${examplesDirectory}/${example.workflow}`, 'utf8'))
      expect(template.metadata.id).toBe(example.id)
      expect(example.revision).toBeGreaterThan(0)
      expect(() => JSON.parse(readFileSync(`${examplesDirectory}/${example.input}`, 'utf8'))).not.toThrow()
      expect(() => JSON.parse(readFileSync(`${examplesDirectory}/${example.expected}`, 'utf8'))).not.toThrow()
    }
  })

  for (const name of workflowFiles) {
    it(`parses and compiles ${name}`, () => {
      const nodes = new WorkflowNodeRegistry()
      const dispose = registerCoreNodes(nodes)
      try {
        const template = parseWorkflowTemplate(readFileSync(`${examplesDirectory}/${name}`, 'utf8'))
        const result = compileWorkflow(template, nodes)
        expect(result.diagnostics, JSON.stringify(result.diagnostics, null, 2)).toEqual([])
        expect(result.workflow?.template.metadata.id).toBe(template.metadata.id)
      } finally {
        dispose()
      }
    })
  }
})
