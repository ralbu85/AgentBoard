import { useState, useEffect, useRef, useCallback, memo } from 'react'
import { PdfViewer } from '../PdfViewer'
import { renderMarkdown } from '../../markdown'
import { sanitize } from '../../sanitize'

// Lazy highlight.js
let _hljs: any = null
let _hljsLoading: Promise<void> | null = null

const LANG_MAP: Record<string, string> = {
  py: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', jsx: 'javascript',
  json: 'json', sh: 'bash', bash: 'bash', zsh: 'bash',
  css: 'css', html: 'xml', xml: 'xml', svg: 'xml',
  sql: 'sql', yaml: 'yaml', yml: 'yaml',
  go: 'go', rs: 'rust', java: 'java',
  c: 'cpp', cpp: 'cpp', h: 'cpp', hpp: 'cpp',
  tex: 'latex', sty: 'latex', cls: 'latex', bib: 'latex',
  latex: 'latex', r: 'r',
}

async function getHljs() {
  if (_hljs) return _hljs
  if (!_hljsLoading) {
    _hljsLoading = (async () => {
      const [{ default: hljs }, ...langs] = await Promise.all([
        import('highlight.js/lib/core'),
        import('highlight.js/lib/languages/python'),
        import('highlight.js/lib/languages/javascript'),
        import('highlight.js/lib/languages/typescript'),
        import('highlight.js/lib/languages/json'),
        import('highlight.js/lib/languages/bash'),
        import('highlight.js/lib/languages/css'),
        import('highlight.js/lib/languages/xml'),
        import('highlight.js/lib/languages/sql'),
        import('highlight.js/lib/languages/yaml'),
        import('highlight.js/lib/languages/go'),
        import('highlight.js/lib/languages/rust'),
        import('highlight.js/lib/languages/java'),
        import('highlight.js/lib/languages/cpp'),
        import('highlight.js/lib/languages/latex'),
        import('highlight.js/lib/languages/r'),
      ])
      const names = ['python','javascript','typescript','json','bash','css','xml','sql','yaml','go','rust','java','cpp','latex','r']
      langs.forEach((m, i) => hljs.registerLanguage(names[i], m.default))
      _hljs = hljs
    })()
  }
  await _hljsLoading
  return _hljs!
}

async function getMarkdownRenderer() {
  return renderMarkdown
}

function splitHighlightedLines(html: string): string[] {
  const rawLines = html.split('\n')
  const result: string[] = []
  const openTags: string[] = []
  for (const raw of rawLines) {
    let line = openTags.join('') + raw
    const opens = raw.match(/<span[^>]*>/g) || []
    const closes = raw.match(/<\/span>/g) || []
    for (const tag of opens) openTags.push(tag)
    for (let i = 0; i < closes.length; i++) openTags.pop()
    line += '</span>'.repeat(openTags.length)
    result.push(line)
  }
  return result
}

export interface Memo {
  startLine: number
  startCol?: number
  endLine: number
  endCol?: number
  text: string
  selectedText?: string
}

export interface SelectionInfo {
  startLine: number
  startCol: number
  endLine: number
  endCol: number
  text: string
  x: number
  y: number
}

interface Props {
  content: string
  type: 'code' | 'markdown' | 'latex' | 'pdf' | 'image'
  lang: string
  memos?: Memo[]
  noLineNumbers?: boolean
  onContextMenu?: (info: SelectionInfo) => void
}

export const FileContent = memo(function FileContent({ content, type, lang, memos, noLineNumbers, onContextMenu: onCtxMenu }: Props) {
  const [highlighted, setHighlighted] = useState('')
  const [highlightedLines, setHighlightedLines] = useState<string[]>([])
  const [mdHtml, setMdHtml] = useState('')
  const codeRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    if (type === 'code') {
      const escaped = content.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      setHighlighted(escaped)
      setHighlightedLines(escaped.split('\n'))
      const mappedLang = LANG_MAP[lang] || lang
      getHljs().then(hljs => {
        try {
          let html: string
          if (mappedLang && hljs.getLanguage(mappedLang)) {
            html = hljs.highlight(content, { language: mappedLang }).value
          } else {
            html = hljs.highlightAuto(content).value
          }
          html = sanitize(html)
          setHighlighted(html)
          setHighlightedLines(splitHighlightedLines(html))
        } catch {}
      })
    } else if (type === 'markdown') {
      setMdHtml(content.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br/>'))
      getMarkdownRenderer().then(render => { setMdHtml(render(content)) })
    }
  }, [content, lang, type])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (!onCtxMenu) return
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return
    e.preventDefault() // suppress browser context menu

    const selectedText = sel.toString()
    const range = sel.getRangeAt(0)
    const pre = codeRef.current
    if (!pre) return
    const rows = pre.querySelectorAll('tr')

    const findPos = (node: Node, offset: number) => {
      let el: HTMLElement | null = node instanceof HTMLElement ? node : node.parentElement
      while (el && el.tagName !== 'TR') el = el.parentElement
      const line = el ? Array.from(rows).indexOf(el) + 1 : 0
      const td = el?.querySelector('.fv-line-content')
      if (!td) return { line, col: offset + 1 }
      const r = document.createRange()
      r.setStart(td, 0)
      r.setEnd(node, offset)
      const col = r.toString().length + 1
      return { line, col }
    }

    const start = findPos(range.startContainer, range.startOffset)
    const end = findPos(range.endContainer, range.endOffset)
    if (!start.line || !end.line) return

    onCtxMenu({ startLine: start.line, startCol: start.col, endLine: end.line, endCol: end.col, text: selectedText, x: e.clientX, y: e.clientY })
  }, [onCtxMenu])

  if (type === 'pdf') return <PdfViewer url={content} />
  if (type === 'image') return <div className="fv-image"><img src={content} alt="" /></div>
  if (type === 'markdown') return <div className="fv-markdown" dangerouslySetInnerHTML={{ __html: mdHtml }} />

  // Simple mode (overlay behind textarea): no line numbers, no table
  if (noLineNumbers) {
    return (
      <pre className="fv-code hljs" ref={codeRef}>
        <code dangerouslySetInnerHTML={{ __html: highlighted }} />
      </pre>
    )
  }

  // Full mode with line numbers + memo indicators
  const memoByLine = new Map<number, string>()
  if (memos) {
    for (const m of memos) {
      for (let i = m.startLine; i <= m.endLine; i++) {
        const existing = memoByLine.get(i)
        memoByLine.set(i, existing ? existing + '\n' + m.text : m.text)
      }
    }
  }

  return (
    <pre className="fv-code fv-code-lines" ref={codeRef} onContextMenu={handleContextMenu}>
      <table className="fv-line-table">
        <tbody>
          {highlightedLines.map((lineHtml, i) => {
            const num = i + 1
            const lineMemo = memoByLine.get(num)
            return (
              <tr key={num} className={lineMemo ? 'ln-memo' : undefined}>
                <td className="fv-gutter">{lineMemo && <span className="gutter-dot" />}{num}</td>
                <td className="fv-line-content" data-memo={lineMemo || undefined}>
                  <code dangerouslySetInnerHTML={{ __html: lineHtml || ' ' }} />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </pre>
  )
})
