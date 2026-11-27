import { useState, type ReactNode } from 'react'
import type { CanvasJsonObject, CanvasJsonValue } from '../types.js'
import { useCanvasCopy } from './locale.js'
import { isObject } from './personal.js'

export function WorkflowResultView({ outputs }: { readonly outputs: CanvasJsonObject }) {
  const { t } = useCanvasCopy()
  const [view, setView] = useState<'json' | 'text' | 'summary' | 'markdown'>('json')
  const entries = Object.entries(outputs)
  const textOutputs = entries.filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  return <>
    <nav className="wf-result-tabs" aria-label={t('Result format')}>
      <button type="button" aria-pressed={view === 'json'} onClick={() => setView('json')}>JSON</button>
      <button type="button" aria-pressed={view === 'summary'} onClick={() => setView('summary')}>{t('Table')}</button>
      {textOutputs.length === 0 ? null : <>
        <button type="button" aria-pressed={view === 'text'} onClick={() => setView('text')}>{t('Text')}</button>
        <button type="button" aria-pressed={view === 'markdown'} onClick={() => setView('markdown')}>Markdown</button>
      </>}
    </nav>
    {view === 'json' ? <pre tabIndex={0} aria-label={t('Run output')}>{JSON.stringify(outputs, null, 2)}</pre>
      : view === 'text' || view === 'markdown' ? <div className="wf-result-text">{textOutputs.map(([label, value]) => <section key={label}><b>{label}</b>
        {view === 'markdown' ? <MarkdownText value={value} /> : <pre>{value}</pre>}</section>)}</div>
        : <div className="wf-result-table"><table><tbody>{entries.map(([field, value]) => <tr key={field}><th scope="row">{field}</th><td><ResultCell value={value} /></td></tr>)}</tbody></table></div>}
  </>
}

/** Render common report markup as text and React nodes. Raw HTML stays text. */
function MarkdownText({ value }: { readonly value: string }) {
  const blocks: ReactNode[] = []
  const lines = value.replaceAll('\r\n', '\n').split('\n')
  for (let index = 0; index < lines.length;) {
    const first = index
    const line = lines[index++]!
    if (line.trim() === '') continue
    if (/^ {0,3}```/.test(line)) {
      const code: string[] = []
      while (index < lines.length && !/^ {0,3}```/.test(lines[index]!)) code.push(lines[index++]!)
      index++
      blocks.push(<pre key={first}><code>{code.join('\n')}</code></pre>)
      continue
    }
    const heading = /^ {0,3}(#{1,6})\s+(.+)$/.exec(line)
    if (heading !== null) {
      const Heading = heading[1]!.length <= 2 ? 'h3' : 'h4'
      blocks.push(<Heading key={first}>{inlineText(heading[2]!)}</Heading>)
      continue
    }
    const marker = listMarker(line)
    if (marker !== null) {
      const items = [marker[2]!]
      const ordered = /^\d/.test(marker[1]!)
      while (index < lines.length) {
        const following = listMarker(lines[index]!)
        if (following === null || /^\d/.test(following[1]!) !== ordered) break
        items.push(following[2]!)
        index++
      }
      const List = ordered ? 'ol' : 'ul'
      blocks.push(<List key={first}>{items.map((item, itemIndex) => <li key={itemIndex}>{inlineText(item)}</li>)}</List>)
      continue
    }
    const paragraph = [line]
    while (index < lines.length && lines[index]!.trim() !== '' && listMarker(lines[index]!) === null
      && !/^ {0,3}(?:#{1,6}\s|```)/.test(lines[index]!)) paragraph.push(lines[index++]!)
    blocks.push(<p key={first}>{inlineText(paragraph.join(' '))}</p>)
  }
  return <div className="wf-result-markdown">{blocks}</div>
}

function listMarker(value: string): RegExpExecArray | null { return /^ {0,3}([-*+]|\d+\.)\s+(.+)$/.exec(value) }

function inlineText(value: string): ReactNode[] {
  return value.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((fragment, index) => fragment.startsWith('`') && fragment.endsWith('`') && fragment.length > 2
    ? <code key={index}>{fragment.slice(1, -1)}</code>
    : fragment.startsWith('**') && fragment.endsWith('**') && fragment.length > 4
      ? <strong key={index}>{fragment.slice(2, -2)}</strong>
      : fragment)
}

function ResultCell({ value }: { readonly value: CanvasJsonValue }) {
  if (Array.isArray(value) && value.length > 0 && value.every(isObject)) {
    const rows: CanvasJsonObject[] = value
    const fields = [...new Set(rows.flatMap(row => Object.keys(row)))].slice(0, 24)
    if (fields.length > 0) return <table><thead><tr>{fields.map(field => <th key={field} scope="col">{field}</th>)}</tr></thead>
      <tbody>{rows.map((row, index) => <tr key={index}>{fields.map(field => <td key={field}>{formatValue(row[field])}</td>)}</tr>)}</tbody></table>
  }
  return <>{formatValue(value)}</>
}

function formatValue(value: CanvasJsonValue | undefined): string {
  return typeof value === 'string' ? value : JSON.stringify(value) ?? '—'
}
