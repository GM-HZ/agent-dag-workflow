import { describe, expect, it } from 'vitest'
import workflowCanvasRemote from '../../lib/typert.remote-client.js'

describe('generated Typert Remote contribution', () => {
  it('publishes strict descriptors for the complete Canvas RPC surface', () => {
    const ids = workflowCanvasRemote.descriptors.map(descriptor => descriptor.id)
    expect(ids).toHaveLength(13)
    expect(ids).toContain('@gm-hz/agent-dag-workflow#workflowCanvas/runDraft')
    expect(ids).toContain('@gm-hz/agent-dag-workflow#workflowCanvas/trace')
    expect(ids).toContain('@gm-hz/agent-dag-workflow#workflowCanvas/operations')
    expect(workflowCanvasRemote.descriptors.find(descriptor => descriptor.id.endsWith('/run'))?.cancellation)
      .toEqual({ parameter: 'signal' })
  })
})
