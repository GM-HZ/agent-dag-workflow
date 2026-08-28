import { snapshotJsonObject, snapshotJsonValue, stableJsonStringify } from './json.js'
import type { JsonObject, JsonValue } from './types.js'

type TokenKind = 'number' | 'string' | 'identifier' | 'symbol' | 'eof'

interface Token {
  readonly kind: TokenKind
  readonly value: string
  readonly offset: number
}

type Expression =
  | { readonly type: 'literal'; readonly value: JsonValue }
  | { readonly type: 'input' }
  | { readonly type: 'array'; readonly items: readonly Expression[] }
  | { readonly type: 'object'; readonly entries: readonly { readonly key: string; readonly value: Expression }[] }
  | { readonly type: 'member'; readonly object: Expression; readonly property: Expression }
  | { readonly type: 'call'; readonly name: string; readonly args: readonly Expression[] }
  | { readonly type: 'unary'; readonly operator: '!' | '-'; readonly argument: Expression }
  | { readonly type: 'binary'; readonly operator: string; readonly left: Expression; readonly right: Expression }
  | { readonly type: 'conditional'; readonly test: Expression; readonly consequent: Expression; readonly alternate: Expression }

export class WorkflowExpressionSyntaxError extends Error {
  constructor(message: string, readonly offset: number) {
    super(`${message} at offset ${offset}`)
    this.name = 'WorkflowExpressionSyntaxError'
  }
}

export class WorkflowExpressionExecutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowExpressionExecutionError'
  }
}

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const BUILTINS = new Set([
  'len', 'upper', 'lower', 'trim', 'join', 'split', 'concat', 'slice',
  'coalesce', 'string', 'number', 'boolean', 'keys', 'values', 'get', 'has',
  'sum', 'min', 'max', 'unique', 'sort', 'sortBy', 'withIndex', 'joinBy', 'mapGet', 'filterEq', 'json',
  'parseJson', 'format',
])

export function validateWorkflowExpression(source: string): readonly string[] {
  try {
    parseWorkflowExpression(source)
    return []
  } catch (error: unknown) {
    return [error instanceof Error ? error.message : String(error)]
  }
}

export function evaluateWorkflowExpression(
  source: string,
  inputs: JsonObject,
  options: { readonly signal: AbortSignal; readonly maxOperations: number },
): JsonObject {
  const expression = parseWorkflowExpression(source)
  const budget = { remaining: options.maxOperations, signal: options.signal }
  const value = evaluate(expression, inputs, budget)
  if (!isObject(value)) throw new WorkflowExpressionExecutionError('script result must be a JSON object')
  return snapshotJsonObject(value)
}

export function parseWorkflowExpression(source: string): Expression {
  if (source.trim().length === 0) throw new WorkflowExpressionSyntaxError('expression is empty', 0)
  const parser = new Parser(tokenize(source))
  return parser.parse()
}

function tokenize(source: string): readonly Token[] {
  const tokens: Token[] = []
  let offset = 0
  while (offset < source.length) {
    const char = source[offset]!
    if (/\s/u.test(char)) { offset++; continue }
    if (char === '"' || char === "'") {
      const start = offset
      const quote = char
      offset++
      let value = ''
      let closed = false
      while (offset < source.length) {
        const current = source[offset++]!
        if (current === quote) { closed = true; break }
        if (current !== '\\') { value += current; continue }
        if (offset >= source.length) break
        const escaped = source[offset++]!
        const escapes: Readonly<Record<string, string>> = {
          n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '\\': '\\', '"': '"', "'": "'", '/': '/',
        }
        if (escaped === 'u') {
          const hex = source.slice(offset, offset + 4)
          if (!/^[0-9a-fA-F]{4}$/u.test(hex)) throw new WorkflowExpressionSyntaxError('invalid unicode escape', offset - 2)
          value += String.fromCharCode(Number.parseInt(hex, 16))
          offset += 4
        } else if (escaped in escapes) value += escapes[escaped]!
        else throw new WorkflowExpressionSyntaxError(`unsupported escape \\${escaped}`, offset - 2)
      }
      if (!closed) throw new WorkflowExpressionSyntaxError('unterminated string', start)
      tokens.push({ kind: 'string', value, offset: start })
      continue
    }
    const number = source.slice(offset).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u)?.[0]
    if (number !== undefined) {
      tokens.push({ kind: 'number', value: number, offset })
      offset += number.length
      continue
    }
    const identifier = source.slice(offset).match(/^[A-Za-z_][A-Za-z0-9_]*/u)?.[0]
    if (identifier !== undefined) {
      tokens.push({ kind: 'identifier', value: identifier, offset })
      offset += identifier.length
      continue
    }
    const operator = ['===', '!==', '>=', '<=', '==', '!=', '&&', '||', '??'].find(candidate => source.startsWith(candidate, offset))
    if (operator !== undefined) {
      tokens.push({ kind: 'symbol', value: operator, offset })
      offset += operator.length
      continue
    }
    if ('()[]{},.:?+-*/%!<>'.includes(char)) {
      tokens.push({ kind: 'symbol', value: char, offset })
      offset++
      continue
    }
    throw new WorkflowExpressionSyntaxError(`unexpected character ${JSON.stringify(char)}`, offset)
  }
  tokens.push({ kind: 'eof', value: '', offset: source.length })
  return tokens
}

class Parser {
  #cursor = 0
  #depth = 0

  constructor(private readonly tokens: readonly Token[]) {}

  parse(): Expression {
    const expression = this.parseConditional()
    this.expect('eof')
    return expression
  }

  private parseConditional(): Expression {
    const test = this.parseBinary(0)
    if (!this.match('?')) return test
    const consequent = this.parseConditional()
    this.expectSymbol(':')
    return { type: 'conditional', test, consequent, alternate: this.parseConditional() }
  }

  private parseBinary(minPrecedence: number): Expression {
    let left = this.parseUnary()
    while (true) {
      const operator = this.current().value
      const precedence = BINARY_PRECEDENCE[operator]
      if (precedence === undefined || precedence < minPrecedence) return left
      this.#cursor++
      const right = this.parseBinary(precedence + 1)
      left = { type: 'binary', operator, left, right }
    }
  }

  private parseUnary(): Expression {
    const token = this.current()
    if (token.value === '!' || token.value === '-') {
      this.#cursor++
      return { type: 'unary', operator: token.value, argument: this.parseUnary() }
    }
    return this.parseMember()
  }

  private parseMember(): Expression {
    let expression = this.parsePrimary()
    while (true) {
      if (this.match('.')) {
        const property = this.expect('identifier')
        assertSafeKey(property.value, property.offset)
        expression = { type: 'member', object: expression, property: { type: 'literal', value: property.value } }
        continue
      }
      if (this.match('[')) {
        const property = this.nested(() => this.parseConditional())
        this.expectSymbol(']')
        expression = { type: 'member', object: expression, property }
        continue
      }
      return expression
    }
  }

  private parsePrimary(): Expression {
    const token = this.current()
    if (token.kind === 'number') {
      this.#cursor++
      const value = Number(token.value)
      if (!Number.isFinite(value)) throw new WorkflowExpressionSyntaxError('number must be finite', token.offset)
      return { type: 'literal', value }
    }
    if (token.kind === 'string') { this.#cursor++; return { type: 'literal', value: token.value } }
    if (token.kind === 'identifier') {
      this.#cursor++
      if (token.value === 'true') return { type: 'literal', value: true }
      if (token.value === 'false') return { type: 'literal', value: false }
      if (token.value === 'null') return { type: 'literal', value: null }
      if (token.value === 'input') return { type: 'input' }
      if (!this.match('(')) throw new WorkflowExpressionSyntaxError(`unknown identifier ${token.value}`, token.offset)
      if (!BUILTINS.has(token.value)) throw new WorkflowExpressionSyntaxError(`unknown function ${token.value}`, token.offset)
      const args = this.parseDelimited(')')
      return { type: 'call', name: token.value, args }
    }
    if (this.match('(')) {
      const expression = this.nested(() => this.parseConditional())
      this.expectSymbol(')')
      return expression
    }
    if (this.match('[')) return { type: 'array', items: this.parseDelimited(']') }
    if (this.match('{')) return this.parseObject()
    throw new WorkflowExpressionSyntaxError('expected expression', token.offset)
  }

  private parseObject(): Expression {
    const entries: { key: string; value: Expression }[] = []
    if (this.match('}')) return { type: 'object', entries }
    while (true) {
      const token = this.current()
      if (token.kind !== 'identifier' && token.kind !== 'string') throw new WorkflowExpressionSyntaxError('expected object key', token.offset)
      this.#cursor++
      assertSafeKey(token.value, token.offset)
      this.expectSymbol(':')
      entries.push({ key: token.value, value: this.nested(() => this.parseConditional()) })
      if (this.match('}')) return { type: 'object', entries }
      this.expectSymbol(',')
      if (this.match('}')) return { type: 'object', entries }
    }
  }

  private parseDelimited(end: string): readonly Expression[] {
    const values: Expression[] = []
    if (this.match(end)) return values
    while (true) {
      values.push(this.nested(() => this.parseConditional()))
      if (this.match(end)) return values
      this.expectSymbol(',')
      if (this.match(end)) return values
    }
  }

  private nested<T>(operation: () => T): T {
    if (++this.#depth > 64) throw new WorkflowExpressionSyntaxError('expression nesting exceeds 64', this.current().offset)
    try { return operation() } finally { this.#depth-- }
  }

  private current(): Token { return this.tokens[this.#cursor] ?? this.tokens[this.tokens.length - 1]! }

  private match(value: string): boolean {
    if (this.current().value !== value) return false
    this.#cursor++
    return true
  }

  private expect(kind: TokenKind): Token {
    const token = this.current()
    if (token.kind !== kind) throw new WorkflowExpressionSyntaxError(`expected ${kind}`, token.offset)
    this.#cursor++
    return token
  }

  private expectSymbol(value: string): void {
    const token = this.current()
    if (token.value !== value) throw new WorkflowExpressionSyntaxError(`expected ${value}`, token.offset)
    this.#cursor++
  }
}

const BINARY_PRECEDENCE: Readonly<Record<string, number>> = {
  '??': 1,
  '||': 2,
  '&&': 3,
  '==': 4, '!=': 4, '===': 4, '!==': 4,
  '>': 5, '>=': 5, '<': 5, '<=': 5,
  '+': 6, '-': 6,
  '*': 7, '/': 7, '%': 7,
}

function evaluate(expression: Expression, input: JsonObject, budget: { remaining: number; readonly signal: AbortSignal }): JsonValue {
  spend(budget)
  switch (expression.type) {
    case 'literal': return expression.value
    case 'input': return input
    case 'array': return expression.items.map(item => evaluate(item, input, budget))
    case 'object': {
      const result: JsonObject = {}
      for (const entry of expression.entries) result[entry.key] = evaluate(entry.value, input, budget)
      return result
    }
    case 'member': {
      const object = evaluate(expression.object, input, budget)
      const property = evaluate(expression.property, input, budget)
      return readMember(object, property)
    }
    case 'call': return callBuiltin(expression.name, expression.args.map(argument => evaluate(argument, input, budget)), budget)
    case 'unary': {
      const argument = evaluate(expression.argument, input, budget)
      return expression.operator === '!' ? !truthy(argument) : -requireNumber(argument, 'unary -')
    }
    case 'binary': return evaluateBinary(expression, input, budget)
    case 'conditional': return truthy(evaluate(expression.test, input, budget))
      ? evaluate(expression.consequent, input, budget)
      : evaluate(expression.alternate, input, budget)
  }
}

function evaluateBinary(
  expression: Extract<Expression, { type: 'binary' }>,
  input: JsonObject,
  budget: { remaining: number; readonly signal: AbortSignal },
): JsonValue {
  const left = evaluate(expression.left, input, budget)
  if (expression.operator === '&&') return truthy(left) ? evaluate(expression.right, input, budget) : left
  if (expression.operator === '||') return truthy(left) ? left : evaluate(expression.right, input, budget)
  if (expression.operator === '??') return left === null ? evaluate(expression.right, input, budget) : left
  const right = evaluate(expression.right, input, budget)
  switch (expression.operator) {
    case '==': case '===': return equalJson(left, right)
    case '!=': case '!==': return !equalJson(left, right)
    case '+':
      if (typeof left === 'number' && typeof right === 'number') return finite(left + right, '+')
      if (typeof left === 'string' && typeof right === 'string') return left + right
      throw new WorkflowExpressionExecutionError('+ requires two numbers or two strings')
    case '-': return finite(requireNumber(left, '-') - requireNumber(right, '-'), '-')
    case '*': return finite(requireNumber(left, '*') * requireNumber(right, '*'), '*')
    case '/': {
      const divisor = requireNumber(right, '/')
      if (divisor === 0) throw new WorkflowExpressionExecutionError('division by zero')
      return finite(requireNumber(left, '/') / divisor, '/')
    }
    case '%': {
      const divisor = requireNumber(right, '%')
      if (divisor === 0) throw new WorkflowExpressionExecutionError('division by zero')
      return finite(requireNumber(left, '%') % divisor, '%')
    }
    case '>': return compare(left, right) > 0
    case '>=': return compare(left, right) >= 0
    case '<': return compare(left, right) < 0
    case '<=': return compare(left, right) <= 0
    default: throw new WorkflowExpressionExecutionError(`unsupported operator ${expression.operator}`)
  }
}

function callBuiltin(name: string, args: readonly JsonValue[], budget: { remaining: number; readonly signal: AbortSignal }): JsonValue {
  spend(budget, Math.max(1, args.length))
  switch (name) {
    case 'len': {
      arity(name, args, 1, 1)
      const value = args[0]!
      if (typeof value === 'string' || Array.isArray(value)) return value.length
      if (isObject(value)) return Object.keys(value).length
      throw new WorkflowExpressionExecutionError('len requires a string, array, or object')
    }
    case 'upper': return requireStringArg(name, args).toUpperCase()
    case 'lower': return requireStringArg(name, args).toLowerCase()
    case 'trim': return requireStringArg(name, args).trim()
    case 'join': {
      arity(name, args, 1, 2)
      const values = requireArray(args[0], name)
      const separator = args.length === 2 ? requireString(args[1], name) : ','
      return values.map(renderScalar).join(separator)
    }
    case 'split': {
      arity(name, args, 2, 2)
      return requireString(args[0], name).split(requireString(args[1], name))
    }
    case 'concat': {
      arity(name, args, 1)
      if (args.every(Array.isArray)) return args.flatMap(item => item as readonly JsonValue[])
      if (args.every(item => typeof item === 'string')) return (args as readonly string[]).join('')
      throw new WorkflowExpressionExecutionError('concat requires only arrays or only strings')
    }
    case 'slice': {
      arity(name, args, 2, 3)
      const start = requireInteger(args[1], name)
      const end = args.length === 3 ? requireInteger(args[2], name) : undefined
      const value = args[0]
      if (typeof value === 'string') return value.slice(start, end)
      if (Array.isArray(value)) return value.slice(start, end)
      throw new WorkflowExpressionExecutionError('slice requires a string or array')
    }
    case 'coalesce': {
      arity(name, args, 1)
      return args.find(item => item !== null) ?? null
    }
    case 'string': { arity(name, args, 1, 1); return renderScalar(args[0]!) }
    case 'number': {
      arity(name, args, 1, 1)
      const value = args[0]
      if (typeof value === 'number') return value
      if (typeof value !== 'string' || value.trim() === '') throw new WorkflowExpressionExecutionError('number requires a number or numeric string')
      return finite(Number(value), 'number')
    }
    case 'boolean': { arity(name, args, 1, 1); return truthy(args[0]!) }
    case 'keys': { arity(name, args, 1, 1); return Object.keys(requireObject(args[0], name)).filter(key => !UNSAFE_KEYS.has(key)) }
    case 'values': { arity(name, args, 1, 1); return Object.entries(requireObject(args[0], name)).filter(([key]) => !UNSAFE_KEYS.has(key)).map(([, value]) => value) }
    case 'get': {
      arity(name, args, 2, 3)
      return getPath(args[0]!, args[1]!, args.length === 3 ? args[2]! : null)
    }
    case 'has': {
      arity(name, args, 2, 2)
      return getPath(args[0]!, args[1]!, MISSING) !== MISSING
    }
    case 'sum': return requireNumberArrayArg(name, args).reduce((total, value) => finite(total + value, name), 0)
    case 'min': return Math.min(...nonEmptyNumbers(name, args))
    case 'max': return Math.max(...nonEmptyNumbers(name, args))
    case 'unique': {
      const values = requireArrayArg(name, args)
      const seen = new Set<string>()
      return values.filter(value => {
        const key = stableJsonStringify(value)
        if (seen.has(key)) return false
        seen.add(key); return true
      })
    }
    case 'sort': {
      const values = [...requireArrayArg(name, args)]
      if (!values.every(value => typeof value === 'number') && !values.every(value => typeof value === 'string')) {
        throw new WorkflowExpressionExecutionError('sort requires an array containing only numbers or only strings')
      }
      return values.sort((left, right) => compare(left, right))
    }
    case 'sortBy': {
      arity(name, args, 3)
      if (args.length % 2 === 0) {
        throw new WorkflowExpressionExecutionError('sortBy expects an array followed by path/direction pairs')
      }
      const values = requireArray(args[0], name)
      const fields: { readonly path: string; readonly direction: 1 | -1 }[] = []
      for (let index = 1; index < args.length; index += 2) {
        const path = requireString(args[index], name)
        const direction = requireString(args[index + 1], name)
        if (path.length === 0) throw new WorkflowExpressionExecutionError('sortBy paths must be non-empty')
        if (direction !== 'asc' && direction !== 'desc') {
          throw new WorkflowExpressionExecutionError('sortBy directions must be "asc" or "desc"')
        }
        fields.push({ path, direction: direction === 'asc' ? 1 : -1 })
      }
      const indexed = values.map((value, index) => ({ value: requireObject(value, name), index }))
      for (const entry of indexed) {
        for (const field of fields) {
          spend(budget)
          const value = getPath(entry.value, field.path, MISSING)
          if (value === MISSING) throw new WorkflowExpressionExecutionError(`sortBy path does not exist: ${field.path}`)
          if (typeof value !== 'number' && typeof value !== 'string') {
            throw new WorkflowExpressionExecutionError(`sortBy path must resolve to a number or string: ${field.path}`)
          }
        }
      }
      indexed.sort((left, right) => {
        for (const field of fields) {
          spend(budget)
          const leftValue = getPath(left.value, field.path, MISSING)
          const rightValue = getPath(right.value, field.path, MISSING)
          if (leftValue === MISSING || rightValue === MISSING) {
            throw new WorkflowExpressionExecutionError(`sortBy path does not exist: ${field.path}`)
          }
          const order = compare(leftValue, rightValue)
          if (order !== 0) return order * field.direction
        }
        return left.index - right.index
      })
      return indexed.map(entry => entry.value)
    }
    case 'withIndex': {
      arity(name, args, 2, 3)
      const values = requireArray(args[0], name).map(value => requireObject(value, name))
      const field = requireString(args[1], name)
      const start = args.length === 3 ? requireInteger(args[2], name) : 0
      if (field.length === 0 || field.includes('.') || UNSAFE_KEYS.has(field)) {
        throw new WorkflowExpressionExecutionError('withIndex field must be one safe top-level property name')
      }
      return values.map((value, index) => {
        spend(budget)
        if (Object.hasOwn(value, field)) throw new WorkflowExpressionExecutionError(`withIndex cannot overwrite existing field: ${field}`)
        const assigned = start + index
        if (!Number.isSafeInteger(assigned)) throw new WorkflowExpressionExecutionError('withIndex produced an unsafe integer')
        return { ...value, [field]: assigned }
      })
    }
    case 'joinBy': {
      arity(name, args, 3, 3)
      const base = requireArray(args[0], name).map(value => requireObject(value, name))
      const overlays = requireArray(args[1], name).map(value => requireObject(value, name))
      const key = requireString(args[2], name)
      if (key.length === 0 || key.includes('.') || UNSAFE_KEYS.has(key)) {
        throw new WorkflowExpressionExecutionError('joinBy key must be one safe top-level property name')
      }
      const baseByKey = new Map<string, JsonObject>()
      for (const item of base) {
        spend(budget)
        const identity = joinIdentity(item[key], key)
        if (baseByKey.has(identity)) throw new WorkflowExpressionExecutionError(`joinBy base key is duplicated: ${String(item[key])}`)
        baseByKey.set(identity, item)
      }
      const overlayByKey = new Map<string, JsonObject>()
      for (const overlay of overlays) {
        spend(budget)
        const identity = joinIdentity(overlay[key], key)
        if (!baseByKey.has(identity)) throw new WorkflowExpressionExecutionError(`joinBy overlay key is unknown: ${String(overlay[key])}`)
        if (overlayByKey.has(identity)) throw new WorkflowExpressionExecutionError(`joinBy overlay key is duplicated: ${String(overlay[key])}`)
        const original = baseByKey.get(identity)!
        for (const field of Object.keys(overlay)) {
          if (field !== key && Object.hasOwn(original, field)) {
            throw new WorkflowExpressionExecutionError(`joinBy overlay cannot overwrite base field: ${field}`)
          }
        }
        overlayByKey.set(identity, overlay)
      }
      if (overlayByKey.size !== baseByKey.size) {
        throw new WorkflowExpressionExecutionError(`joinBy requires exactly one overlay for each base item (${overlayByKey.size}/${baseByKey.size})`)
      }
      return base.map(item => {
        const overlay = overlayByKey.get(joinIdentity(item[key], key))!
        return { ...item, ...overlay }
      })
    }
    case 'mapGet': {
      arity(name, args, 2, 3)
      const values = requireArray(args[0], name)
      const fallback = args.length === 3 ? args[2]! : null
      return values.map(value => getPath(value, args[1]!, fallback))
    }
    case 'filterEq': {
      arity(name, args, 3, 3)
      return requireArray(args[0], name).filter(value => equalJson(getPath(value, args[1]!, null), args[2]!))
    }
    case 'json': { arity(name, args, 1, 1); return stableJsonStringify(args[0]!) }
    case 'parseJson': {
      const value = requireStringArg(name, args)
      try { return snapshotJsonValue(JSON.parse(value)) } catch { throw new WorkflowExpressionExecutionError('parseJson received invalid JSON') }
    }
    case 'format': {
      arity(name, args, 2, 2)
      const template = requireString(args[0], name)
      const variables = requireObject(args[1], name)
      return template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/gu, (_match, path: string) => renderScalar(getPath(variables, path, null)))
    }
    default: throw new WorkflowExpressionExecutionError(`unknown function ${name}`)
  }
}

const MISSING = Symbol('missing')

function getPath(root: JsonValue, candidate: JsonValue, fallback: JsonValue): JsonValue
function getPath(root: JsonValue, candidate: JsonValue, fallback: typeof MISSING): JsonValue | typeof MISSING
function getPath(root: JsonValue, candidate: JsonValue, fallback: JsonValue | typeof MISSING): JsonValue | typeof MISSING {
  const path = typeof candidate === 'string'
    ? candidate.split('.').filter(Boolean)
    : Array.isArray(candidate) ? candidate : undefined
  if (path === undefined || !path.every(segment => typeof segment === 'string' || Number.isSafeInteger(segment))) {
    throw new WorkflowExpressionExecutionError('path must be a dot string or an array of string/integer segments')
  }
  let value: JsonValue = root
  for (const segment of path) {
    if (typeof segment === 'number') {
      if (!Array.isArray(value) || segment < 0 || segment >= value.length) return fallback
      value = value[segment]!
    } else {
      if (UNSAFE_KEYS.has(segment) || !isObject(value) || !Object.hasOwn(value, segment)) return fallback
      value = value[segment]!
    }
  }
  return value
}

function readMember(value: JsonValue, property: JsonValue): JsonValue {
  if (typeof property === 'number' && Number.isSafeInteger(property)) {
    if (!Array.isArray(value) || property < 0 || property >= value.length) throw new WorkflowExpressionExecutionError(`array index does not exist: ${property}`)
    return value[property]!
  }
  if (typeof property !== 'string') throw new WorkflowExpressionExecutionError('member key must be a string or integer')
  if (UNSAFE_KEYS.has(property)) throw new WorkflowExpressionExecutionError(`unsafe member key is forbidden: ${property}`)
  if (!isObject(value) || !Object.hasOwn(value, property)) throw new WorkflowExpressionExecutionError(`object key does not exist: ${property}`)
  return value[property]!
}

function spend(budget: { remaining: number; readonly signal: AbortSignal }, amount = 1): void {
  if (budget.signal.aborted) throw new WorkflowExpressionExecutionError('script execution was cancelled')
  budget.remaining -= amount
  if (budget.remaining < 0) throw new WorkflowExpressionExecutionError('script operation budget exceeded')
}

function arity(name: string, args: readonly JsonValue[], minimum: number, maximum = Number.POSITIVE_INFINITY): void {
  if (args.length < minimum || args.length > maximum) {
    const expected = minimum === maximum ? String(minimum) : maximum === Number.POSITIVE_INFINITY ? `at least ${minimum}` : `${minimum}-${maximum}`
    throw new WorkflowExpressionExecutionError(`${name} expects ${expected} arguments`)
  }
}

function requireStringArg(name: string, args: readonly JsonValue[]): string { arity(name, args, 1, 1); return requireString(args[0], name) }
function requireArrayArg(name: string, args: readonly JsonValue[]): readonly JsonValue[] { arity(name, args, 1, 1); return requireArray(args[0], name) }
function requireNumberArrayArg(name: string, args: readonly JsonValue[]): readonly number[] {
  return requireArrayArg(name, args).map(value => requireNumber(value, name))
}
function nonEmptyNumbers(name: string, args: readonly JsonValue[]): readonly number[] {
  const values = requireNumberArrayArg(name, args)
  if (values.length === 0) throw new WorkflowExpressionExecutionError(`${name} requires a non-empty array`)
  return values
}
function requireString(value: JsonValue | undefined, name: string): string {
  if (typeof value !== 'string') throw new WorkflowExpressionExecutionError(`${name} requires a string`)
  return value
}
function requireArray(value: JsonValue | undefined, name: string): readonly JsonValue[] {
  if (!Array.isArray(value)) throw new WorkflowExpressionExecutionError(`${name} requires an array`)
  return value
}
function requireObject(value: JsonValue | undefined, name: string): JsonObject {
  if (!isObject(value)) throw new WorkflowExpressionExecutionError(`${name} requires an object`)
  return value
}
function requireNumber(value: JsonValue | undefined, name: string): number {
  if (typeof value !== 'number') throw new WorkflowExpressionExecutionError(`${name} requires a number`)
  return value
}
function requireInteger(value: JsonValue | undefined, name: string): number {
  const number = requireNumber(value, name)
  if (!Number.isSafeInteger(number)) throw new WorkflowExpressionExecutionError(`${name} requires a safe integer`)
  return number
}
function joinIdentity(value: JsonValue | undefined, key: string): string {
  if (typeof value === 'string') return `string:${value}`
  if (typeof value === 'number' && Number.isFinite(value)) return `number:${value}`
  throw new WorkflowExpressionExecutionError(`joinBy key ${key} must resolve to a string or number`)
}
function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new WorkflowExpressionExecutionError(`${name} produced a non-finite number`)
  return value
}
function renderScalar(value: JsonValue): string {
  if (value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return stableJsonStringify(value)
}
function truthy(value: JsonValue): boolean { return value !== null && value !== false && value !== 0 && value !== '' }
function equalJson(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) return false
  return stableJsonStringify(left) === stableJsonStringify(right)
}
function compare(left: JsonValue, right: JsonValue): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right
  if (typeof left === 'string' && typeof right === 'string') return left < right ? -1 : left > right ? 1 : 0
  throw new WorkflowExpressionExecutionError('comparison requires two numbers or two strings')
}
function isObject(value: unknown): value is JsonObject { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function assertSafeKey(key: string, offset: number): void {
  if (UNSAFE_KEYS.has(key)) throw new WorkflowExpressionSyntaxError(`unsafe object key is forbidden: ${key}`, offset)
}
