import type { WorkflowLiveEvent } from './types.js'

export class WorkflowLiveEventBus {
  readonly #subscribers = new Map<string, Set<LiveQueue>>()

  constructor(readonly maxBufferedEvents = 256) {
    if (!Number.isSafeInteger(maxBufferedEvents) || maxBufferedEvents <= 0) {
      throw new Error('maxBufferedEvents must be a positive safe integer')
    }
  }

  publish(event: WorkflowLiveEvent): void {
    for (const queue of this.#subscribers.get(event.runId) ?? []) queue.push(event)
  }

  close(runId: string): void {
    for (const queue of this.#subscribers.get(runId) ?? []) queue.close()
    this.#subscribers.delete(runId)
  }

  subscribe(runId: string, signal?: AbortSignal): AsyncIterable<WorkflowLiveEvent> {
    const queue = new LiveQueue(() => {
      const subscribers = this.#subscribers.get(runId)
      subscribers?.delete(queue)
      if (subscribers?.size === 0) this.#subscribers.delete(runId)
    }, this.maxBufferedEvents, signal)
    const subscribers = this.#subscribers.get(runId) ?? new Set<LiveQueue>()
    subscribers.add(queue)
    this.#subscribers.set(runId, subscribers)
    return queue
  }
}

class LiveQueue implements AsyncIterable<WorkflowLiveEvent>, AsyncIterator<WorkflowLiveEvent> {
  readonly #values: WorkflowLiveEvent[] = []
  readonly #waiters: Array<(result: IteratorResult<WorkflowLiveEvent>) => void> = []
  #closed = false

  constructor(private readonly dispose: () => void, private readonly maxBufferedEvents: number, signal?: AbortSignal) {
    if (signal?.aborted === true) this.close()
    else signal?.addEventListener('abort', () => this.close(), { once: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<WorkflowLiveEvent> { return this }

  next(): Promise<IteratorResult<WorkflowLiveEvent>> {
    const value = this.#values.shift()
    if (value !== undefined) return Promise.resolve({ done: false, value })
    if (this.#closed) return Promise.resolve({ done: true, value: undefined })
    return new Promise(resolve => { this.#waiters.push(resolve) })
  }

  push(value: WorkflowLiveEvent): void {
    if (this.#closed) return
    const waiter = this.#waiters.shift()
    if (waiter === undefined) {
      if (this.#values.length >= this.maxBufferedEvents) this.#values.shift()
      this.#values.push(value)
    }
    else waiter({ done: false, value })
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.dispose()
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined })
  }
}
