import { describe, expect, it } from 'vitest'
import { canLaunchWorkflowCanvas, retainWorkflowCanvasSession } from '../../src/canvas/client/overlay.js'

describe('Workflow Canvas overlay authority session', () => {
  it('retains the parent session while a child Agent becomes current', () => {
    const parent = retainWorkflowCanvasSession(true, 'parent-session', undefined)

    expect(parent).toBe('parent-session')
    expect(retainWorkflowCanvasSession(true, 'child-session', parent)).toBe('parent-session')
  })

  it('releases the retained session when Studio closes', () => {
    expect(retainWorkflowCanvasSession(false, 'child-session', 'parent-session')).toBeUndefined()
    expect(retainWorkflowCanvasSession(true, 'next-parent', undefined)).toBe('next-parent')
  })

  it('keeps the launcher enabled for a current session while Studio is closed', () => {
    expect(canLaunchWorkflowCanvas('parent-session')).toBe(true)
    expect(canLaunchWorkflowCanvas(undefined)).toBe(false)
  })
})
