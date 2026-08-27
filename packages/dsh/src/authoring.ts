import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import {
  isJsonObject,
  snapshotJsonObject,
  snapshotJsonValue,
  stableJsonStringify,
  type JsonObject,
  type JsonValue,
  type WorkflowTemplate,
} from '@gm-hz/dsh-dag-workflow-core'
import type {
  DshAgentLike,
  DshSkillRuntimeLike,
  DshSubagentRuntimeLike,
  DshToolRegistryLike,
  DshToolRunContextLike,
  DshWorkflowToolDefinition,
} from './types.js'

type AuthoringContext = Context & {
  readonly tools: DshToolRegistryLike
  readonly subagents: DshSubagentRuntimeLike
  readonly skills: DshSkillRuntimeLike
}

const objectOutput = { type: 'object' } as const
const templateProperty = { type: 'object', description: 'A complete WorkflowTemplate v1alpha1 JSON object.' } as const
const idProperty = { type: 'string', pattern: '^[a-z][a-z0-9-]*$' } as const
const revisionProperty = { type: 'integer', minimum: 1 } as const
const DSH_STRUCTURED_OUTPUT_SCHEMA = Object.freeze({
  dialect: 'dsh.object-json-schema/v1',
  rootType: 'object',
  keywords: ['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'],
  annotations: ['description', 'title', 'default', 'examples'],
})

export class WorkflowAuthoringService {
  static inject = ['tools', 'subagents', 'skills', 'workflowNodes', 'workflowScripts', 'workflowTemplates', 'dagWorkflowEngine']

  constructor(ctx: Context) {
    ctx.effect(() => registerWorkflowAuthoring(ctx), 'dsh-dag-workflow: authoring tools and skill')
  }
}

export function registerWorkflowAuthoring(rawContext: Context): () => void {
  const ctx = rawContext as AuthoringContext
  const disposers = workflowToolDefinitions(ctx).map(definition => ctx.tools.register(definition))
  const skillContent = readFileSync(new URL('../skills/workflow-builder/SKILL.md', import.meta.url), 'utf8')
  disposers.push(ctx.skills.register({
    name: 'workflow-builder',
    description: 'Plan, create, validate, review, publish, and test DSH DAG workflows through the guarded workflow tools. Use for requests to build or modify reusable workflows, DAG automations, or workflow templates.',
    source: 'bundled:dsh-dag-workflow',
    content: stripFrontmatter(skillContent),
    invocation: { modelInvocable: true, userInvocable: true },
  }))
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    for (const dispose of disposers.reverse()) dispose()
  }
}

export function workflowToolDefinitions(ctx: Context): readonly DshWorkflowToolDefinition[] {
  const agentCapabilities = currentAgentCapabilities((ctx as AuthoringContext).subagents)
  return [
    tool('workflow_nodes_list', 'List exact workflow NodeDefinitions, pure script runtimes, and DSH Tools visible in the calling Agent scope.', {}, async (_args, execution) => ({
      nodes: ctx.workflowNodes.list().map(node => snapshotJsonValue({
        uses: `${node.type}@${node.version}`,
        title: node.title,
        description: node.description,
        role: node.role ?? 'regular',
        configSchema: node.configSchema as JsonValue,
        ...(node.defaultConfig === undefined ? {} : { defaultConfig: node.defaultConfig }),
        inputSchema: node.inputSchema as JsonValue,
        outputSchema: node.outputSchema as JsonValue,
        outputPorts: node.outputPorts,
        requiredOutputPorts: node.requiredOutputPorts ?? [],
        capabilities: node.capabilities,
        dependencyKinds: node.dependencyKinds ?? [],
        defaultRequirements: [
          ...node.capabilities.map(uses => ({ kind: 'capability', uses })),
          ...(node.defaultConfig === undefined ? [] : node.dependencies?.(node.defaultConfig) ?? []),
        ],
        retry: node.retry,
      })),
      scriptRuntimes: ctx.workflowScripts.list().map(runtime => snapshotJsonValue({
        uses: `${runtime.language}@${runtime.version}`,
        title: runtime.title,
        description: runtime.description,
        deterministic: runtime.deterministic,
      })),
      tools: (ctx as AuthoringContext).tools.schemas(execution.agent)
        .filter(schema => !schema.name.startsWith('workflow_'))
        .map(schema => snapshotJsonValue(schema)),
      agent: snapshotJsonValue({
        mode: 'current',
        capabilities: agentCapabilities,
        ...(agentCapabilities.outputSchema ? { structuredOutputSchema: DSH_STRUCTURED_OUTPUT_SCHEMA } : {}),
      }),
    }), true),
    tool('workflow_draft_create', 'Create a workflow draft after materializing a lossless JSON snapshot. Drafts may be structurally incomplete.', {
      template: { ...templateProperty, required: true },
    }, async args => snapshotJsonValue(ctx.workflowTemplates.createDraft(templateArg(args, 'template')))),
    tool('workflow_draft_read', 'Read the current immutable snapshot and CAS revision of a workflow draft.', {
      id: { ...idProperty, required: true },
    }, async args => snapshotJsonValue(ctx.workflowTemplates.readDraft(stringArg(args, 'id'))), true),
    tool('workflow_draft_update', 'Replace a workflow draft using optimistic concurrency. Pass the exact expected revision returned by the last read or update.', {
      id: { ...idProperty, required: true },
      expectedRevision: { ...revisionProperty, required: true },
      template: { ...templateProperty, required: true },
    }, async args => snapshotJsonValue(ctx.workflowTemplates.updateDraft(
      stringArg(args, 'id'),
      integerArg(args, 'expectedRevision'),
      templateArg(args, 'template'),
    ))),
    tool('workflow_draft_import', 'Create or CAS-update a workflow draft from a lossless JSON string. Use this for large templates that are unreliable as nested tool arguments.', {
      templateJson: { type: 'string', required: true },
      expectedRevision: revisionProperty,
    }, async args => {
      const template = templateJsonArg(args)
      const expectedRevision = optionalIntegerArg(args, 'expectedRevision')
      return snapshotJsonValue(expectedRevision === undefined
        ? ctx.workflowTemplates.createDraft(template)
        : ctx.workflowTemplates.updateDraft(template.metadata.id, expectedRevision, template))
    }),
    tool('workflow_draft_validate', 'Validate the current immutable draft by id without resending the complete template.', {
      id: { ...idProperty, required: true },
    }, async args => {
      const draft = ctx.workflowTemplates.readDraft(stringArg(args, 'id'))
      return { revision: draft.revision, diagnostics: snapshotJsonValue(ctx.workflowTemplates.validate(draft.template)) }
    }, true),
    tool('workflow_validate', 'Compile a candidate workflow and return stable diagnostics. Never infer success from an empty tool error.', {
      template: { ...templateProperty, required: true },
    }, async args => ({ diagnostics: snapshotJsonValue(ctx.workflowTemplates.validate(templateArg(args, 'template'))) }), true),
    tool('workflow_diff', 'Compare a candidate against the current draft and separate semantic, layout, node, and edge changes.', {
      id: { ...idProperty, required: true },
      candidate: { ...templateProperty, required: true },
    }, async args => snapshotJsonValue(ctx.workflowTemplates.diff(stringArg(args, 'id'), templateArg(args, 'candidate'))), true),
    tool('workflow_publish', 'Publish an immutable revision only when full validation succeeds and the expected draft revision still matches.', {
      id: { ...idProperty, required: true },
      expectedRevision: { ...revisionProperty, required: true },
    }, async args => snapshotJsonValue(ctx.workflowTemplates.publish(stringArg(args, 'id'), integerArg(args, 'expectedRevision')))),
    tool('workflow_run', 'Run one exact published revision, or an explicit inline template test, as the calling Agent. Exactly one of id or template is required.', {
      id: idProperty,
      revision: revisionProperty,
      template: templateProperty,
      inputs: { type: 'object', required: true },
    }, async (args, execution) => {
      const parent = execution.agent
      if (parent === undefined) throw new Error('workflow_run requires a calling Agent')
      const input = objectArg(args, 'inputs')
      const candidate = objectArgs(args)
      const hasId = candidate.id !== undefined
      const hasTemplate = candidate.template !== undefined
      if (hasId === hasTemplate) throw new Error('workflow_run requires exactly one of id or template')
      if (!hasId && candidate.revision !== undefined) throw new Error('workflow_run revision is valid only with id')
      if (hasId && candidate.revision === undefined) throw new Error('workflow_run requires an explicit revision with id')
      const template = hasId
        ? ctx.workflowTemplates.getPublished(stringArg(args, 'id'), optionalIntegerArg(args, 'revision')).template
        : templateArg(args, 'template')
      const run = ctx.dagWorkflowEngine.start({ template, inputs: input, parent, signal: execution.signal })
      const result = await settleRun(run)
      return snapshotJsonValue({
        runId: result.runId,
        status: result.status,
        ...(result.status === 'completed' ? { outputs: result.outputs } : { error: result.error }),
        ...('needsAttention' in result && result.needsAttention !== undefined ? { needsAttention: result.needsAttention } : {}),
      })
    }),
  ]
}

function currentAgentCapabilities(runtime: DshSubagentRuntimeLike): {
  readonly outputSchema: boolean
  readonly depthLimit: boolean
  readonly toolFilter: boolean
  readonly persona: boolean
} {
  const capabilities = (runtime.list?.() ?? [])
    .map(name => runtime.getProvider?.(name)?.capabilities)
    .filter(value => value !== undefined)
  return {
    outputSchema: capabilities.some(value => value.outputSchema),
    depthLimit: capabilities.some(value => value.depthLimit),
    toolFilter: capabilities.some(value => value.toolFilter),
    persona: capabilities.some(value => value.persona),
  }
}

function tool(
  name: string,
  description: string,
  properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  execute: (args: unknown, context: DshToolRunContextLike) => Promise<JsonValue>,
  concurrencySafe = false,
): DshWorkflowToolDefinition {
  const required = Object.entries(properties).filter(([, property]) => property.required === true).map(([key]) => key)
  const jsonProperties = Object.fromEntries(Object.entries(properties).map(([key, property]) => {
    const { required: _required, ...schema } = property
    return [key, schema]
  }))
  return {
    name,
    description,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: jsonProperties,
      ...(required.length === 0 ? {} : { required }),
    },
    output: {
      schema: objectOutput,
      render(_args, value) { return [{ type: 'text', text: stableJsonStringify(value) }] },
    },
    ...(concurrencySafe ? { isConcurrencySafe: () => true } : {}),
    async execute(args, context) {
      return snapshotJsonValue(await execute(snapshotJsonObject(args), context))
    },
  }
}

async function settleRun(run: ReturnType<Context['dagWorkflowEngine']['start']>) {
  let result: Awaited<typeof run.result> | undefined
  let executionError: unknown
  try { result = await run.result } catch (error: unknown) { executionError = error }
  let disposalError: unknown
  try { await run.dispose() } catch (error: unknown) { disposalError = error }
  if (executionError !== undefined || disposalError !== undefined) {
    const errors = [executionError, disposalError].filter(error => error !== undefined)
    throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'workflow execution and disposal failed')
  }
  if (result === undefined) throw new Error('workflow result was not available')
  return result
}

function objectArgs(value: unknown): JsonObject {
  return snapshotJsonObject(value)
}

function objectArg(value: unknown, key: string): JsonObject {
  const field = objectArgs(value)[key]
  if (!isJsonObject(field)) throw new Error(`${key} must be an object`)
  return field
}

function stringArg(value: unknown, key: string): string {
  const field = objectArgs(value)[key]
  if (typeof field !== 'string' || field.length === 0) throw new Error(`${key} must be a non-empty string`)
  return field
}

function integerArg(value: unknown, key: string): number {
  const field = objectArgs(value)[key]
  if (typeof field !== 'number' || !Number.isSafeInteger(field) || field < 1) throw new Error(`${key} must be a positive safe integer`)
  return field
}

function optionalIntegerArg(value: unknown, key: string): number | undefined {
  const field = objectArgs(value)[key]
  return field === undefined ? undefined : integerArg(value, key)
}

function templateArg(value: unknown, key: string): WorkflowTemplate {
  return objectArg(value, key) as unknown as WorkflowTemplate
}

function templateJsonArg(value: unknown): WorkflowTemplate {
  const source = stringArg(value, 'templateJson')
  let parsed: unknown
  try { parsed = JSON.parse(source) } catch (error: unknown) {
    throw new Error(`templateJson must be valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  return snapshotJsonObject(parsed) as unknown as WorkflowTemplate
}

function stripFrontmatter(content: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(content)
  if (match === null) throw new Error('workflow-builder SKILL.md is missing YAML frontmatter')
  return content.slice(match[0].length)
}
