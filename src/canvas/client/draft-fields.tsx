import { createContext, useContext, useEffect, useRef, useState, type ComponentProps } from 'react'
import type { CanvasJsonValue } from '../types.js'

export interface PendingDraftField {
  readonly id: string
  readonly text: string
  readonly nodeId?: string
}

interface DraftFields {
  readonly pending: ReadonlyMap<string, PendingDraftField>
  readonly update: (field: PendingDraftField, valid: boolean) => void
}

const emptyFields: DraftFields = { pending: new Map(), update: () => {} }
export const DraftFieldsContext = createContext<DraftFields>(emptyFields)

export function DraftJsonField<T extends CanvasJsonValue>({ fieldId, nodeId, label, value, error, parse, onChange, compact = false }: {
  readonly fieldId: string
  readonly nodeId?: string
  readonly label: string
  readonly value: T
  readonly error: string
  readonly parse: (text: string) => T
  readonly onChange: (value: T) => void
  readonly compact?: boolean
}) {
  const fields = useContext(DraftFieldsContext)
  const serialized = JSON.stringify(value, null, compact ? 0 : 2)
  const pending = fields.pending.get(fieldId)
  const [text, setText] = useState(pending?.text ?? serialized)
  const canonical = useRef(serialized)
  useEffect(() => {
    if (canonical.current !== serialized) {
      canonical.current = serialized
      setText(pending?.text ?? serialized)
    }
  }, [pending?.text, serialized])

  const update = (next: string) => {
    setText(next)
    const field = { id: fieldId, text: next, ...(nodeId === undefined ? {} : { nodeId }) }
    let parsed: T
    try { parsed = parse(next) } catch {
      fields.update(field, false)
      return
    }
    fields.update(field, true)
    const nextCanonical = JSON.stringify(parsed, null, compact ? 0 : 2)
    if (nextCanonical !== canonical.current) {
      canonical.current = nextCanonical
      onChange(parsed)
    }
  }

  const common: ComponentProps<'input'> & ComponentProps<'textarea'> = {
    'aria-invalid': pending !== undefined,
    value: text,
    spellCheck: false,
  }
  return <label data-invalid={pending !== undefined}>{label}
    {compact ? <input {...common} data-workflow-field={fieldId} onChange={event => update(event.currentTarget.value)} />
      : <textarea {...common} data-workflow-field={fieldId} onChange={event => update(event.currentTarget.value)} />}
    {pending === undefined ? null : <small role="alert" className="wf-field-error">{error}</small>}
  </label>
}

export function focusDraftField(fieldId: string): boolean {
  const field = [...document.querySelectorAll<HTMLElement>('[data-workflow-field]')].find(item => item.dataset.workflowField === fieldId)
  if (field === undefined) return false
  for (let parent = field.parentElement; parent !== null; parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement) parent.open = true
  }
  field.focus()
  return true
}
