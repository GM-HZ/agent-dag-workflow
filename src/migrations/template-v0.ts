import { snapshotJsonObject, type JsonObject, type JsonValue, type WorkflowTemplate } from '../core/index.js'

const NODE_USES: Readonly<Record<string, string>> = {
  'dsh.tool@1': 'tool.call@1',
  'dsh.agent@1': 'agent.run@1',
  'dsh.human-approval@1': 'human.approval@1',
  'core.subworkflow@1': 'workflow.call@1',
}

/** Explicit offline 0.2 -> 1.0 conversion. It is never called by the runtime parser. */
export function migrateLegacyWorkflowTemplate(candidate: JsonObject): WorkflowTemplate {
  const copy = structuredClone(candidate) as JsonObject
  copy.apiVersion = 'workflow.gm-hz.dev/v1alpha1'
  const spec = object(copy.spec, 'spec')
  const nodes = array(spec.nodes, 'spec.nodes')
  for (const item of nodes) {
    const node = object(item, 'node')
    if (typeof node.uses === 'string') node.uses = NODE_USES[node.uses] ?? node.uses.replace('dsh.expr@1', 'json.expr@1')
    const config = object(node.with ?? {}, 'node.with')
    if (node.uses === 'tool.call@1' && typeof config.name === 'string' && config.uses === undefined) { config.uses = config.name; delete config.name }
    delete config.label
    node.with = config
    node.inputs = migrateBindings(object(node.inputs ?? {}, 'node.inputs'))
  }
  spec.outputs = migrateBindings(object(spec.outputs ?? {}, 'spec.outputs'))
  const requirements = array(spec.requires ?? [], 'spec.requires')
  const mapped = requirements.map(item => {
    const requirement = object(item, 'requirement')
    if (requirement.uses === 'dsh.tools.execute') requirement.uses = 'gateway.tool.execute'
    if (requirement.uses === 'dsh.subagents.start') requirement.uses = 'gateway.agent.execute'
    if (requirement.uses === 'dsh.approval.request') requirement.uses = 'gateway.approval.request'
    if (requirement.uses === 'workflowTemplates.getPublished' || requirement.uses === 'dagWorkflowEngine.invoke') requirement.uses = 'gateway.workflow.call'
    if (requirement.uses === 'dsh.expr@1') requirement.uses = 'json.expr@1'
    return requirement
  })
  spec.requires = [...new Map(mapped.map(item => [`${String(item.kind)}:${String(item.uses)}`, item])).values()]
  copy.spec = spec
  return snapshotJsonObject(copy) as unknown as WorkflowTemplate
}

function migrateBindings(bindings: JsonObject): JsonObject {
  const result: JsonObject = {}
  for (const [name, value] of Object.entries(bindings)) {
    const binding = object(value, `binding ${name}`)
    if (typeof binding.input === 'string') result[name] = { input: { path: [binding.input] } }
    else if (isObject(binding.output)) {
      const output = binding.output as JsonObject
      result[name] = { output: { nodeId: output.nodeId ?? output.node as JsonValue, path: output.path ?? [] } }
    } else if ('secret' in binding) throw new Error(`legacy secret binding ${name} must be replaced with a static credentialRef before migration`)
    else result[name] = binding
  }
  return result
}
function object(value: JsonValue | undefined, label: string): JsonObject { if (!isObject(value)) throw new Error(`${label} must be an object`); return value }
function array(value: JsonValue | undefined, label: string): JsonValue[] { if (!Array.isArray(value)) throw new Error(`${label} must be an array`); return value as JsonValue[] }
function isObject(value: unknown): value is JsonObject { return value !== null && typeof value === 'object' && !Array.isArray(value) }
