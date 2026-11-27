import { useCallback, useEffect, useRef, useState } from 'react'
import type { CanvasTrace } from '../types.js'
import type { WorkflowCanvasClientApi } from './api.js'
import { classifyWorkflowError } from './ux.js'

interface TraceRead {
  readonly runId: string
  trace?: CanvasTrace
  reading: boolean
  olderLoaded: boolean
}

/** Watches an ascending trace or a filtered recent window of the same journal. */
export function useRunWatch(api: WorkflowCanvasClientApi, sessionId: string, runId: string | undefined, limit = 100, query?: {
  readonly window: 'recent'
  readonly nodeId?: string
  readonly failuresOnly?: boolean
}) {
  const current = useRef<TraceRead>()
  const [trace, setTrace] = useState<CanvasTrace>()
  const [error, setError] = useState<unknown>()
  const [reading, setReading] = useState(false)
  const [loaded, setLoaded] = useState<string>()
  const eventWindow = query?.window
  const nodeId = query?.nodeId
  const failuresOnly = query?.failuresOnly
  const key = JSON.stringify([sessionId, runId, eventWindow, nodeId, failuresOnly])
  const traceSession = useRef<string>()

  const read = useCallback(async (reset = false, older = false) => {
    const monitor = current.current
    if (monitor === undefined || monitor.reading) return
    const previous = reset ? undefined : monitor.trace
    const beforeSeq = older ? previous?.nextBeforeSeq : undefined
    if (older && beforeSeq === undefined) return
    monitor.reading = true
    setReading(true)
    try {
      const last = eventWindow === undefined ? previous?.events.at(-1)?.seq : undefined
      const afterSeq = typeof last === 'number' ? last : undefined
      const page = await api.request('workflowCanvas.trace', () => api.remote.trace(sessionId, {
        runId: monitor.runId, limit, ...(afterSeq === undefined ? {} : { afterSeq }),
        ...(eventWindow === undefined ? {} : { window: eventWindow }), ...(beforeSeq === undefined ? {} : { beforeSeq }),
        ...(nodeId === undefined ? {} : { nodeId }), ...(failuresOnly === true ? { failuresOnly } : {}),
      }), { retries: 1 })
      if (current.current !== monitor) return
      if (page.runId !== monitor.runId) throw new Error('Trace returned a different run')
      if (previous === undefined) {
        monitor.trace = page
        monitor.olderLoaded = false
      } else if (eventWindow === undefined) {
        monitor.trace = { ...page, events: [...previous.events, ...page.events] }
      } else if (older) {
        monitor.trace = { ...page, events: [...page.events, ...previous.events] }
        monitor.olderLoaded = true
      } else {
        const first = page.events[0]?.seq
        const lastShown = previous.events.at(-1)?.seq
        if (monitor.olderLoaded && typeof first === 'number' && typeof lastShown === 'number' && first <= lastShown) {
          const { nextBeforeSeq: _next, ...latest } = page
          monitor.trace = {
            ...latest, events: [...previous.events.filter(event => typeof event.seq === 'number' && event.seq < first), ...page.events],
            ...(previous.nextBeforeSeq === undefined ? {} : { nextBeforeSeq: previous.nextBeforeSeq }),
          }
        } else {
          monitor.trace = page
          monitor.olderLoaded = false
        }
      }
      traceSession.current = sessionId
      setTrace(monitor.trace)
      setLoaded(key)
      setError(undefined)
    } catch (cause: unknown) {
      if (current.current === monitor) setError(cause)
    } finally {
      monitor.reading = false
      if (current.current === monitor) setReading(false)
    }
  }, [api, eventWindow, failuresOnly, key, limit, nodeId, sessionId])
  const readOlder = useCallback(() => read(false, true), [read])

  useEffect(() => {
    const monitor = runId === undefined ? undefined : { runId, reading: false, olderLoaded: false }
    current.current = monitor
    setTrace(value => {
      if (eventWindow === undefined || value === undefined || value.runId !== runId || traceSession.current !== sessionId) return undefined
      const { nextAfterSeq: _after, nextBeforeSeq: _before, ...snapshot } = value
      return { ...snapshot, events: [] }
    })
    setError(undefined)
    setLoaded(undefined)
    setReading(false)
    if (monitor !== undefined) void read()
    return () => { if (current.current === monitor) current.current = undefined }
  }, [eventWindow, read, runId, sessionId])

  useEffect(() => {
    const monitor = current.current
    if (monitor === undefined || reading || (trace !== undefined && (trace.status !== 'running' || trace.active === false))) return
    if (eventWindow !== undefined && trace === undefined && error !== undefined && !classifyWorkflowError(error).retryable) return
    const timer = setTimeout(() => { void read() }, error === undefined ? 900 : 2_500)
    return () => clearTimeout(timer)
  }, [error, eventWindow, read, reading, trace])

  useEffect(() => {
    const reconnect = () => { if (document.visibilityState === 'visible') void read() }
    window.addEventListener('online', reconnect)
    document.addEventListener('visibilitychange', reconnect)
    return () => {
      window.removeEventListener('online', reconnect)
      document.removeEventListener('visibilitychange', reconnect)
    }
  }, [read])

  return { trace: trace?.runId === runId && traceSession.current === sessionId ? trace : undefined, error, reading, ready: loaded === key, read, readOlder }
}

export function useRunStop(api: WorkflowCanvasClientApi, sessionId: string, runId: string | undefined) {
  type StopState = { runId: string; phase: 'requesting' | 'cancelled' | 'finished' }
  const requests = useRef(new Set<string>())
  const [state, setState] = useState<StopState>()
  const phase = state?.runId === runId ? state?.phase : undefined
  const stop = useCallback(async (id: string, reason: string) => {
    if (requests.current.has(id)) return
    requests.current.add(id)
    setState({ runId: id, phase: 'requesting' })
    try {
      const result = await api.request('workflowCanvas.cancel', () => api.remote.cancel(sessionId, { runId: id, reason }))
      setState(current => current?.runId !== id ? current : { runId: id, phase: result.status === 'cancelled' ? 'cancelled' : 'finished' })
      return result
    } catch (cause: unknown) {
      setState(current => current?.runId === id ? undefined : current)
      throw cause
    } finally { requests.current.delete(id) }
  }, [api, sessionId])
  return { phase, stop }
}
