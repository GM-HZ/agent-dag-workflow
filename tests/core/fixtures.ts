import type { WorkflowTemplate } from '../../src/core/index.js'

export function toolWorkflowTemplate(): WorkflowTemplate {
  return {
    apiVersion: 'workflow.gm-hz.dev/v1alpha1',
    kind: 'WorkflowTemplate',
    metadata: { id: 'tool-flow', name: 'Tool flow' },
    spec: {
      requires: [
        { kind: 'capability', uses: 'gateway.tool.execute' },
        { kind: 'tool', uses: 'echo' },
      ],
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['message'],
        properties: { message: { type: 'string' } },
      },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['answer'],
        properties: { answer: { type: 'string' } },
      },
      nodes: [
        { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
        {
          id: 'call',
          uses: 'tool.call@1',
          with: { uses: 'echo' },
          inputs: { message: { input: { path: ['message'] } } },
        },
        {
          id: 'end',
          uses: 'core.end@1',
          with: {},
          inputs: { answer: { output: { nodeId: 'call', path: ['result', 'echo'] } } },
        },
      ],
      edges: [
        { id: 'start-call', source: 'start', target: 'call' },
        { id: 'call-end', source: 'call', target: 'end' },
      ],
      outputs: { answer: { output: { nodeId: 'end', path: ['answer'] } } },
      policies: { maxConcurrentNodes: 2, maxNodeRuns: 8, maxDurationMs: 5_000, maxOutputBytes: 10_000 },
    },
    layout: { nodes: { start: { x: 0, y: 0 } } },
  }
}

export function branchingWorkflowTemplate(): WorkflowTemplate {
  return {
    apiVersion: 'workflow.gm-hz.dev/v1alpha1',
    kind: 'WorkflowTemplate',
    metadata: { id: 'branch-flow', name: 'Branch flow' },
    spec: {
      requires: [
        { kind: 'capability', uses: 'gateway.tool.execute' },
        { kind: 'tool', uses: 'enabled-tool' },
        { kind: 'tool', uses: 'disabled-tool' },
      ],
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['enabled'],
        properties: { enabled: { type: 'boolean' } },
      },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['answer'],
        properties: { answer: { type: 'boolean' } },
      },
      nodes: [
        { id: 'start', uses: 'core.start@1', with: {}, inputs: {} },
        {
          id: 'choose',
          uses: 'core.condition@1',
          with: { operator: 'truthy' },
          inputs: { left: { input: { path: ['enabled'] } } },
        },
        {
          id: 'enabled',
          uses: 'tool.call@1',
          with: { uses: 'enabled-tool' },
          inputs: { value: { literal: 'selected' } },
        },
        {
          id: 'disabled',
          uses: 'tool.call@1',
          with: { uses: 'disabled-tool' },
          inputs: { value: { literal: 'not-selected' } },
        },
        {
          id: 'end',
          uses: 'core.end@1',
          with: {},
          inputs: { answer: { output: { nodeId: 'choose', path: ['result'] } } },
        },
      ],
      edges: [
        { id: 'start-choose', source: 'start', target: 'choose' },
        { id: 'choose-enabled', source: 'choose', target: 'enabled', sourcePort: 'true' },
        { id: 'choose-disabled', source: 'choose', target: 'disabled', sourcePort: 'false' },
        { id: 'enabled-end', source: 'enabled', target: 'end' },
        { id: 'disabled-end', source: 'disabled', target: 'end' },
      ],
      outputs: { answer: { output: { nodeId: 'end', path: ['answer'] } } },
    },
  }
}
