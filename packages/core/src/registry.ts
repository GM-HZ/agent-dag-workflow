import type { WorkflowNodeDefinition } from './types.js'

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
