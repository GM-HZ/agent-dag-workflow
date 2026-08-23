import { describe, expect, it } from 'vitest'
import {
  compileWorkflow,
  compileWorkflowOrThrow,
  isJsonObject,
  LosslessJsonError,
  registerCoreNodes,
  snapshotJsonValue,
  WorkflowNodeRegistry,
} from '../src/index.js'
import { toolWorkflowTemplate } from './fixtures.js'

describe('lossless JSON boundary', () => {
  it.each([
    ['undefined', { value: undefined }],
    ['date', { value: new Date(0) }],
    ['negative zero', { value: -0 }],
    ['non-finite', { value: Number.POSITIVE_INFINITY }],
    ['sparse array', { value: Array(1) }],
  ])('rejects %s', (_label, candidate) => {
    expect(() => snapshotJsonValue(candidate)).toThrow(LosslessJsonError)
  })

  it('rejects circular references and accessor properties', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => snapshotJsonValue(circular)).toThrow(/circular reference/)

    const accessor = Object.defineProperty({}, 'value', { enumerable: true, get: () => 1 })
    expect(() => snapshotJsonValue(accessor)).toThrow(/accessor properties/)
  })

  it('materializes an immutable detached snapshot', () => {
    const source = { nested: { values: [1, 2] } }
    const snapshot = snapshotJsonValue(source)
    source.nested.values.push(3)

    expect(snapshot).toEqual({ nested: { values: [1, 2] } })
    expect(Object.isFrozen(snapshot)).toBe(true)
    if (!isJsonObject(snapshot)) throw new Error('expected object')
    expect(Object.isFrozen(snapshot.nested)).toBe(true)
  })

  it('compiles an owned template snapshot and diagnoses non-JSON templates', () => {
    const registry = new WorkflowNodeRegistry()
    registerCoreNodes(registry)
    const source = toolWorkflowTemplate()
    const compiled = compileWorkflowOrThrow(source, registry)
    ;(source.metadata as { name: string }).name = 'mutated later'

    expect(compiled.template.metadata.name).toBe('Tool flow')
    expect(Object.isFrozen(compiled.template)).toBe(true)

    const invalid = { ...toolWorkflowTemplate(), layout: { generatedAt: new Date(0) } } as unknown as ReturnType<typeof toolWorkflowTemplate>
    expect(compileWorkflow(invalid, registry).diagnostics).toContainEqual(expect.objectContaining({ code: 'TEMPLATE_NOT_LOSSLESS_JSON' }))
  })
})
