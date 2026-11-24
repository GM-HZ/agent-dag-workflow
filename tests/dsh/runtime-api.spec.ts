import { describe, expect, it, vi } from 'vitest'
import { currentAgentCapabilities, executeDshTool, startDshSubagent } from '../../src/adapters/dsh/runtime-api.js'
import type { DshSubagentActivationRuntimeLike, DshToolBatchRuntimeLike } from '../../src/adapters/dsh/types.js'

const parent = { session: { append() {} } }
const signal = new AbortController().signal

describe('DSH runtime API compatibility', () => {
  it('uses the native batch executor with the owning agent and returns the canonical value', async () => {
    const toolResult = { isError: false, value: { answer: 'hello' } } as const
    const execute = vi.fn<DshToolBatchRuntimeLike['execute']>()
      .mockResolvedValue({ results: [{ callId: 'run:echo', result: toolResult }] })
    const tools = { setExecutor() {}, execute }
    const request = { callId: 'run:echo', name: 'echo', arguments: { message: 'hello' }, agent: parent, signal }
    await expect(executeDshTool(tools, request)).resolves.toEqual(toolResult)
    expect(execute).toHaveBeenCalledWith({
      calls: [{ id: 'run:echo', type: 'tool-call', name: 'echo', arguments: '{"message":"hello"}' }],
      agent: parent,
      signal,
    })

    execute.mockResolvedValueOnce({ results: [{ callId: 'unrelated', result: toolResult }] })
    await expect(executeDshTool(tools, request)).rejects.toMatchObject({ code: 'DSH_TOOL_FAILED' })
  })

  it('returns and disposes a managed activation and refuses explicit allowlists before delegating', async () => {
    const dispose = vi.fn(async () => {})
    const result = Promise.resolve({ output: [], structured: { answer: 'hello' }, stopReason: 'completed' })
    const startActivation = vi.fn<DshSubagentActivationRuntimeLike['startActivation']>()
      .mockResolvedValue({ childId: 'native-child', result, dispose })
    const subagents = {
      getProvider: (name: string) => name === 'spawn' ? { capabilities: { outputSchema: true, depthLimit: true } } : undefined,
      startActivation,
    }
    expect(currentAgentCapabilities(subagents)).toMatchObject({ outputSchema: true, toolFilter: false })
    const request = {
      label: 'delegate', parent, signal,
      prompt: [{ type: 'text' as const, text: 'Provide a structured answer.' }],
      outputSchema: { type: 'object' },
    }
    for (const allowed of [[], ['echo']]) {
      await expect(startDshSubagent(subagents, request, allowed)).rejects.toMatchObject({
        code: 'DSH_SUBAGENT_TOOL_FILTER_UNSUPPORTED',
      })
    }
    expect(startActivation).not.toHaveBeenCalled()
    const run = await startDshSubagent(subagents, request, undefined)
    expect(startActivation).toHaveBeenCalledWith({ ...request, provider: 'spawn', delivery: 'caller' })
    expect(run.id).toBe('native-child')
    await expect(run.result).resolves.toMatchObject({ structured: { answer: 'hello' } })
    await run.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })
})
