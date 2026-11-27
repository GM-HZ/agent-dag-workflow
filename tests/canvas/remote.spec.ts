import { describe, expect, it } from 'vitest'
import workflowCanvasRemote from '../../lib/typert.remote-client.js'

describe('generated Typert Remote contribution', () => {
  it('publishes strict descriptors for the complete Canvas RPC surface', () => {
    const ids = workflowCanvasRemote.descriptors.map(descriptor => descriptor.id)
    expect(ids).toHaveLength(25)
    expect(ids).toContain('@gm-hz/agent-dag-workflow#workflowCanvas/runDraft')
    expect(ids).toContain('@gm-hz/agent-dag-workflow#workflowCanvas/trace')
    expect(ids).toContain('@gm-hz/agent-dag-workflow#workflowCanvas/cancel')
    expect(ids).toContain('@gm-hz/agent-dag-workflow#workflowCanvas/operations')
    expect(ids).toContain('@gm-hz/agent-dag-workflow#workflowCanvas/runSchedule')
    expect(ids).toContain('@gm-hz/agent-dag-workflow#workflowCanvas/context')
    expect(ids).toContain('@gm-hz/agent-dag-workflow#workflowCanvas/starterOrders')
    expect(ids).toContain('@gm-hz/agent-dag-workflow#workflowCanvas/listRuns')
    expect(ids).toContain('@gm-hz/agent-dag-workflow#workflowCanvas/runDetails')
    expect(ids).toContain('@gm-hz/agent-dag-workflow#workflowCanvas/exportCase')
    expect(ids).toContain('@gm-hz/agent-dag-workflow#workflowCanvas/exportEvidence')
    expect(ids).toContain('@gm-hz/agent-dag-workflow#workflowCanvas/revisions')
    expect(workflowCanvasRemote.descriptors.find(descriptor => descriptor.id.endsWith('/startRun'))?.cancellation).toBeUndefined()
    expect(workflowCanvasRemote.descriptors.find(descriptor => descriptor.id.endsWith('/run'))?.cancellation)
      .toEqual({ parameter: 'signal' })
  })
})
