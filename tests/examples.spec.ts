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
