import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv'
import { parse } from 'yaml'
import { snapshotJsonValue } from './json.js'
import type { JsonSchema, WorkflowDiagnostic, WorkflowTemplate } from './types.js'
import { WORKFLOW_TEMPLATE_API_VERSION } from './version.js'

const bindingSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['literal'],
      properties: { literal: {} },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['input'],
      properties: {
        input: {
          type: 'object',
          additionalProperties: false,
          required: ['path'],
          properties: { path: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'integer', minimum: 0 }] } } },
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['output'],
      properties: {
        output: {
          type: 'object',
          additionalProperties: false,
          required: ['nodeId', 'path'],
          properties: {
            nodeId: { type: 'string', minLength: 1 },
            path: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'integer', minimum: 0 }] } },
          },
        },
      },
    },
  ],
} as const

const requirementSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'uses'],
  properties: {
    kind: { type: 'string', pattern: '^[a-z][a-z0-9.-]*$' },
    uses: { type: 'string', minLength: 1, maxLength: 256 },
  },
} as const

export const WORKFLOW_TEMPLATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['apiVersion', 'kind', 'metadata', 'spec'],
  properties: {
    apiVersion: { const: WORKFLOW_TEMPLATE_API_VERSION },
    kind: { const: 'WorkflowTemplate' },
    metadata: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'name'],
      properties: {
        id: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' },
        name: { type: 'string', minLength: 1 },
        description: { type: 'string' },
      },
    },
    spec: {
      type: 'object',
      additionalProperties: false,
      required: ['inputSchema', 'outputSchema', 'nodes', 'edges', 'outputs'],
      properties: {
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        requires: { type: 'array', items: requirementSchema },
        nodes: {
          type: 'array',
          minItems: 2,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'uses', 'with', 'inputs'],
            properties: {
              id: { type: 'string', pattern: '^[a-z][a-z0-9_-]*$' },
              uses: { type: 'string', pattern: '^[a-z][a-z0-9.-]*@[1-9][0-9]*$' },
              title: { type: 'string', minLength: 1 },
              with: { type: 'object' },
              inputs: { type: 'object', additionalProperties: bindingSchema },
              expects: {
                type: 'object',
                additionalProperties: false,
                required: ['schema'],
                properties: {
                  schema: { type: 'object' },
                  maxBytes: { type: 'integer', minimum: 1 },
                },
              },
              policy: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  timeoutMs: { type: 'integer', minimum: 1 },
                  retry: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['maxAttempts'],
                    properties: { maxAttempts: { type: 'integer', minimum: 1, maximum: 10 } },
                  },
                },
              },
            },
          },
        },
        edges: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'source', 'target'],
            properties: {
              id: { type: 'string', minLength: 1 },
              source: { type: 'string', minLength: 1 },
              target: { type: 'string', minLength: 1 },
              sourcePort: { type: 'string', minLength: 1 },
            },
          },
        },
        outputs: { type: 'object', additionalProperties: bindingSchema },
        policies: {
          type: 'object',
          additionalProperties: false,
          properties: {
            maxConcurrentNodes: { type: 'integer', minimum: 1, maximum: 64 },
            maxNodeRuns: { type: 'integer', minimum: 1 },
            maxDurationMs: { type: 'integer', minimum: 1 },
            maxOutputBytes: { type: 'integer', minimum: 1 },
            subworkflowMaxDepth: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    layout: { type: 'object' },
  },
} as const

const ajv = new Ajv({ allErrors: true, strict: false })
const validateTemplateSchema = ajv.compile(WORKFLOW_TEMPLATE_SCHEMA)

const AUTHORED_SCHEMA_KEYWORDS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties',
  'title', 'description', 'default', 'examples', 'readOnly', 'writeOnly', '$comment',
])
const MAX_AUTHORED_SCHEMA_DEPTH = 64
const MAX_AUTHORED_SCHEMA_NODES = 4_096
const MAX_AUTHORED_ENUM_VALUES = 256

export interface AuthoredSchemaDiagnostic {
  readonly message: string
  readonly path: readonly (string | number)[]
}

/**
 * Validates the deliberately small, non-regex JSON Schema dialect accepted
 * from workflow authors. NodeDefinition schemas remain Host-trusted and may
 * use the full Ajv dialect.
 */
export function validateAuthoredDataSchema(schema: JsonSchema, requireObjectRoot = true): readonly AuthoredSchemaDiagnostic[] {
  const diagnostics: AuthoredSchemaDiagnostic[] = []
  if (requireObjectRoot && schema.type !== 'object') {
    diagnostics.push({ message: "root schema must declare type: 'object'", path: ['type'] })
  }
  const pending: { readonly schema: JsonSchema; readonly path: readonly (string | number)[]; readonly depth: number }[] = [
    { schema, path: [], depth: 0 },
  ]
  let nodes = 0
  while (pending.length > 0) {
    const current = pending.pop()!
    nodes++
    if (nodes > MAX_AUTHORED_SCHEMA_NODES) {
      diagnostics.push({ message: `schema exceeds ${MAX_AUTHORED_SCHEMA_NODES} schema nodes`, path: current.path })
      break
    }
    if (current.depth > MAX_AUTHORED_SCHEMA_DEPTH) {
      diagnostics.push({ message: `schema exceeds nesting depth ${MAX_AUTHORED_SCHEMA_DEPTH}`, path: current.path })
      continue
    }
    for (const keyword of Object.keys(current.schema)) {
      if (!AUTHORED_SCHEMA_KEYWORDS.has(keyword)) {
        diagnostics.push({ message: `unsupported or unsafe authored schema keyword: ${keyword}`, path: [...current.path, keyword] })
      }
    }
    const properties = current.schema.properties
    if (properties !== undefined) {
      if (!isPlainRecord(properties)) {
        diagnostics.push({ message: 'properties must be an object of schemas', path: [...current.path, 'properties'] })
      } else {
        for (const [name, child] of Object.entries(properties)) {
          enqueueAuthoredSchema(pending, diagnostics, child, [...current.path, 'properties', name], current.depth + 1)
        }
      }
    }
    const items = current.schema.items
    if (items !== undefined) enqueueAuthoredSchema(pending, diagnostics, items, [...current.path, 'items'], current.depth + 1)
    const additional = current.schema.additionalProperties
    if (additional !== undefined && typeof additional !== 'boolean') {
      enqueueAuthoredSchema(pending, diagnostics, additional, [...current.path, 'additionalProperties'], current.depth + 1)
    }
    if (Array.isArray(current.schema.enum) && current.schema.enum.length > MAX_AUTHORED_ENUM_VALUES) {
      diagnostics.push({ message: `enum must contain at most ${MAX_AUTHORED_ENUM_VALUES} values`, path: [...current.path, 'enum'] })
    }
  }
  return diagnostics
}

function enqueueAuthoredSchema(
  pending: { schema: JsonSchema; path: readonly (string | number)[]; depth: number }[],
  diagnostics: AuthoredSchemaDiagnostic[],
  value: unknown,
  path: readonly (string | number)[],
  depth: number,
): void {
  if (!isPlainRecord(value)) {
    diagnostics.push({ message: 'expected a JSON Schema object', path })
    return
  }
  pending.push({ schema: value, path, depth })
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function parseWorkflowTemplate(source: string): WorkflowTemplate {
  const parsed: unknown = parse(source)
  const snapshot = snapshotJsonValue(parsed)
  const diagnostics = structuralDiagnostics(snapshot)
  if (diagnostics.length > 0) {
    throw new Error(`workflow template is structurally invalid:\n${diagnostics.map(item => `- ${item.message}`).join('\n')}`)
  }
  return snapshot as unknown as WorkflowTemplate
}

export function structuralDiagnostics(candidate: unknown): WorkflowDiagnostic[] {
  if (validateTemplateSchema(candidate)) return []
  return diagnosticsFromAjv('TEMPLATE_SCHEMA', validateTemplateSchema.errors)
}

export function compileJsonValidator(schema: JsonSchema, label: string): (value: unknown) => readonly string[] {
  let validator: ValidateFunction
  try {
    validator = ajv.compile(schema)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${label} is not a valid JSON Schema: ${message}`, { cause: error })
  }
  return (value: unknown) => validator(value) ? [] : diagnosticsFromAjv(label, validator.errors).map(item => item.message)
}

function diagnosticsFromAjv(code: string, errors: readonly ErrorObject[] | null | undefined): WorkflowDiagnostic[] {
  return (errors ?? []).map(error => ({
    code,
    severity: 'error',
    message: `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`,
    path: error.instancePath.split('/').filter(Boolean).map(segment => decodeURIComponent(segment.replaceAll('~1', '/').replaceAll('~0', '~'))),
  }))
}
