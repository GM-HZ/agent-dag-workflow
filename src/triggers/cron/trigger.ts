import { randomUUID } from 'node:crypto'
import { snapshotJsonObject, type JsonObject } from '../../core/index.js'
import type { WorkflowTriggerDefinition, WorkflowTriggerEnvelope } from '../core/index.js'

export const CRON_MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * CRON_MINUTE_MS
const MAX_PREVIEW_MS = 8 * 366 * DAY_MS
const MAX_WINDOW_MS = 366 * DAY_MS
const DAY_OPTIONS = ['all', 'cron'] as const

export interface CronTriggerOptions {
  readonly expression: string
  readonly timezone: string
  readonly sourceEventPrefix?: string
  readonly payload?: JsonObject
  readonly misfirePolicy?: 'skip' | 'fire-once'
  /** `all` requires both day fields. `cron` accepts either when both are restricted. */
  readonly dayMatch?: typeof DAY_OPTIONS[number]
  readonly now?: () => number
}

type CronBindingOptions = CronTriggerOptions & { readonly overlapPolicy?: 'skip' | 'allow' }

export const CRON_TRIGGER_DEFINITION: WorkflowTriggerDefinition = {
  uses: 'cron@1',
  configSchema: {
    type: 'object', additionalProperties: false, required: ['expression', 'timezone'],
    properties: {
      expression: { type: 'string', minLength: 1, maxLength: 512 },
      timezone: { type: 'string', minLength: 1, maxLength: 128 },
      payload: { type: 'object' },
      misfirePolicy: { enum: ['skip', 'fire-once'] },
      overlapPolicy: { enum: ['skip', 'allow'] },
      dayMatch: { enum: DAY_OPTIONS },
    },
  },
  validateConfig(config) {
    try { createCronTrigger(readCronBindingOptions(config)); return [] }
    catch (error: unknown) { return [error instanceof Error ? error.message : String(error)] }
  },
}

export function readCronBindingOptions(config: JsonObject): CronBindingOptions {
  const { expression, timezone, payload, misfirePolicy, overlapPolicy, dayMatch } = config
  if (typeof expression !== 'string' || typeof timezone !== 'string') throw new Error('cron binding requires an expression and timezone')
  if (overlapPolicy !== undefined && overlapPolicy !== 'skip' && overlapPolicy !== 'allow') throw new Error('invalid cron overlap policy')
  if (misfirePolicy !== undefined && misfirePolicy !== 'skip' && misfirePolicy !== 'fire-once') throw new Error('invalid cron misfire policy')
  if (dayMatch !== undefined && dayMatch !== 'all' && dayMatch !== 'cron') throw new Error('invalid cron day matching policy')
  return {
    expression, timezone,
    ...(payload === undefined ? {} : { payload: snapshotJsonObject(payload) }),
    ...(misfirePolicy === undefined ? {} : { misfirePolicy }),
    ...(overlapPolicy === undefined ? {} : { overlapPolicy }),
    ...(dayMatch === undefined ? {} : { dayMatch }),
  }
}

export function createCronTrigger(options: CronTriggerOptions) {
  const expression = options.expression.trim()
  const matchDay = options.dayMatch ?? 'all'
  const calendar = parseCronExpression(expression)
  const eitherDay = matchDay === 'cron' && !calendar.day.wildcard && !calendar.weekday.wildcard
  const maximumDays = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (!eitherDay && Math.min(...calendar.day.values) > Math.max(...[...calendar.month.values].map(month => maximumDays[month - 1]!))) {
    throw new Error('cron day cannot match the selected months')
  }
  const formatter = createFormatter(options.timezone)
  const utc = formatter.resolvedOptions().timeZone === 'UTC'
  const readParts = utc ? utcParts : (date: Date) => zonedParts(date, formatter)
  const now = options.now ?? Date.now
  const payload = snapshotJsonObject(options.payload ?? {})
  function matchesDate(day: number, month: number, weekday: number): boolean {
    if (!calendar.month.values.has(month)) return false
    const dayMatches = calendar.day.values.has(day)
    const weekdayMatches = calendar.weekday.values.has(weekday)
    return eitherDay ? dayMatches || weekdayMatches : dayMatches && weekdayMatches
  }
  const matches = (time: Date): boolean => {
    const [minute, hour, day, month, weekday] = readParts(time)
    return calendar.minute.values.has(minute) && calendar.hour.values.has(hour) && matchesDate(day, month, weekday)
  }

  function dayMayMatch(utcDay: number): boolean {
    // Time-zone offsets are less than 24 hours. Keeping both adjacent dates
    // preserves date-line transitions, gaps and repeated local times.
    const possibleDates = utc ? [utcDay] : [utcDay - DAY_MS, utcDay, utcDay + DAY_MS]
    return possibleDates.some(time => {
      const date = new Date(time)
      return matchesDate(date.getUTCDate(), date.getUTCMonth() + 1, date.getUTCDay())
    })
  }

  function searchMinutes(first: number, last: number, direction: 1 | -1): Date | undefined {
    let candidateDay: number | undefined
    let minute = first
    while ((last - minute) * direction >= 0) {
      const date = new Date(minute)
      if (!Number.isFinite(date.getTime())) return undefined
      const utcDay = Math.floor(minute / DAY_MS) * DAY_MS
      if (candidateDay !== utcDay) {
        if (!dayMayMatch(utcDay)) {
          minute = direction === 1 ? utcDay + DAY_MS : utcDay - CRON_MINUTE_MS
          continue
        }
        candidateDay = utcDay
      }
      if (matches(date)) return date
      minute += direction * CRON_MINUTE_MS
    }
  }
  function envelope(time: Date): WorkflowTriggerEnvelope {
    const minute = cronMinute(time.getTime())
    return {
      schemaVersion: 1,
      triggerId: randomUUID(),
      source: 'cron',
      sourceEventId: `${options.sourceEventPrefix ?? 'cron'}:${minute}`,
      receivedAt: now(),
      occurredAt: minute,
      payload,
      metadata: { expression, timezone: options.timezone, scheduledAt: minute },
    }
  }
  function latestRunAt(current: Date, afterExclusive: Date): Date | undefined {
    const end = cronMinute(current.getTime())
    const start = cronMinute(afterExclusive.getTime())
    const bound = Math.max(start, end - MAX_PREVIEW_MS)
    return searchMinutes(end, bound + CRON_MINUTE_MS, -1)
  }
  return {
    matches,
    envelope,
    /** UTC minute strictly after `after`, searched over the following eight years. */
    nextRunAt(after: Date): Date | undefined {
      const start = cronMinute(after.getTime())
      return searchMinutes(start + CRON_MINUTE_MS, start + MAX_PREVIEW_MS, 1)
    },
    latestRunAt,
    dueBetween(lastCheckedExclusive: Date, current: Date): readonly WorkflowTriggerEnvelope[] {
      const checkedAt = lastCheckedExclusive.getTime()
      const currentAt = current.getTime()
      if (!Number.isFinite(checkedAt) || !Number.isFinite(currentAt) || currentAt < checkedAt) throw new Error('cron scheduler window is invalid')
      const start = cronMinute(checkedAt)
      const end = cronMinute(currentAt)
      if (end - start - CRON_MINUTE_MS > MAX_WINDOW_MS) throw new Error('cron scheduler window exceeds 366 days')
      if (end <= start) return []
      const candidate = new Date(end)
      const selected = options.misfirePolicy === 'fire-once'
        ? latestRunAt(candidate, lastCheckedExclusive)
        : matches(candidate) ? candidate : undefined
      return selected === undefined ? [] : [envelope(selected)]
    },
  }
}

export function cronMinute(time: number): number {
  if (!Number.isSafeInteger(time) || !Number.isFinite(new Date(time).getTime())) throw new Error('cron schedule time is invalid')
  return Math.floor(time / CRON_MINUTE_MS) * CRON_MINUTE_MS
}

function createFormatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, minute: '2-digit', hour: '2-digit', day: '2-digit', month: '2-digit', weekday: 'short', hourCycle: 'h23',
  })
}

function utcParts(date: Date): readonly [number, number, number, number, number] {
  return [date.getUTCMinutes(), date.getUTCHours(), date.getUTCDate(), date.getUTCMonth() + 1, date.getUTCDay()]
}

const WEEKDAYS = new Map(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, index) => [day, index]))
function zonedParts(date: Date, formatter: Intl.DateTimeFormat): readonly [number, number, number, number, number] {
  const parts = Object.fromEntries(formatter.formatToParts(date).map(item => [item.type, item.value]))
  return [Number(parts.minute), Number(parts.hour), Number(parts.day), Number(parts.month), WEEKDAYS.get(parts.weekday!)!]
}

function parseCronExpression(expression: string) {
  if (expression.length > 512) throw new Error('cron expression exceeds 512 characters')
  const fields = expression.split(/\s+/)
  if (fields.length !== 5) throw new Error('cron expression must contain five fields')
  return {
    minute: parseField(fields[0]!, 'minute', 0, 59), hour: parseField(fields[1]!, 'hour', 0, 23),
    day: parseField(fields[2]!, 'day', 1, 31), month: parseField(fields[3]!, 'month', 1, 12),
    weekday: parseField(fields[4]!, 'weekday', 0, 7),
  }
}

function parseField(field: string, name: string, min: number, max: number) {
  const values = new Set<number>()
  for (const segment of field.split(',')) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(segment)
    if (match === null) throw new Error(`unsupported cron ${name} field: ${segment}`)
    const range = match[1]!
    const [lower, upper] = range === '*' ? [min, max] : range.split('-').map(Number)
    const start = lower!
    const end = upper ?? (match[2] === undefined ? start : max)
    const step = match[2] === undefined ? 1 : Number(match[2])
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < min || end > max || start > end) {
      throw new Error(`cron ${name} field is out of range: ${segment}`)
    }
    if (!Number.isSafeInteger(step) || step < 1 || step > max - min + 1) throw new Error(`invalid cron ${name} step: ${segment}`)
    for (let value = start; value <= end; value += step) values.add(name === 'weekday' && value === 7 ? 0 : value)
  }
  return { values, wildcard: values.size === (name === 'weekday' ? 7 : max - min + 1) }
}
