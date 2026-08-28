import type { JsonObject, JsonValue } from './types.js'

const CONSTRAINT_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
])
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples'])
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const ONE_OF_SIBLINGS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const'] as const

/**
 * Validate the enforced structured-output subset before an agent.run node
 * reaches the Host. This intentionally mirrors the stable public subset used
 * by Host gateways without coupling the workflow core to a Harness
 * package version.
 */
export function validateStructuredObjectSchema(schema: JsonValue): readonly string[] {
  const diagnostics: string[] = []
  if (!isObject(schema) || schema.type !== 'object') {
    diagnostics.push('outputSchema.type must be "object" (structured output is object-rooted)')
  }
  const stack: { readonly value: JsonValue; readonly path: string }[] = [{ value: schema, path: 'outputSchema' }]
  while (stack.length > 0) {
    const task = stack.pop()!
    if (!isObject(task.value)) {
      diagnostics.push(`${task.path} must be a schema object`)
      continue
    }
    const node = task.value
    for (const key of Object.keys(node)) {
      if (!CONSTRAINT_KEYWORDS.has(key) && !ANNOTATION_KEYWORDS.has(key)) {
        diagnostics.push(`${task.path}.${key} is not supported by the structured-output schema subset`)
      }
    }
    if (node.description !== undefined && typeof node.description !== 'string') {
      diagnostics.push(`${task.path}.description must be a string`)
    }
    if (node.title !== undefined && typeof node.title !== 'string') {
      diagnostics.push(`${task.path}.title must be a string`)
    }

    const hasType = Object.hasOwn(node, 'type')
    const hasOneOf = Object.hasOwn(node, 'oneOf')
    if (hasType && hasOneOf) {
      diagnostics.push(`${task.path} cannot declare both type and oneOf`)
      continue
    }
    if (hasOneOf) {
      for (const key of ONE_OF_SIBLINGS) {
        if (Object.hasOwn(node, key)) diagnostics.push(`${task.path}.${key} is not supported beside oneOf`)
      }
      if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) {
        diagnostics.push(`${task.path}.oneOf must contain at least two schema objects`)
      } else {
        pushSchemas(stack, node.oneOf, `${task.path}.oneOf`)
      }
      continue
    }
    if (!hasType) {
      if (ONE_OF_SIBLINGS.some(key => Object.hasOwn(node, key))) {
        diagnostics.push(`${task.path} constraints require type or oneOf`)
      }
      continue
    }
    if (typeof node.type !== 'string' || !SCHEMA_TYPES.has(node.type)) {
      diagnostics.push(`${task.path}.type must be one supported scalar type string`)
      continue
    }

    if (node.type === 'object') {
      const properties = node.properties
      if (properties !== undefined && !isObject(properties)) {
        diagnostics.push(`${task.path}.properties must be an object of schemas`)
      } else if (properties !== undefined) {
        for (const [key, value] of Object.entries(properties)) {
          stack.push({ value, path: `${task.path}.properties.${key}` })
        }
      }
      if (node.required !== undefined) {
        if (!Array.isArray(node.required) || !node.required.every(value => typeof value === 'string')) {
          diagnostics.push(`${task.path}.required must be an array of strings`)
        } else if (isObject(properties)) {
          for (const key of node.required) {
            if (!Object.hasOwn(properties, key)) diagnostics.push(`${task.path}.required names undeclared property "${key}"`)
          }
        }
      }
      if (node.additionalProperties !== undefined && typeof node.additionalProperties !== 'boolean') {
        diagnostics.push(`${task.path}.additionalProperties must be a boolean`)
      }
      rejectMisplaced(node, task.path, ['items', 'enum', 'const'], diagnostics)
      continue
    }
    if (node.type === 'array') {
      if (node.items !== undefined) stack.push({ value: node.items, path: `${task.path}.items` })
      rejectMisplaced(node, task.path, ['properties', 'required', 'additionalProperties', 'enum', 'const'], diagnostics)
      continue
    }
    rejectMisplaced(node, task.path, ['properties', 'required', 'additionalProperties', 'items'], diagnostics)
    validateScalarLiterals(node, task.path, diagnostics)
  }
  return diagnostics
}

function pushSchemas(
  stack: { value: JsonValue; path: string }[],
  values: readonly JsonValue[],
  path: string,
): void {
  for (let index = values.length - 1; index >= 0; index--) {
    stack.push({ value: values[index]!, path: `${path}[${index}]` })
  }
}

function rejectMisplaced(node: JsonObject, path: string, keys: readonly string[], diagnostics: string[]): void {
  for (const key of keys) {
    if (Object.hasOwn(node, key)) diagnostics.push(`${path}.${key} is not supported on type "${String(node.type)}"`)
  }
}

function validateScalarLiterals(node: JsonObject, path: string, diagnostics: string[]): void {
  if (node.enum !== undefined) {
    if (!Array.isArray(node.enum) || node.enum.length === 0 || !node.enum.every(value => scalarMatches(node.type, value))) {
      diagnostics.push(`${path}.enum must be a non-empty array matching type "${String(node.type)}"`)
    }
  }
  if (node.const !== undefined && !scalarMatches(node.type, node.const)) {
    diagnostics.push(`${path}.const must match type "${String(node.type)}"`)
  }
}

function scalarMatches(type: JsonValue | undefined, value: JsonValue): boolean {
  if (value !== null && typeof value === 'object') return false
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number'
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: return false
  }
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
