import { describe, expect, it, vi } from 'vitest'
import {
  createDshToolGateway,
  DagWorkflowEngine,
  registerCoreNodes,
  WorkflowNodeRegistry,
  type DshToolExecutionInput,
  type WorkflowToolRequest,
} from '../src/index.js'
import { branchingWorkflowTemplate, toolWorkflowTemplate } from './fixtures.js'

describe('DAG workflow engine', () => {
  it('executes tool nodes only through the injected gateway', async () => {
    const registry = new WorkflowNodeRegistry()
    registerCoreNodes(registry)
    const execute = vi.fn(async (request: WorkflowToolRequest) => ({ echo: request.input.message ?? null }))
    const engine = new DagWorkflowEngine(registry, { tools: { execute } })

    const result = await engine.start({ template: toolWorkflowTemplate(), inputs: { message: 'hello' } }).result

    expect(result.status).toBe('completed')
    if (result.status !== 'completed') throw new Error(result.error)
    expect(result.outputs).toEqual({ answer: 'hello' })
    expect(execute).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ name: 'echo', nodeId: 'call', input: { message: 'hello' } }))
    expect(result.events.map(event => event.seq)).toEqual(result.events.map((_, index) => index + 1))
  })

  it('settles untaken branches as skipped before running a join', async () => {
    const registry = new WorkflowNodeRegistry()
    registerCoreNodes(registry)
    const calls: string[] = []
    const engine = new DagWorkflowEngine(registry, {
      tools: {
        async execute(request) {
          calls.push(request.name)
          return request.input.value ?? null
        },
      },
    })

    const result = await engine.start({ template: branchingWorkflowTemplate(), inputs: { enabled: true } }).result

    expect(result.status).toBe('completed')
    if (result.status !== 'completed') throw new Error(result.error)
    expect(result.outputs).toEqual({ answer: 'selected' })
    expect(calls).toEqual(['enabled-tool'])
    expect(result.nodeStates.disabled).toBe('skipped')
    expect(result.edgeStates['choose-enabled']).toBe('taken')
    expect(result.edgeStates['choose-disabled']).toBe('skipped')
    expect(result.edgeStates['disabled-end']).toBe('skipped')
  })

  it('resolves tool failures into a failed run result instead of rejecting', async () => {
    const registry = new WorkflowNodeRegistry()
    registerCoreNodes(registry)
    const engine = new DagWorkflowEngine(registry, {
      tools: { async execute() { throw new Error('policy denied') } },
    })

    const result = await engine.start({ template: toolWorkflowTemplate(), inputs: { message: 'hello' } }).result

    expect(result).toMatchObject({ status: 'failed', error: 'policy denied' })
    expect(result.nodeStates.call).toBe('failed')
    expect(result.events).toContainEqual(expect.objectContaining({ type: 'node.failed', nodeId: 'call' }))
  })

  it('adapts the public ctx.tools.execute result contract', async () => {
    const execute = vi.fn(async (input: DshToolExecutionInput) => ({ isError: false as const, value: { received: input.arguments } }))
    const gateway = createDshToolGateway(execute)
    const signal = new AbortController().signal

    await expect(gateway.execute({ runId: 'run-1', nodeId: 'node-1', name: 'search', input: { q: 'dsh' }, signal }))
      .resolves.toEqual({ received: { q: 'dsh' } })
    expect(execute).toHaveBeenCalledWith({ callId: 'run-1:node-1', name: 'search', arguments: { q: 'dsh' }, signal })
  })
})
