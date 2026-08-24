import { describe, expect, it } from 'vitest'
import {
  evaluateWorkflowExpression,
  validateWorkflowExpression,
  WorkflowExpressionExecutionError,
} from '../src/index.js'

const signal = new AbortController().signal

function run(source: string, input: Record<string, import('../src/index.js').JsonValue> = {}) {
  return evaluateWorkflowExpression(source, input, { signal, maxOperations: 10000 })
}

describe('dsh.expr@1', () => {
  it('builds typed object outputs from input paths and operators', () => {
    expect(run(`{
      fullName: upper(input.first + " " + input.last),
      score: input.points * 10,
      accepted: input.points >= 7 ? true : false
    }`, { first: 'Ada', last: 'Lovelace', points: 8 })).toEqual({
      fullName: 'ADA LOVELACE',
      score: 80,
      accepted: true,
    })
  })

  it('supports deterministic list, object, path, and template helpers', () => {
    expect(run(`{
      ids: mapGet(input.rows, "id"),
      active: filterEq(input.rows, "active", true),
      total: sum(mapGet(input.rows, "score")),
      tags: sort(unique(input.tags)),
      message: format("Hello {{ user.name }}", input)
    }`, {
      user: { name: 'Grace' },
      rows: [
        { id: 'a', active: true, score: 2 },
        { id: 'b', active: false, score: 3 },
      ],
      tags: ['z', 'a', 'z'],
    })).toEqual({
      ids: ['a', 'b'],
      active: [{ id: 'a', active: true, score: 2 }],
      total: 5,
      tags: ['a', 'z'],
      message: 'Hello Grace',
    })
  })

  it('short-circuits boolean and null-coalescing operators', () => {
    expect(run('{ value: input.present ?? "fallback", safe: false && input.missing.value }', { present: null }))
      .toEqual({ value: 'fallback', safe: false })
  })

  it('round-trips lossless JSON through explicit helpers', () => {
    expect(run('{ value: parseJson(json(input.value)) }', { value: { a: [1, true, null] } }))
      .toEqual({ value: { a: [1, true, null] } })
  })

  it('reports syntax errors before execution', () => {
    expect(validateWorkflowExpression('{ result: input. }')).toEqual([
      expect.stringContaining('expected identifier'),
    ])
  })

  it('rejects missing properties instead of silently producing undefined', () => {
    expect(() => run('{ value: input.missing }')).toThrow(/object key does not exist/)
  })

  it('blocks prototype traversal and arbitrary function calls', () => {
    expect(validateWorkflowExpression('{ value: input.constructor }')[0]).toMatch(/unsafe/)
    expect(validateWorkflowExpression('{ value: process("x") }')[0]).toMatch(/unknown function/)
  })

  it('requires an object result for standardized workflow outputs', () => {
    expect(() => run('input.value', { value: 'scalar' })).toThrow(/must be a JSON object/)
  })

  it('enforces the operation budget', () => {
    expect(() => evaluateWorkflowExpression('{ value: upper(trim(input.value)) }', { value: ' x ' }, {
      signal,
      maxOperations: 1,
    })).toThrow(WorkflowExpressionExecutionError)
  })

  it('honors cancellation without evaluating the script', () => {
    const controller = new AbortController()
    controller.abort('stop')
    expect(() => evaluateWorkflowExpression('{ value: input.value }', { value: 1 }, {
      signal: controller.signal,
      maxOperations: 100,
    })).toThrow(/cancelled/)
  })
})
