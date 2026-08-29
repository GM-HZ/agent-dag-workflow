import { randomUUID } from 'node:crypto'
import type { JsonObject } from '../../core/index.js'
import type { WorkflowTriggerEnvelope } from '../core/index.js'

export interface CronTriggerOptions {
  readonly expression: string
  readonly timezone: string
  readonly sourceEventPrefix?: string
  readonly payload?: JsonObject
  readonly misfirePolicy?: 'skip' | 'fire-once'
  readonly now?: () => number
}

export function createCronTrigger(options: CronTriggerOptions) {
  validateCron(options.expression)
  new Intl.DateTimeFormat('en-US', { timeZone: options.timezone }).format(0)
  const now = options.now ?? Date.now
  return {
    matches(time: Date): boolean { return matchesCron(options.expression, zonedParts(time, options.timezone)) },
    envelope(time: Date): WorkflowTriggerEnvelope {
      const minute = Math.floor(time.getTime() / 60_000) * 60_000
      const sourceEventId = `${options.sourceEventPrefix ?? 'cron'}:${minute}`
      return {
        schemaVersion: 1,
        triggerId: randomUUID(),
        source: 'cron',
        sourceEventId,
        receivedAt: now(),
        occurredAt: minute,
        payload: options.payload ?? {},
        metadata: { expression: options.expression, timezone: options.timezone, scheduledAt: minute },
      }
    },
    dueBetween(lastCheckedExclusive: Date, current: Date): readonly WorkflowTriggerEnvelope[] {
      if (!Number.isFinite(lastCheckedExclusive.getTime()) || !Number.isFinite(current.getTime())
        || current.getTime() < lastCheckedExclusive.getTime()) throw new Error('cron scheduler window is invalid')
      const start = Math.floor(lastCheckedExclusive.getTime() / 60_000) * 60_000 + 60_000
      const end = Math.floor(current.getTime() / 60_000) * 60_000
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start - 60_000) throw new Error('cron scheduler window is invalid')
      if (end - start > 366 * 24 * 60 * 60_000) throw new Error('cron scheduler window exceeds 366 days')
      const matches: Date[] = []
      for (let value = start; value <= end; value += 60_000) {
        const candidate = new Date(value)
        if (matchesCron(options.expression, zonedParts(candidate, options.timezone))) matches.push(candidate)
      }
      const selected = options.misfirePolicy === 'fire-once'
        ? matches.slice(-1)
        : matches.filter(candidate => candidate.getTime() === end)
      return selected.map(candidate => this.envelope(candidate))
    },
  }
}

function validateCron(expression: string): void {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error('cron expression must contain five fields')
  for (const field of fields) if (!/^(\*|\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)$/.test(field)) throw new Error(`unsupported cron field: ${field}`)
}

function matchesCron(expression: string, parts: readonly number[]): boolean {
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]] as const
  return expression.trim().split(/\s+/).every((field, index) => {
    const range = ranges[index]!
    return matchesField(field!, parts[index]!, range[0], range[1])
  })
}
function matchesField(field: string, value: number, min: number, max: number): boolean {
  if (field === '*') return true
  return field.split(',').some(segment => {
    const [startText, endText] = segment.split('-')
    const start = Number(startText)
    const end = endText === undefined ? start : Number(endText)
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) throw new Error(`cron field is out of range: ${segment}`)
    return value >= start && value <= end
  })
}
function zonedParts(date: Date, timezone: string): readonly number[] {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, minute: '2-digit', hour: '2-digit', day: '2-digit', month: '2-digit', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(date).map(item => [item.type, item.value]))
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return [Number(parts.minute), Number(parts.hour), Number(parts.day), Number(parts.month), weekdays[parts.weekday!]!]
}
