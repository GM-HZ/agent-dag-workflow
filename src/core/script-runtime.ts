import { evaluateWorkflowExpression, validateWorkflowExpression } from './expression.js'
import type {
  WorkflowScriptExecutionRequest,
  WorkflowScriptRuntimeDefinition,
} from './types.js'

export type WorkflowScriptRuntimeDisposer = () => void

export class WorkflowScriptRuntimeRegistry {
  readonly #definitions = new Map<string, WorkflowScriptRuntimeDefinition>()

  register(definition: WorkflowScriptRuntimeDefinition): WorkflowScriptRuntimeDisposer {
    assertDefinition(definition)
    const key = scriptRuntimeKey(definition.language, definition.version)
    if (this.#definitions.has(key)) throw new Error(`workflow script runtime already registered: ${key}`)
    this.#definitions.set(key, definition)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (this.#definitions.get(key) === definition) this.#definitions.delete(key)
    }
  }

  resolve(uses: string): WorkflowScriptRuntimeDefinition | undefined {
    return this.#definitions.get(uses)
  }

  list(): readonly WorkflowScriptRuntimeDefinition[] {
    return [...this.#definitions.values()].sort((left, right) => {
      return scriptRuntimeKey(left.language, left.version).localeCompare(scriptRuntimeKey(right.language, right.version))
    })
  }
}

export const jsonExpressionRuntime: WorkflowScriptRuntimeDefinition = {
  language: 'json.expr',
  version: 1,
  title: 'JSON Expression',
  description: 'Pure deterministic JSON expression language with bounded operations and no I/O or eval.',
  deterministic: true,
  validate: validateWorkflowExpression,
  async execute(request: WorkflowScriptExecutionRequest) {
    return evaluateWorkflowExpression(request.source, request.inputs, request)
  },
}

export function createDefaultWorkflowScriptRuntimeRegistry(): WorkflowScriptRuntimeRegistry {
  const registry = new WorkflowScriptRuntimeRegistry()
  registry.register(jsonExpressionRuntime)
  return registry
}

export function scriptRuntimeKey(language: string, version: number): string {
  return `${language}@${version}`
}

function assertDefinition(definition: WorkflowScriptRuntimeDefinition): void {
  if (!/^[a-z][a-z0-9.-]*$/u.test(definition.language)) throw new Error(`invalid workflow script language: ${definition.language}`)
  if (!Number.isSafeInteger(definition.version) || definition.version < 1) throw new Error(`invalid workflow script runtime version: ${definition.version}`)
  if (definition.deterministic !== true) throw new Error('workflow script runtimes must declare deterministic: true')
}
