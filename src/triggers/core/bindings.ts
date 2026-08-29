import {
  compileJsonValidator,
  snapshotJsonValue,
  type JsonObject,
  type JsonSchema,
  type JsonValue,
} from '../../core/index.js'
import type {
  WorkflowBindingRepository,
  WorkflowBindingTargetCatalog,
  WorkflowTriggerBinding,
  WorkflowTriggerBindingCandidate,
  WorkflowTriggerDefinition,
} from './types.js'

export type WorkflowBindingErrorCode =
  | 'BINDING_INVALID'
  | 'BINDING_NOT_FOUND'
  | 'BINDING_REVISION_CONFLICT'
  | 'BINDING_TARGET_NOT_FOUND'
  | 'BINDING_TRIGGER_UNKNOWN'

export class WorkflowBindingError extends Error {
  constructor(readonly code: WorkflowBindingErrorCode, message: string, readonly diagnostics: readonly string[] = []) {
    super(message)
    this.name = 'WorkflowBindingError'
  }
}

/** Static Trigger protocol registry. It validates configuration but never executes a Trigger or resolves credentials. */
export class WorkflowTriggerDefinitionRegistry {
  readonly #definitions = new Map<string, { readonly definition: WorkflowTriggerDefinition; readonly validate: (value: unknown) => readonly string[] }>()

  register(definition: WorkflowTriggerDefinition): () => void {
    assertUses(definition.uses)
    if (this.#definitions.has(definition.uses)) throw new WorkflowBindingError('BINDING_INVALID', `workflow trigger definition already exists: ${definition.uses}`)
    const entry = {
      definition: snapshotJsonValue(definition as unknown as JsonValue) as unknown as WorkflowTriggerDefinition,
      validate: compileJsonValidator(definition.configSchema, `${definition.uses} trigger config`),
    }
    this.#definitions.set(definition.uses, entry)
    return () => { if (this.#definitions.get(definition.uses) === entry) this.#definitions.delete(definition.uses) }
  }

  validate(uses: string, config: JsonObject): readonly string[] {
    const definition = this.#definitions.get(uses)
    if (definition === undefined) throw new WorkflowBindingError('BINDING_TRIGGER_UNKNOWN', `workflow trigger is not registered: ${uses}`)
    return definition.validate(config)
  }

  list(): readonly WorkflowTriggerDefinition[] {
    return [...this.#definitions.values()]
      .map(entry => snapshotJsonValue(entry.definition as unknown as JsonValue) as unknown as WorkflowTriggerDefinition)
      .sort((left, right) => left.uses.localeCompare(right.uses))
  }
}

export interface WorkflowBindingCatalogOptions { readonly now?: () => number }

/** Immutable deployment catalog joining a trusted Trigger to an exact Workflow revision. */
export class WorkflowBindingCatalog {
  readonly #now: () => number

  constructor(
    private readonly repository: WorkflowBindingRepository,
    private readonly targets: WorkflowBindingTargetCatalog,
    private readonly triggers: WorkflowTriggerDefinitionRegistry,
    options: WorkflowBindingCatalogOptions = {},
  ) { this.#now = options.now ?? Date.now }

  async publish(candidate: WorkflowTriggerBindingCandidate, expectedRevision: number): Promise<WorkflowTriggerBinding> {
    validateCandidateEnvelope(candidate, expectedRevision)
    let target: Awaited<ReturnType<WorkflowBindingTargetCatalog['getPublished']>>
    try { target = await this.targets.getPublished(candidate.spec.workflow.id, candidate.spec.workflow.revision) }
    catch (error: unknown) {
      throw new WorkflowBindingError(
        'BINDING_TARGET_NOT_FOUND',
        `published workflow target not found: ${candidate.spec.workflow.id}@${candidate.spec.workflow.revision}`,
        [renderError(error)],
      )
    }
    const diagnostics = [
      ...this.triggers.validate(candidate.spec.trigger.uses, candidate.spec.trigger.with),
      ...validateInputMapping(candidate.spec.inputMapping, target.template.spec.inputSchema),
    ]
    if (diagnostics.length > 0) throw new WorkflowBindingError('BINDING_INVALID', `workflow binding ${candidate.metadata.id} cannot be published`, diagnostics)
    const snapshot = snapshotJsonValue(candidate as unknown as JsonValue) as unknown as WorkflowTriggerBindingCandidate
    return this.repository.publish(snapshot, expectedRevision, this.#now())
  }

  async get(id: string, revision?: number): Promise<WorkflowTriggerBinding> {
    assertId(id)
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) throw new WorkflowBindingError('BINDING_INVALID', 'workflow binding revision must be a positive safe integer')
    const binding = await this.repository.get(id, revision)
    if (binding === undefined) throw new WorkflowBindingError('BINDING_NOT_FOUND', `workflow binding not found: ${id}@${revision ?? 'latest'}`)
    return binding
  }

  async list(query: { readonly limit?: number } = {}): Promise<readonly WorkflowTriggerBinding[]> {
    const limit = query.limit ?? 100
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new WorkflowBindingError('BINDING_INVALID', 'workflow binding list limit must be between 1 and 1000')
    return this.repository.list({ limit })
  }
}

export class InMemoryWorkflowBindingRepository implements WorkflowBindingRepository {
  readonly #bindings = new Map<string, WorkflowTriggerBinding[]>()

  async publish(candidate: WorkflowTriggerBindingCandidate, expectedRevision: number, _publishedAt: number): Promise<WorkflowTriggerBinding> {
    const revisions = this.#bindings.get(candidate.metadata.id) ?? []
    if (revisions.length !== expectedRevision) {
      throw new WorkflowBindingError('BINDING_REVISION_CONFLICT', `workflow binding ${candidate.metadata.id} expected revision ${expectedRevision}, actual ${revisions.length}`)
    }
    const binding = snapshotJsonValue({ ...candidate, metadata: { id: candidate.metadata.id, revision: expectedRevision + 1 } }) as unknown as WorkflowTriggerBinding
    revisions.push(binding)
    this.#bindings.set(binding.metadata.id, revisions)
    return cloneBinding(binding)
  }

  async get(id: string, revision?: number): Promise<WorkflowTriggerBinding | undefined> {
    const revisions = this.#bindings.get(id)
    const binding = revision === undefined ? revisions?.at(-1) : revisions?.[revision - 1]
    return binding === undefined ? undefined : cloneBinding(binding)
  }

  async list(query: { readonly limit?: number } = {}): Promise<readonly WorkflowTriggerBinding[]> {
    return [...this.#bindings.values()].flat().sort(compareBindings).slice(0, query.limit ?? 100).map(cloneBinding)
  }
}

function validateCandidateEnvelope(candidate: WorkflowTriggerBindingCandidate, expectedRevision: number): void {
  if (!isRecord(candidate) || !isRecord(candidate.metadata) || !isRecord(candidate.spec)
    || !isRecord(candidate.spec.workflow) || !isRecord(candidate.spec.trigger)
    || !isRecord(candidate.spec.trigger.with) || !isRecord(candidate.spec.inputMapping)) {
    throw new WorkflowBindingError('BINDING_INVALID', 'workflow binding envelope is malformed')
  }
  if (candidate.apiVersion !== 'workflow.gm-hz.dev/v1alpha1' || candidate.kind !== 'WorkflowBinding') {
    throw new WorkflowBindingError('BINDING_INVALID', 'workflow binding requires the v1alpha1 WorkflowBinding envelope')
  }
  if (typeof candidate.metadata.id !== 'string' || typeof candidate.spec.workflow.id !== 'string'
    || typeof candidate.spec.trigger.uses !== 'string' || typeof candidate.spec.authorityRef !== 'string') {
    throw new WorkflowBindingError('BINDING_INVALID', 'workflow binding identity, target, trigger, and authority must be strings')
  }
  assertId(candidate.metadata.id)
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new WorkflowBindingError('BINDING_INVALID', 'expected binding revision must be a non-negative safe integer')
  assertId(candidate.spec.workflow.id)
  if (!Number.isSafeInteger(candidate.spec.workflow.revision) || candidate.spec.workflow.revision < 1) throw new WorkflowBindingError('BINDING_INVALID', 'target workflow revision must be a positive safe integer')
  assertUses(candidate.spec.trigger.uses)
  if (candidate.spec.authorityRef.length < 1 || candidate.spec.authorityRef.length > 1024) throw new WorkflowBindingError('BINDING_INVALID', 'authorityRef must contain 1-1024 characters')
  if (candidate.spec.deliveryRef !== undefined && (typeof candidate.spec.deliveryRef !== 'string'
    || candidate.spec.deliveryRef.length < 1 || candidate.spec.deliveryRef.length > 4096)) {
    throw new WorkflowBindingError('BINDING_INVALID', 'deliveryRef must contain 1-4096 characters')
  }
  for (const [name, mapping] of Object.entries(candidate.spec.inputMapping)) {
    if (name.length === 0 || !isMappingValue(mapping)) throw new WorkflowBindingError('BINDING_INVALID', `workflow input mapping is invalid: ${name || '<empty>'}`)
  }
}

function validateInputMapping(mapping: Readonly<Record<string, import('./types.js').WorkflowInputMappingValue>>, schema: JsonSchema): readonly string[] {
  const diagnostics: string[] = []
  const root = schema as Record<string, unknown>
  if (root.type !== 'object') return ['target workflow inputSchema.type must be "object"']
  const properties = isRecord(root.properties) ? root.properties : {}
  const required = Array.isArray(root.required) ? root.required.filter((name): name is string => typeof name === 'string') : []
  for (const name of required) if (mapping[name] === undefined) diagnostics.push(`inputMapping.${name} is required by the target workflow`)
  if (root.additionalProperties === false) {
    for (const name of Object.keys(mapping)) if (!Object.hasOwn(properties, name)) diagnostics.push(`inputMapping.${name} is not declared by the target workflow`)
  }
  for (const [name, value] of Object.entries(mapping)) {
    if (!('literal' in value)) continue
    const propertySchema = properties[name]
    if (!isRecord(propertySchema)) continue
    diagnostics.push(...compileJsonValidator(propertySchema, `inputMapping.${name}`)(value.literal))
  }
  return diagnostics
}

function isMappingValue(value: unknown): value is import('./types.js').WorkflowInputMappingValue {
  if (!isRecord(value)) return false
  const keys = ['literal', 'payload', 'metadata'].filter(key => Object.hasOwn(value, key))
  if (keys.length !== 1) return false
  if (keys[0] === 'literal') {
    try { snapshotJsonValue(value.literal) } catch { return false }
    return true
  }
  const source = value[keys[0]!]
  return isRecord(source) && Array.isArray(source.path)
    && source.path.every(part => (typeof part === 'string' && part.length > 0) || (Number.isSafeInteger(part) && (part as number) >= 0))
}

function compareBindings(left: WorkflowTriggerBinding, right: WorkflowTriggerBinding): number {
  return left.metadata.id.localeCompare(right.metadata.id) || right.metadata.revision - left.metadata.revision
}
function cloneBinding(binding: WorkflowTriggerBinding): WorkflowTriggerBinding {
  return snapshotJsonValue(binding as unknown as JsonValue) as unknown as WorkflowTriggerBinding
}
function assertId(id: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new WorkflowBindingError('BINDING_INVALID', `invalid workflow binding id: ${id}`)
}
function assertUses(uses: string): void {
  if (!/^[a-z][a-z0-9.-]*@[1-9][0-9]*$/.test(uses)) throw new WorkflowBindingError('BINDING_INVALID', `invalid workflow trigger identity: ${uses}`)
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function renderError(error: unknown): string { return error instanceof Error ? error.message : String(error) }
