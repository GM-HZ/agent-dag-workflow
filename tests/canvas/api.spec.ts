import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkflowCanvasApi, WorkflowCanvasRequestError } from '../../src/canvas/client/api.js'

describe('Workflow Canvas client request boundary', () => {
  afterEach(() => vi.useRealTimers())

  it('retries only an explicitly idempotent read after a connection failure', async () => {
    vi.useFakeTimers()
    const remote = {} as never
    const api = createWorkflowCanvasApi(remote)
    const invoke = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ ok: true, value: ['ready'] })
    const onRetry = vi.fn()

    const pending = api.request('nodes', invoke, { retries: 1, onRetry })
    await vi.advanceTimersByTimeAsync(200)

    await expect(pending).resolves.toEqual(['ready'])
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(WorkflowCanvasRequestError))
  })

  it('does not retry mutations by default when the response is lost', async () => {
    const api = createWorkflowCanvasApi({} as never)
    const invoke = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(api.request('createDraft', invoke)).rejects.toMatchObject({
      presentation: expect.objectContaining({ kind: 'connection', retryable: true }),
    })
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('turns structured CAS failures into a conflict recovery presentation', () => {
    const api = createWorkflowCanvasApi({} as never)
    expect(() => api.unwrap('updateDraft', {
      ok: false, error: { code: 'CATALOG_REVISION_CONFLICT', message: 'expected revision 2' },
    })).toThrow(expect.objectContaining({
      presentation: expect.objectContaining({ kind: 'conflict', retryable: false }),
    }))
  })
})
