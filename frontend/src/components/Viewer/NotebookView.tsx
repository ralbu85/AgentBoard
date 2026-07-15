import { useState, useEffect, useMemo } from 'react'
import { renderMarkdown } from '../../markdown'
import { sanitize } from '../../sanitize'
import { getHljs } from './FileContent'

// Read-only Jupyter notebook renderer (nbformat 4; minimal v3 fallback).
// Cells render defensively — a malformed cell degrades to plain text, never throws.

interface NbOutput {
  output_type: string
  name?: string                              // stream: stdout | stderr
  text?: string | string[]                   // stream
  data?: Record<string, unknown>             // execute_result / display_data
  execution_count?: number | null
  ename?: string; evalue?: string; traceback?: string[]  // error
}
interface NbCell {
  cell_type: string
  source?: string | string[]
  input?: string | string[]                  // nbformat 3
  outputs?: NbOutput[]
  execution_count?: number | null
  prompt_number?: number | null              // nbformat 3
}

const joinSrc = (s: unknown): string => Array.isArray(s) ? s.join('') : typeof s === 'string' ? s : ''
// Jupyter tracebacks/streams carry ANSI color codes — strip for plain rendering
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

function parseNotebook(content: string): { cells: NbCell[]; lang: string } | { error: string } {
  let nb: any
  try { nb = JSON.parse(content) } catch { return { error: 'JSON 파싱에 실패했습니다 — 손상된 .ipynb 파일입니다.' } }
  const cells = nb?.cells ?? nb?.worksheets?.[0]?.cells   // v4 / v3
  if (!Array.isArray(cells)) return { error: '지원하지 않는 notebook 형식입니다.' }
  const lang = nb?.metadata?.kernelspec?.language || nb?.metadata?.language_info?.name || 'python'
  return { cells, lang }
}

export function NotebookView({ content }: { content: string }) {
  const parsed = useMemo(() => parseNotebook(content), [content])
  const [hljs, setHljs] = useState<any>(null)
  useEffect(() => { getHljs().then(setHljs).catch(() => {}) }, [])

  if ('error' in parsed) {
    return <div className="viewer-empty">{parsed.error} (✎ 버튼으로 원본 JSON을 열 수 있습니다)</div>
  }
  return (
    <div className="nb-wrap">
      {parsed.cells.map((cell, i) =>
        cell.cell_type === 'code'
          ? <CodeCell key={i} cell={cell} lang={parsed.lang} hljs={hljs} />
          : <TextCell key={i} cell={cell} />
      )}
    </div>
  )
}

/** markdown / raw cells */
function TextCell({ cell }: { cell: NbCell }) {
  const src = joinSrc(cell.source ?? cell.input)
  const html = useMemo(
    () => cell.cell_type === 'markdown' ? renderMarkdown(src) : '',
    [src, cell.cell_type],
  )
  return (
    <div className="nb-cell">
      <div className="nb-gutter" />
      {cell.cell_type === 'markdown'
        ? <div className="nb-main md-rendered" dangerouslySetInnerHTML={{ __html: html }} />
        : <pre className="nb-main nb-raw">{src}</pre>}
    </div>
  )
}

function CodeCell({ cell, lang, hljs }: { cell: NbCell; lang: string; hljs: any }) {
  const src = joinSrc(cell.source ?? cell.input)
  const n = cell.execution_count ?? cell.prompt_number
  const html = useMemo(() => {
    if (hljs) {
      try {
        const l = hljs.getLanguage(lang) ? lang : 'python'
        return sanitize(hljs.highlight(src, { language: l }).value)
      } catch { /* fall through to escaped */ }
    }
    return src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }, [src, lang, hljs])

  return (
    <div className="nb-cell">
      <div className="nb-gutter nb-in">In&nbsp;[{n ?? ' '}]</div>
      <div className="nb-main">
        <pre className="nb-code hljs"><code dangerouslySetInnerHTML={{ __html: html }} /></pre>
        {(cell.outputs || []).map((out, i) => <Output key={i} out={out} />)}
      </div>
    </div>
  )
}

function Output({ out }: { out: NbOutput }) {
  if (out.output_type === 'stream') {
    return <pre className={`nb-stream ${out.name === 'stderr' ? 'nb-stderr' : ''}`}>{stripAnsi(joinSrc(out.text))}</pre>
  }
  if (out.output_type === 'error') {
    const tb = (out.traceback || []).map(t => stripAnsi(joinSrc(t))).join('\n')
    return <pre className="nb-error">{tb || `${out.ename ?? 'Error'}: ${out.evalue ?? ''}`}</pre>
  }
  // execute_result / display_data — pick the richest mime we can render safely
  const data = out.data || {}
  for (const mime of ['image/png', 'image/jpeg', 'image/gif']) {
    if (data[mime]) {
      return <img className="nb-img" src={`data:${mime};base64,${joinSrc(data[mime]).replace(/\n/g, '')}`} alt="" />
    }
  }
  if (data['image/svg+xml']) {
    // via <img> data-URI, never inline — an <img>-loaded SVG can't run scripts
    return <img className="nb-img nb-img-svg" src={`data:image/svg+xml;utf8,${encodeURIComponent(joinSrc(data['image/svg+xml']))}`} alt="" />
  }
  if (data['text/html']) {
    return <div className="nb-html" dangerouslySetInnerHTML={{ __html: sanitize(joinSrc(data['text/html'])) }} />
  }
  for (const mime of ['text/markdown', 'text/latex']) {
    if (data[mime]) {
      return <div className="nb-main md-rendered" dangerouslySetInnerHTML={{ __html: renderMarkdown(joinSrc(data[mime])) }} />
    }
  }
  if (data['application/json'] !== undefined) {
    const v = data['application/json']
    return <pre className="nb-stream">{typeof v === 'string' ? v : JSON.stringify(v, null, 2)}</pre>
  }
  if (data['text/plain']) {
    return <pre className="nb-stream">{stripAnsi(joinSrc(data['text/plain']))}</pre>
  }
  return null
}
