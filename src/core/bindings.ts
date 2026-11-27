import { WorkflowExecutionError } from './errors.js'
import { isJsonObject, snapshotJsonValue } from './json.js'
import type { JsonObject, JsonValue, WorkflowBinding } from './types.js'

export function resolveWorkflowBindings(
  bindings: Readonly<Record<string, WorkflowBinding>>,
  workflowInputs: JsonObject,
  nodeOutput: (nodeId: string) => JsonObject | undefined,
  nodeId?: string,
): JsonObject {
  return Object.fromEntries(Object.entries(bindings).map(([name, binding]) => {
    if ('literal' in binding) return [name, snapshotJsonValue(binding.literal)]
    if ('input' in binding) return [name, readWorkflowPath(workflowInputs, binding.input.path, 'workflow input')]
    const source = nodeOutput(binding.output.nodeId)
    if (source === undefined) throw new WorkflowExecutionError(
      'BINDING_SOURCE_UNAVAILABLE', `output is unavailable from node ${binding.output.nodeId}`, nodeId === undefined ? undefined : { nodeId },
    )
    return [name, readWorkflowPath(source, binding.output.path, binding.output.nodeId)]
  }))
}

function readWorkflowPath(root: JsonValue, path: readonly (string | number)[], source: string): JsonValue {
  let value: JsonValue | undefined = root
  for (const part of path) {
    value = typeof part === 'number'
      ? Array.isArray(value) && Object.hasOwn(value, part) ? value[part] as JsonValue : undefined
      : isJsonObject(value) && Object.hasOwn(value, part) ? value[part] : undefined
    if (value === undefined) throw new WorkflowExecutionError('BINDING_PATH_INVALID', `path does not exist on node ${source}`)
  }
  return snapshotJsonValue(value)
}
