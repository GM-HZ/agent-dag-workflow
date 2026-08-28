import { describe, expect, it, vi } from 'vitest'
import { createDshToolGateway, type DshToolExecutionInput } from '../../src/adapters/dsh/index.js'

describe('DSH Tool gateway', () => {
  it('adapts the public tools.execute result contract', async () => {
    const execute = vi.fn(async (input: DshToolExecutionInput) => ({ isError: false as const, value: { received: input.arguments } }))
    const gateway = createDshToolGateway(execute)
    const signal = new AbortController().signal
    const authority = { session: 'test' }
    await expect(gateway.execute({
      runId: 'run-1', nodeId: 'node-1', invocationId: 'run-1:node-1:1', uses: 'search',
      inputs: { q: 'query' }, config: { uses: 'search' }, authority, signal,
    })).resolves.toEqual({ received: { q: 'query' } })
    expect(execute).toHaveBeenCalledWith({ callId: 'run-1:node-1:1', name: 'search', arguments: { q: 'query' }, agent: authority, signal })
  })
})
