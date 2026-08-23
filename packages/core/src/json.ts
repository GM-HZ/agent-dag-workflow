import type { JsonObject, JsonValue } from './types.js'

export class LosslessJsonError extends Error {
  readonly path: string

  constructor(path: string, message: string) {
    super(`${path}: ${message}`)
    this.name = 'LosslessJsonError'
    this.path = path
  }
}

export function snapshotJsonValue(value: unknown): JsonValue {
  return materialize(value, '$', new Set<object>())
}

export function snapshotJsonObject(value: unknown): JsonObject {
  const snapshot = snapshotJsonValue(value)
  if (!isJsonObject(snapshot)) throw new LosslessJsonError('$', 'expected a JSON object')
  return snapshot
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function stableJsonStringify(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(',')}]`
  if (isJsonObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJsonStringify(value[key]!)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function materialize(value: unknown, path: string, ancestors: Set<object>): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new LosslessJsonError(path, 'non-finite numbers are not JSON')
    if (Object.is(value, -0)) throw new LosslessJsonError(path, 'negative zero is not lossless JSON')
    return value
  }
  if (typeof value !== 'object') throw new LosslessJsonError(path, `${typeof value} is not JSON`)
  if (ancestors.has(value)) throw new LosslessJsonError(path, 'circular reference')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value)
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) throw new LosslessJsonError(`${path}[${index}]`, 'sparse arrays are not lossless JSON')
      }
      if (keys.some(key => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key)))) {
        throw new LosslessJsonError(path, 'arrays cannot carry custom properties')
      }
      return Object.freeze(value.map((item, index) => materialize(item, `${path}[${index}]`, ancestors)))
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throw new LosslessJsonError(path, 'expected a plain object')
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const output: JsonObject = Object.create(null) as JsonObject
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') throw new LosslessJsonError(path, 'symbol keys are not JSON')
      const descriptor = descriptors[key]!
      if (!descriptor.enumerable) throw new LosslessJsonError(`${path}.${key}`, 'non-enumerable properties are not lossless JSON')
      if (!('value' in descriptor)) throw new LosslessJsonError(`${path}.${key}`, 'accessor properties are not lossless JSON')
      output[key] = materialize(descriptor.value, `${path}.${key}`, ancestors)
    }
    return Object.freeze(output)
  } finally {
    ancestors.delete(value)
  }
}
