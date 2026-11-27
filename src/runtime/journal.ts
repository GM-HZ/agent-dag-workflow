import type { WorkflowEvent, WorkflowRunEventWindow, WorkflowRunStore } from '../core/index.js'
import { matchesWorkflowEventWindow } from '../core/run-store.js'
import type { WorkflowEventPage, WorkflowEventQuery } from './types.js'

type JournalStore = Pick<WorkflowRunStore, 'readEvents' | 'queryEvents'>

export async function readWorkflowEventPage(
  store: JournalStore,
  runId: string,
  query: WorkflowEventQuery = {},
): Promise<WorkflowEventPage> {
  const afterSeq = query.afterSeq ?? 0
  const { throughSeq, beforeSeq, nodeId, failuresOnly } = query
  const recent = query.window === 'recent'
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new Error('afterSeq must be a non-negative safe integer')
  if (throughSeq !== undefined && (!Number.isSafeInteger(throughSeq) || throughSeq < 0)) {
    throw new Error('throughSeq must be a non-negative safe integer')
  }
  if (query.window !== undefined && !recent) throw new Error('unsupported Journal window')
  if (beforeSeq !== undefined && (!recent || !Number.isSafeInteger(beforeSeq) || beforeSeq < 1)) {
    throw new Error('beforeSeq must be a positive safe integer for recent Journal pages')
  }
  if (recent && query.afterSeq !== undefined) throw new Error('afterSeq is available only for forward Journal pages')
  if (nodeId !== undefined && (nodeId.length === 0 || nodeId.length > 512)) throw new Error('Journal nodeId must contain 1–512 characters')
  if ((throughSeq !== undefined && throughSeq <= afterSeq) || beforeSeq === 1) return { events: [] }
  const limit = query.limit ?? 100
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error('Journal limit must be between 1 and 1000')

  const window = {
    afterSeq, limit: limit + 1, descending: recent,
    ...(throughSeq === undefined ? {} : { throughSeq }),
    ...(beforeSeq === undefined ? {} : { beforeSeq }),
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(failuresOnly === undefined ? {} : { failuresOnly }),
  }
  const ordered = store.queryEvents === undefined
    ? await readLegacyWindow(store, runId, window)
    : await store.queryEvents(runId, window)
  const page = ordered.slice(0, limit)
  const boundary = page.at(-1)?.seq
  const more = ordered.length > limit && boundary !== undefined
  return recent
    ? { events: page.reverse(), ...(more ? { nextBeforeSeq: boundary } : {}) }
    : { events: page, ...(more ? { nextAfterSeq: boundary } : {}) }
}

async function readLegacyWindow(store: JournalStore, runId: string, window: WorkflowRunEventWindow): Promise<readonly WorkflowEvent[]> {
  if (!window.descending && window.nodeId === undefined && window.failuresOnly !== true) {
    const rows = await store.readEvents(runId, { afterSeq: window.afterSeq, limit: window.limit })
    return rows.filter(event => matchesWorkflowEventWindow(event, window))
  }
  let afterSeq = window.afterSeq
  const upper = Math.min(window.throughSeq ?? Number.MAX_SAFE_INTEGER, window.beforeSeq === undefined ? Number.MAX_SAFE_INTEGER : window.beforeSeq - 1)
  const selected: WorkflowEvent[] = []
  while (afterSeq < upper) {
    const rows = await store.readEvents(runId, { afterSeq, limit: 500 })
    for (const event of rows) {
      if (!matchesWorkflowEventWindow(event, window)) continue
      selected.push(event)
      if (!window.descending && selected.length === window.limit) return selected
    }
    if (selected.length > window.limit) selected.splice(0, selected.length - window.limit)
    const last = rows.at(-1)?.seq
    if (last === undefined || last <= afterSeq) break
    afterSeq = last
  }
  return window.descending ? selected.reverse() : selected
}
