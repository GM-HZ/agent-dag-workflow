import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv'
import { parse } from 'yaml'
import { snapshotJsonValue } from './json.js'
import type { JsonSchema, WorkflowDiagnostic, WorkflowTemplate } from './types.js'

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
      properties: { input: { type: 'string', minLength: 1 } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['output'],
      properties: {
        output: {
          type: 'object',
          additionalProperties: false,
          required: ['node', 'path'],
          properties: {
            node: { type: 'string', minLength: 1 },
            path: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'integer', minimum: 0 }] } },
          },
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['secret'],
      properties: {
        secret: {
          type: 'object',
          additionalProperties: false,
          required: ['ref'],
          properties: { ref: { type: 'string', minLength: 1 } },
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
    apiVersion: { const: 'dsh.workflow/v1alpha1' },
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
                    properties: { maxAttempts: { type: 'integer', minimum: 1 } },
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

export function parseWorkflowTemplate(source: string): WorkflowTemplate {
  const parsed: unknown = parse(source)
  return snapshotJsonValue(parsed) as unknown as WorkflowTemplate
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
