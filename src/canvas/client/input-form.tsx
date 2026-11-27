import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { CanvasJsonObject, CanvasJsonValue } from '../types.js'
import { useCanvasCopy } from './locale.js'
import { isObject } from './personal.js'

type Scalar = string | number | boolean | null
type ScalarType = 'string' | 'integer' | 'number' | 'boolean' | 'null'
type FieldValue = { readonly mode: 'unset' | 'value' | 'null' | 'original'; readonly text: string }

interface RunInputField {
  readonly name: string
  readonly label: string
  readonly description?: string
  readonly required: boolean
  readonly type: ScalarType
  readonly nullable: boolean
  readonly choices?: readonly Scalar[]
  readonly defaultValue?: Scalar
  readonly minimum?: number
  readonly maximum?: number
  readonly minLength?: number
  readonly maxLength?: number
  readonly pattern?: string
}

const scalarTypes = new Set<string>(['string', 'integer', 'number', 'boolean', 'null'])

export function runInputFields(schema: CanvasJsonObject): readonly RunInputField[] {
  if (!isObject(schema.properties)) return []
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  return Object.entries(schema.properties).flatMap(([name, property]) => {
    if (!isObject(property)) return []
    const declaredTypes = Array.isArray(property.type) ? property.type : [property.type]
    const nonNull = declaredTypes.filter(type => type !== 'null')
    const type = nonNull[0] ?? 'null'
    if (nonNull.length > 1 || typeof type !== 'string' || !scalarTypes.has(type)) return []
    const declaredChoices = Array.isArray(property.enum) ? property.enum : undefined
    const choices = declaredChoices?.filter(isScalar)
    if (choices?.length !== declaredChoices?.length) return []
    const nullable = declaredTypes.includes('null')
    const fallback = property.default
    return [{
      name, type: type as ScalarType, nullable, required: required.has(name), label: typeof property.title === 'string' ? property.title : name,
      ...(typeof property.description === 'string' ? { description: property.description } : {}),
      ...(choices === undefined ? {} : { choices }),
      ...(isScalar(fallback) && matchesType(fallback, type as ScalarType, nullable) ? { defaultValue: fallback } : {}),
      ...(typeof property.minimum === 'number' ? { minimum: property.minimum } : {}),
      ...(typeof property.maximum === 'number' ? { maximum: property.maximum } : {}),
      ...(typeof property.minLength === 'number' && property.minLength >= 0 ? { minLength: property.minLength } : {}),
      ...(typeof property.maxLength === 'number' && property.maxLength >= 0 ? { maxLength: property.maxLength } : {}),
      ...(typeof property.pattern === 'string' ? { pattern: property.pattern } : {}),
    }]
  })
}

export function RunInputForm({ inputs, fields, onApply, onCancel, title }: {
  readonly inputs: CanvasJsonObject
  readonly fields: readonly RunInputField[]
  readonly title?: string
  readonly onApply: (inputs: CanvasJsonObject) => void
  readonly onCancel: () => void
}) {
  const { t } = useCanvasCopy()
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [values, setValues] = useState(() => new Map(fields.map(field => [field.name, initialValue(field, inputs)])))
  const [fieldIssue, setFieldIssue] = useState<{ name: string; message: string }>()
  useEffect(() => {
    const priorFocus = document.activeElement
    dialog.current?.showModal()
    return () => { if (priorFocus instanceof HTMLElement && priorFocus.isConnected) priorFocus.focus() }
  }, [])

  const update = (field: RunInputField, value: FieldValue) => {
    setValues(current => new Map(current).set(field.name, value))
    if (fieldIssue?.name === field.name) setFieldIssue(undefined)
  }

  const apply = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const next = { ...inputs }
    for (const [index, field] of fields.entries()) {
      const inputId = `${titleId}-field-${index}`
      const ask = (message: string) => {
        setFieldIssue({ name: field.name, message })
        document.getElementById(inputId)?.focus()
      }
      const { mode, text } = values.get(field.name)!
      if (mode === 'original') continue
      if (mode === 'unset') {
        if (field.required) return ask(t('This input is required'))
        delete next[field.name]
        continue
      }
      const control = document.getElementById(inputId)
      const choices = fieldChoices(field)
      let value: CanvasJsonValue
      if (mode === 'null') value = null
      else if (choices !== undefined) value = JSON.parse(text) as CanvasJsonValue
      else if (field.type === 'string') {
        const length = [...text].length
        if ((field.minLength !== undefined && length < field.minLength) || (field.maxLength !== undefined && length > field.maxLength)) {
          return ask(t('Match the declared text length'))
        }
        if (field.pattern !== undefined && !matchesPattern(text, field.pattern)) return ask(t('Match the declared text pattern'))
        value = text
      } else {
        const number = Number(text)
        if (text.trim() === '' || !Number.isFinite(number) || (field.type === 'integer' && !Number.isInteger(number))) {
          return ask(control instanceof HTMLInputElement && control.validity.badInput ? control.validationMessage : t('Enter a valid number'))
        }
        if ((field.minimum !== undefined && number < field.minimum) || (field.maximum !== undefined && number > field.maximum)) {
          return ask(t('Match the declared number range'))
        }
        value = number
      }
      Object.defineProperty(next, field.name, { value, enumerable: true, configurable: true, writable: true })
    }
    onApply(next)
  }

  return <dialog ref={dialog} className="wf-modal wf-input-form" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onCancel() }}>
    <h2 id={titleId}>{title ?? t('Run inputs')}</h2>
    <form onSubmit={apply} noValidate>
      {fields.map((field, index) => {
        const value = values.get(field.name)!
        const original = initialValue(field, inputs)
        const choices = fieldChoices(field)
        const inputId = `${titleId}-field-${index}`
        const issue = fieldIssue?.name === field.name ? fieldIssue.message : undefined
        const hint = field.defaultValue === undefined ? field.description : [field.description,
          t('Schema default: {value}', { value: JSON.stringify(field.defaultValue) })].filter(Boolean).join(' · ')
        const describedBy = [hint === undefined ? undefined : `${inputId}-hint`, issue === undefined ? undefined : `${inputId}-error`].filter(Boolean).join(' ') || undefined
        const label = field.label + (field.required ? ' *' : '')
        return <div className="wf-input-field" key={field.name}>
          <label htmlFor={inputId}>{label}</label>
          {choices === undefined ? <div className="wf-input-value">
            <input id={inputId} value={value.mode === 'value' ? value.text : ''} aria-required={field.required}
              type={field.type === 'string' ? 'text' : 'number'} step={field.type === 'integer' ? 1 : 'any'}
              min={field.minimum} max={field.maximum} aria-invalid={issue !== undefined} aria-describedby={describedBy}
              onChange={event => update(field, { mode: 'value', text: event.currentTarget.value })} />
            <select aria-label={t('Value mode for {field}', { field: field.label })} value={value.mode} onChange={event => {
              const mode = event.currentTarget.value as FieldValue['mode']
              update(field, mode === 'original' ? original : { mode, text: value.text })
            }}>
              <option value="unset">{t('Not set')}</option><option value="value">{t('Set value')}</option>
              {field.nullable ? <option value="null">null</option> : null}
              {original.mode === 'original' ? <option value="original">{t('Keep existing JSON')}</option> : null}
            </select>
          </div> : <select id={inputId} value={value.mode === 'value' ? value.text : value.mode}
            aria-required={field.required} aria-invalid={issue !== undefined} aria-describedby={describedBy}
            onChange={event => {
              const text = event.currentTarget.value
              if (text === 'unset' || text === 'null' || text === 'original') update(field, { mode: text, text: '' })
              else update(field, { mode: 'value', text })
            }}>
            <option value="unset">{t('Not set')}</option>
            {original.mode === 'original' ? <option value="original">{t('Keep existing JSON')}</option> : null}
            {choices.map(choice => <option key={JSON.stringify(choice)} value={JSON.stringify(choice)}>{choice === '' ? t('Empty string') : String(choice)}</option>)}
          </select>}
          {hint === undefined ? null : <small id={`${inputId}-hint`}>{hint}</small>}
          {issue === undefined ? null : <small id={`${inputId}-error`} role="alert">{issue}</small>}
        </div>
      })}
      <footer><button type="button" onClick={onCancel}>{t('Cancel')}</button><button type="submit" className="wf-primary">{t('Apply inputs')}</button></footer>
    </form>
  </dialog>
}

function isScalar(value: unknown): value is Scalar {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function matchesType(value: CanvasJsonValue, type: ScalarType, nullable: boolean): boolean {
  if (value === null) return nullable
  return type === 'integer' ? typeof value === 'number' && Number.isInteger(value) : typeof value === type
}

function fieldChoices(field: RunInputField): readonly Scalar[] | undefined {
  if (field.choices !== undefined) return field.choices
  if (field.type === 'boolean') return field.nullable ? [true, false, null] : [true, false]
  return field.type === 'null' ? [null] : undefined
}

function initialValue(field: RunInputField, inputs: CanvasJsonObject): FieldValue {
  if (!Object.hasOwn(inputs, field.name)) return { mode: 'unset', text: '' }
  const value = inputs[field.name]!
  const choices = fieldChoices(field)
  if (choices !== undefined && !choices.some(choice => choice === value)) return { mode: 'original', text: '' }
  if (value === null && (field.nullable || choices?.includes(null))) return { mode: 'null', text: '' }
  if (!matchesType(value, field.type, field.nullable) && choices === undefined) return { mode: 'original', text: '' }
  return { mode: 'value', text: choices !== undefined ? JSON.stringify(value) : String(value) }
}

function matchesPattern(text: string, pattern: string): boolean {
  try { return new RegExp(pattern, 'u').test(text) } catch { return true }
}
