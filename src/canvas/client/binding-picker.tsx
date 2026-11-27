import { useContext, useState } from 'react'
import type { CanvasJsonObject, CanvasJsonValue, CanvasWorkflowBinding } from '../types.js'
import { DraftFieldsContext, DraftJsonField } from './draft-fields.js'
import { useCanvasCopy } from './locale.js'
import { isObject } from './personal.js'

interface Source {
  readonly id: string
  readonly label: string
  readonly kind: 'input' | 'output'
  readonly schema?: CanvasJsonObject
}

export function BindingPicker({ nodeId, sources, values, schema, onChange }: {
  readonly nodeId: string
  readonly sources: readonly Source[]
  readonly values: Readonly<Record<string, CanvasWorkflowBinding>>
  readonly schema?: CanvasJsonObject
  readonly onChange: (value: Readonly<Record<string, CanvasWorkflowBinding>>) => void
}) {
  const { t } = useCanvasCopy()
  const fields = useContext(DraftFieldsContext)
  const [field, setField] = useState('')
  const properties = isObject(schema?.properties) ? Object.keys(schema.properties) : []
  const rows = [...new Set([...properties, ...Object.keys(values)])]
  const first = sources[0]
  const fieldId = (name: string) => `node:${nodeId}:binding:${name}`
  const set = (name: string, binding: CanvasWorkflowBinding | undefined) => {
    fields.update({ id: fieldId(name), text: '', nodeId }, true)
    const next = { ...values }
    if (binding === undefined) delete next[name]
    else Object.defineProperty(next, name, { value: binding, enumerable: true, configurable: true, writable: true })
    onChange(next)
  }

  return <fieldset className="wf-schema-form wf-binding-picker"><legend>{t('Connect inputs')}</legend>
    {rows.map(name => {
      const binding = values[name]
      const sourceId = binding === undefined ? '' : 'input' in binding ? 'input' : 'output' in binding ? `output:${binding.output.nodeId}` : 'literal'
      const source = sources.find(item => item.id === sourceId) ?? (sourceId.startsWith('output:') ? { id: sourceId, label: sourceId, kind: 'output' as const } : undefined)
      const path = binding !== undefined && 'input' in binding ? binding.input.path : binding !== undefined && 'output' in binding ? binding.output.path : undefined
      const schema = source !== undefined && 'schema' in source ? source.schema : undefined
      const pathKeys = isObject(schema?.properties) ? Object.keys(schema.properties) : []
      return <section key={name}><label>{name}<select value={sourceId} aria-label={t('Source for {field}', { field: name })} onChange={event => {
        const next = event.currentTarget.value
        const selected = sources.find(item => item.id === next)
        set(name, selected === undefined ? next === 'literal' ? { literal: null } : undefined : fromSource(selected, []))
      }}>
        <option value="">{t('Unbound')}</option>
        <option value="literal">{t('Literal JSON')}</option>
        {sourceId.startsWith('output:') && !sources.some(item => item.id === sourceId) ? <option value={sourceId} disabled>{sourceId}</option> : null}
        {sources.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select></label>
      {source === undefined || path === undefined ? binding !== undefined && 'literal' in binding
        ? <DraftJsonField key="literal" fieldId={fieldId(name)} nodeId={nodeId} compact label={t('Literal JSON')}
            error={t('Invalid binding JSON')} value={binding.literal} parse={value => JSON.parse(value) as CanvasJsonValue}
            onChange={value => set(name, { literal: value })} />
        : null : <>
          {pathKeys.length === 0 ? null : <label>{t('Field from source')}<select value={typeof path[0] === 'string' && path.length === 1 ? path[0] : ''}
            onChange={event => set(name, fromSource(source, event.currentTarget.value === '' ? [] : [event.currentTarget.value]))}>
            <option value="">{t('Whole result or custom path')}</option>
            {pathKeys.map(key => <option key={key} value={key}>{key}</option>)}
          </select></label>}
          <DraftJsonField key={source.id} fieldId={fieldId(name)} nodeId={nodeId} compact label={t('Field path (JSON array)')} value={path}
            error={t('Use a JSON array of field names and indexes')} parse={value => {
              const parsed: unknown = JSON.parse(value)
              if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string' || (Number.isSafeInteger(item) && item >= 0))) throw new Error('field path required')
              return parsed as (string | number)[]
            }} onChange={value => set(name, fromSource(source, value))} />
        </>}
      </section>
    })}
    <label>{t('New input name')}<input value={field} onChange={event => setField(event.currentTarget.value)} /></label>
    <button type="button" disabled={field.trim().length === 0 || rows.includes(field.trim())} onClick={() => {
      set(field.trim(), first === undefined ? { literal: null } : fromSource(first, []))
      setField('')
    }}>{t('Add input binding')}</button>
  </fieldset>
}

function fromSource(source: Source, path: readonly (string | number)[]): CanvasWorkflowBinding {
  return source.kind === 'input' ? { input: { path } } : { output: { nodeId: source.id.slice('output:'.length), path } }
}
