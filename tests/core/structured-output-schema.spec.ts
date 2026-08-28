import { describe, expect, it } from 'vitest'
import { validateStructuredObjectSchema } from '../../src/core/index.js'

describe('DSH structured output schema compatibility', () => {
  it('accepts the enforced object-rooted subset', () => {
    expect(validateStructuredObjectSchema({
      type: 'object',
      additionalProperties: false,
      required: ['items'],
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            required: ['score'],
            properties: { score: { type: 'integer' } },
          },
        },
      },
    })).toEqual([])
  })

  it('rejects unsupported constraints before a subagent starts', () => {
    expect(validateStructuredObjectSchema({
      type: 'object',
      properties: {
        items: { type: 'array', maxItems: 10, items: { type: 'string', minLength: 1 } },
        score: { type: 'integer', minimum: 0, maximum: 100 },
      },
    })).toEqual(expect.arrayContaining([
      expect.stringContaining('maxItems'),
      expect.stringContaining('minLength'),
      expect.stringContaining('minimum'),
      expect.stringContaining('maximum'),
    ]))
  })

  it('requires an object root and validates required property names', () => {
    expect(validateStructuredObjectSchema({ type: 'array', items: { type: 'string' } })[0])
      .toMatch(/object-rooted/)
    expect(validateStructuredObjectSchema({
      type: 'object',
      properties: { present: { type: 'string' } },
      required: ['missing'],
    })).toContainEqual(expect.stringContaining('undeclared property'))
  })
})
