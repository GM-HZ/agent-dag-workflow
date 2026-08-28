import { createHash } from 'node:crypto'
import { stableJsonStringify } from './json.js'
import type { JsonObject, WorkflowNodeDefinition } from './types.js'

export type WorkflowNodeDisposer = () => void

export class WorkflowNodeRegistry {
  readonly #definitions = new Map<string, WorkflowNodeDefinition>()

  register(definition: WorkflowNodeDefinition): WorkflowNodeDisposer {
    assertDefinition(definition)
    const key = nodeDefinitionKey(definition.type, definition.version)
    if (this.#definitions.has(key)) {
      throw new Error(`workflow node already registered: ${key}`)
    }
    this.#definitions.set(key, definition)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (this.#definitions.get(key) === definition) this.#definitions.delete(key)
    }
  }

  resolve(uses: string): WorkflowNodeDefinition | undefined {
    return this.#definitions.get(uses)
  }

  list(): readonly WorkflowNodeDefinition[] {
    return [...this.#definitions.values()].sort((left, right) => {
      return nodeDefinitionKey(left.type, left.version).localeCompare(nodeDefinitionKey(right.type, right.version))
    })
  }

  definitionSet(uses?: readonly string[]): { readonly hash: string; readonly replayable: boolean } {
    const selected = uses === undefined
      ? this.list()
      : [...new Set(uses)].sort().map(item => this.#definitions.get(item)).filter((item): item is WorkflowNodeDefinition => item !== undefined)
    const replayable = selected.every(item => typeof item.implementationDigest === 'string' && item.implementationDigest.length > 0)
    const manifest = selected.map(item => ({
      uses: nodeDefinitionKey(item.type, item.version),
      schemaHash: digest(stableJsonStringify({
        config: item.configSchema,
        input: item.inputSchema,
        output: item.outputSchema,
        ports: item.outputPorts,
        capabilities: item.capabilities,
      } as unknown as JsonObject)),
      implementationDigest: item.implementationDigest ?? 'missing',
    }))
    return Object.freeze({ hash: digest(stableJsonStringify(manifest as unknown as import('./types.js').JsonValue)), replayable })
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function nodeDefinitionKey(type: string, version: number): string {
  return `${type}@${version}`
}

function assertDefinition(definition: WorkflowNodeDefinition): void {
  if (!/^[a-z][a-z0-9.-]*$/.test(definition.type)) {
    throw new Error(`invalid workflow node type: ${definition.type}`)
  }
  if (!Number.isSafeInteger(definition.version) || definition.version < 1) {
    throw new Error(`invalid workflow node version: ${definition.version}`)
  }
  if (definition.outputPorts.length === 0 || new Set(definition.outputPorts).size !== definition.outputPorts.length) {
    throw new Error(`workflow node ${nodeDefinitionKey(definition.type, definition.version)} must declare unique output ports`)
  }
  for (const port of definition.requiredOutputPorts ?? []) {
    if (!definition.outputPorts.includes(port)) {
      throw new Error(`required output port ${port} is not declared by ${nodeDefinitionKey(definition.type, definition.version)}`)
    }
  }
}
