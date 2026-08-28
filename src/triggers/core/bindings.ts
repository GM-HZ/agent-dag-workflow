import { snapshotJsonValue } from '../../core/index.js'
import type { WorkflowTriggerBinding } from './types.js'

export class InMemoryWorkflowBindingCatalog {
  readonly #bindings = new Map<string, WorkflowTriggerBinding[]>()

  async publish(candidate: Omit<WorkflowTriggerBinding, 'metadata'> & { readonly metadata: { readonly id: string; readonly revision?: number } }): Promise<WorkflowTriggerBinding> {
    const revisions = this.#bindings.get(candidate.metadata.id) ?? []
    const revision = revisions.length + 1
    if (candidate.metadata.revision !== undefined && candidate.metadata.revision !== revision) throw new Error(`workflow binding revision must be ${revision}`)
    const binding = snapshotJsonValue({ ...candidate, metadata: { id: candidate.metadata.id, revision } }) as unknown as WorkflowTriggerBinding
    revisions.push(binding)
    this.#bindings.set(binding.metadata.id, revisions)
    return binding
  }

  async get(id: string, revision?: number): Promise<WorkflowTriggerBinding> {
    const revisions = this.#bindings.get(id)
    const binding = revision === undefined ? revisions?.at(-1) : revisions?.[revision - 1]
    if (binding === undefined) throw new Error(`workflow binding not found: ${id}@${revision ?? 'latest'}`)
    return binding
  }

  async list(): Promise<readonly WorkflowTriggerBinding[]> { return [...this.#bindings.values()].flat() }
}
