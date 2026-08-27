import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  materializeWorkflowTemplate,
  parseWorkflowTemplate,
  registerCoreNodes,
  WorkflowNodeRegistry,
} from '@gm-hz/dsh-dag-workflow-core'
import { WorkflowTemplateCatalog } from '@gm-hz/dsh-dag-workflow-catalog'
import { SqliteWorkflowCatalogRepository } from '@gm-hz/dsh-dag-workflow-sqlite'

const examplesDirectory = fileURLToPath(new URL('./', import.meta.url))
const showcaseFiles = [
  'contract-clause-review-worker.workflow.yaml',
  'secure-release-guardian.workflow.yaml',
  'multi-source-due-diligence.workflow.yaml',
  'weekly-ai-model-news.workflow.json',
  'batch-contract-review.workflow.yaml',
]
const workerRevision = 2

const databasePath = resolve(argumentValue('--db') ?? `${homedir()}/.dsh/dsh-dag-workflow/workflows.db`)
const repository = new SqliteWorkflowCatalogRepository({ path: databasePath })
const nodes = new WorkflowNodeRegistry()
const disposeNodes = registerCoreNodes(nodes)
const catalog = new WorkflowTemplateCatalog(repository, nodes)

try {
  const results = []
  for (const filename of showcaseFiles) {
    const template = parseWorkflowTemplate(readFileSync(resolve(examplesDirectory, filename), 'utf8'))
    const diagnostics = catalog.validate(template)
    const errors = diagnostics.filter(item => item.severity === 'error')
    if (errors.length > 0) throw new Error(`${filename} is invalid:\n${JSON.stringify(errors, null, 2)}`)
    const materialized = materializeWorkflowTemplate(template)
    const current = repository.readDraft(template.metadata.id)
    const draft = current === undefined
      ? catalog.createDraft(template)
      : current.contentHash === materialized.contentHash
        ? current
        : catalog.updateDraft(current.id, current.revision, template)

    if (template.metadata.id === 'contract-clause-review-worker') {
      while (repository.readPublished(draft.id, workerRevision) === undefined) catalog.publish(draft.id, draft.revision)
      results.push(`${draft.id}: installed draft r${draft.revision}, published immutable revision ${workerRevision}`)
    } else {
      results.push(`${draft.id}: installed draft r${draft.revision}`)
    }
  }

  console.log(`Installed ${results.length} showcase workflows into ${databasePath}`)
  for (const result of results) console.log(`- ${result}`)
} finally {
  disposeNodes()
  repository.close()
}

function argumentValue(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}
