import { describe, expect, it } from 'vitest'
import {
  createScopedWorkflowCapabilityResolver,
  WorkflowCapabilityRegistry,
  WorkflowExecutionError,
} from '../../src/core/index.js'

describe('workflow capability registry', () => {
  it('registers custom Node services with identity-safe disposal', () => {
    const registry = new WorkflowCapabilityRegistry()
    const service = { execute: async () => 'ok' }
    const dispose = registry.register('acme.workflow.execute', service)

    expect(registry.resolve('acme.workflow.execute')).toBe(service)
    expect(registry.list()).toEqual(['acme.workflow.execute'])
    expect(() => registry.register('acme.workflow.execute', {})).toThrow(/already registered/)

    dispose()
    dispose()
    expect(registry.resolve('acme.workflow.execute')).toBeUndefined()
  })

  it('hides undeclared Host bindings and fails closed for missing declared bindings', () => {
    const registry = new WorkflowCapabilityRegistry()
    registry.register('acme.allowed', { value: 1 })
    registry.register('acme.hidden', { value: 2 })
    const resolver = createScopedWorkflowCapabilityResolver(registry, ['acme.allowed', 'acme.missing'], 'custom')

    expect(resolver.declared).toEqual(['acme.allowed', 'acme.missing'])
    expect(resolver.has('acme.allowed')).toBe(true)
    expect(resolver.optional('acme.hidden')).toBeUndefined()
    expect(resolver.require<{ value: number }>('acme.allowed').value).toBe(1)
    expect(() => resolver.require('acme.hidden')).toThrowError(expect.objectContaining<Partial<WorkflowExecutionError>>({
      code: 'WORKFLOW_CAPABILITY_UNDECLARED',
    }))
    expect(() => resolver.require('acme.missing')).toThrowError(expect.objectContaining<Partial<WorkflowExecutionError>>({
      code: 'WORKFLOW_CAPABILITY_UNAVAILABLE',
    }))
  })

  it('rejects invalid capability names and undefined bindings', () => {
    const registry = new WorkflowCapabilityRegistry()
    expect(() => registry.register('Invalid capability', {})).toThrow(/invalid workflow capability/)
    expect(() => registry.register('acme.undefined', undefined)).toThrow(/cannot bind undefined/)
  })
})
