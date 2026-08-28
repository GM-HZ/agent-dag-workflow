import { WorkflowExecutionError } from './errors.js'
import type {
  WorkflowCapabilityDisposer,
  WorkflowCapabilityResolver,
  WorkflowCapabilitySource,
} from './types.js'

const CAPABILITY_PATTERN = /^[a-z][a-zA-Z0-9._:/-]*$/

/**
 * Host-owned service bindings for custom workflow nodes.
 *
 * Business integrations should normally be Host Tools. This registry exists for
 * custom nodes that need workflow-specific lifecycle services such as durable
 * progress, streaming, compensation, or another Host extension.
 */
export class WorkflowCapabilityRegistry implements WorkflowCapabilitySource {
  readonly #bindings = new Map<string, unknown>()

  register<T>(capability: string, service: T): WorkflowCapabilityDisposer {
    assertCapabilityName(capability)
    if (service === undefined) throw new TypeError(`workflow capability ${capability} cannot bind undefined`)
    if (this.#bindings.has(capability)) throw new Error(`workflow capability already registered: ${capability}`)
    this.#bindings.set(capability, service)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (this.#bindings.get(capability) === service) this.#bindings.delete(capability)
    }
  }

  resolve<T = unknown>(capability: string): T | undefined {
    return this.#bindings.get(capability) as T | undefined
  }

  list(): readonly string[] {
    return [...this.#bindings.keys()].sort()
  }
}

export function createScopedWorkflowCapabilityResolver(
  source: WorkflowCapabilitySource | undefined,
  declared: readonly string[],
  nodeId: string,
): WorkflowCapabilityResolver {
  const allowed = new Set(declared)
  return Object.freeze({
    declared: Object.freeze([...allowed]),
    has(capability: string): boolean {
      return allowed.has(capability) && source?.resolve(capability) !== undefined
    },
    optional<T = unknown>(capability: string): T | undefined {
      if (!allowed.has(capability)) return undefined
      return source?.resolve<T>(capability)
    },
    require<T = unknown>(capability: string): T {
      if (!allowed.has(capability)) {
        throw new WorkflowExecutionError(
          'WORKFLOW_CAPABILITY_UNDECLARED',
          `node ${nodeId} did not declare capability ${capability}`,
          { nodeId },
        )
      }
      const service = source?.resolve<T>(capability)
      if (service === undefined) {
        throw new WorkflowExecutionError(
          'WORKFLOW_CAPABILITY_UNAVAILABLE',
          `workflow capability is not installed: ${capability}`,
          { nodeId },
        )
      }
      return service
    },
  })
}

function assertCapabilityName(capability: string): void {
  if (!CAPABILITY_PATTERN.test(capability)) throw new TypeError(`invalid workflow capability: ${capability}`)
}
