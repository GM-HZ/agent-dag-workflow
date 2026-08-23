import { createHash } from 'node:crypto'
import { snapshotJsonValue, stableJsonStringify } from './json.js'
import type { JsonObject, WorkflowTemplate } from './types.js'

export interface MaterializedWorkflowTemplate {
  readonly template: WorkflowTemplate
  readonly contentHash: string
  readonly semanticHash: string
}

export function materializeWorkflowTemplate(candidate: WorkflowTemplate): MaterializedWorkflowTemplate {
  const template = snapshotJsonValue(candidate) as unknown as WorkflowTemplate
  const semanticDocument: JsonObject = {
    apiVersion: template.apiVersion,
    kind: template.kind,
    metadata: template.metadata as unknown as JsonObject,
    spec: template.spec as unknown as JsonObject,
  }
  return Object.freeze({
    template,
    contentHash: sha256(stableJsonStringify(template as unknown as JsonObject)),
    semanticHash: sha256(stableJsonStringify(semanticDocument)),
  })
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
