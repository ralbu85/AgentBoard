import { useEffect, useRef } from 'react'
import { EditorView, keymap, lineNumbers, highlightActiveLine, Decoration, type DecorationSet } from '@codemirror/view'
import { EditorState, type Extension, StateField, StateEffect, Compartment } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import {bracketMatching, indentOnInput, foldGutter, HighlightStyle, syntaxHighlighting} from '@codemirror/language'
import {tags} from '@lezer/highlight'
import { oneDark, oneDarkTheme } from '@codemirror/theme-one-dark'
import type { Memo, SelectionInfo } from './FileContent'

import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { json } from '@codemirror/lang-json'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { cpp } from '@codemirror/lang-cpp'
import { java } from '@codemirror/lang-java'
import { rust } from '@codemirror/lang-rust'
import { sql } from '@codemirror/lang-sql'
import { yaml } from '@codemirror/lang-yaml'
import { markdown } from '@codemirror/lang-markdown'
import { go } from '@codemirror/lang-go'
import { latex } from 'codemirror-lang-latex'

function getLangExt(lang: string): Extension {
  switch (lang) {
    case 'python': case 'py': return python()
    case 'javascript': case 'js': case 'mjs': case 'cjs': case 'jsx': return javascript({ jsx: true })
    case 'typescript': case 'ts': return javascript({ typescript: true })
    case 'tsx': return javascript({ jsx: true, typescript: true })
    case 'json': return json()
    case 'html': case 'xml': case 'svg': return html()
    case 'css': return css()
    case 'cpp': case 'c': case 'h': case 'hpp': return cpp()
    case 'java': return java()
    case 'rust': case 'rs': return rust()
    case 'sql': return sql()
    case 'yaml': case 'yml': return yaml()
    case 'markdown': case 'md': case 'mdx': return markdown()
    case 'go': return go()
    case 'latex': case 'tex': case 'sty': case 'cls': case 'bib': return latex()
    case 'r': case 'rmd': return markdown()
    default: return []
  }
}

// Restrained notebook palette: identifiers and numbers stay neutral;
// only keywords, strings and comments receive subtle color distinctions.
const notebookHighlight = HighlightStyle.define([
  {tag: [tags.name, tags.number, tags.bool, tags.null, tags.operator, tags.punctuation], color: '#c9cdd2'},
  {tag: tags.keyword, color: '#a6bcd4'},
  {tag: [tags.string, tags.regexp], color: '#afc0ab'},
  {tag: tags.comment, color: '#939ba5'},
  {tag: [tags.heading, tags.link], color: '#a6bcd4'},
  {tag: tags.invalid, textDecoration: 'underline wavy #bd9292'},
])
const notebookTheme = EditorView.theme({
  '&': {color: '#c9cdd2', backgroundColor: 'var(--bg-primary)'},
  '.cm-gutters': {color: '#939ba5', backgroundColor: 'var(--bg-primary)', border: 'none'},
  '.cm-activeLine, .cm-activeLineGutter': {backgroundColor: 'rgba(180,190,200,.035)'},
})

// Memo line highlight decoration
const memoLineDeco = Decoration.line({ class: 'cm-memo-line' })
const setMemosEffect = StateEffect.define<{ startLine: number; endLine: number }[]>()

const memoField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decos, tr) {
    for (const e of tr.effects) {
      if (e.is(setMemosEffect)) {
        const builder: any[] = []
        for (const m of e.value) {
          for (let l = m.startLine; l <= m.endLine; l++) {
            if (l <= tr.state.doc.lines) {
              builder.push(memoLineDeco.range(tr.state.doc.line(l).from))
            }
          }
        }
        return Decoration.set(builder.sort((a: any, b: any) => a.from - b.from))
      }
    }
    return decos.map(tr.changes)
  },
  provide: f => EditorView.decorations.from(f),
})

interface Props {
  content: string
  lang: string
  memos?: Memo[]
  onChange: (value: string) => void
  viewState?: { editorScroll?: number; cursor?: number }
  onViewChange?: (view: {editorScroll: number; cursor: number}) => void
  onSave: () => void
  onContextMenu?: (info: SelectionInfo) => void
  readOnly?: boolean
  onRun?: () => void
  compact?: boolean
  ariaLabel?: string
}

export function CodeEditor({ content, lang, memos, onChange, onSave, onContextMenu, viewState, onViewChange, readOnly=false, onRun, compact=false, ariaLabel }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const readonlyComp=useRef(new Compartment())
  const cbRef = useRef({ onChange, onSave, onContextMenu, onViewChange, onRun })
  cbRef.current = { onChange, onSave, onContextMenu, onViewChange, onRun }

  // Recreate editor when lang changes (tab switch)
  useEffect(() => {
    if (!containerRef.current) return

    // Font size: Ctrl+= / Ctrl+- / Ctrl+0, persisted. Reconfigured via compartment.
    const fontComp = new Compartment()
    const readFs = () => { const n = parseInt(localStorage.getItem('agentboard.cmFont') || '13', 10); return isNaN(n) ? 13 : Math.min(24, Math.max(9, n)) }
    const fontTheme = (fs: number) => EditorView.theme({ '&': { fontSize: `${fs}px` } })
    const setFs = (n: number) => {
      const fs = Math.min(24, Math.max(9, n))
      localStorage.setItem('agentboard.cmFont', String(fs))
      viewRef.current?.dispatch({ effects: fontComp.reconfigure(fontTheme(fs)) })
    }

    const extensions: Extension[] = [
      lineNumbers(),
      bracketMatching(), indentOnInput(), foldGutter(),
      readonlyComp.current.of(EditorState.readOnly.of(readOnly)),
      EditorView.contentAttributes.of({'aria-label':ariaLabel||'코드 편집기'}),
      highlightActiveLine(),
      history(),
      search({ top: true }),
      highlightSelectionMatches(),
      fontComp.of(fontTheme(readFs())),
      keymap.of([
        {key: 'Shift-Enter',run:()=>{if(!cbRef.current.onRun)return false;if(!viewRef.current?.state.readOnly)cbRef.current.onRun();return true}},
        indentWithTab,
        ...searchKeymap,   // Ctrl+F find, Ctrl+H replace, F3 next
        ...defaultKeymap,
        ...historyKeymap,
        { key: 'Mod-s', run: () => { cbRef.current.onSave(); return true } },
        { key: 'Mod-=', run: () => { setFs(readFs() + 1); return true } },
        { key: 'Mod-Shift-=', run: () => { setFs(readFs() + 1); return true } },
        { key: 'Mod--', run: () => { setFs(readFs() - 1); return true } },
        { key: 'Mod-0', run: () => { setFs(13); return true } },
      ]),
      EditorView.updateListener.of(update => {
        if (update.docChanged) cbRef.current.onChange(update.state.doc.toString())
        if (update.selectionSet) cbRef.current.onViewChange?.({editorScroll: update.view.scrollDOM.scrollTop, cursor: update.state.selection.main.head})
      }),
      ...(compact ? [oneDarkTheme, notebookTheme, syntaxHighlighting(notebookHighlight)] : [oneDark]),
      EditorView.lineWrapping,
      getLangExt(lang),
      memoField,
    ]

    const view = new EditorView({
      state: EditorState.create({ doc: content, extensions, selection: {anchor: Math.min(content.length, viewState?.cursor || 0)} }),
      parent: containerRef.current,
    })
    viewRef.current = view
    const scroll = () => cbRef.current.onViewChange?.({editorScroll: view.scrollDOM.scrollTop, cursor: view.state.selection.main.head})
    const frame = requestAnimationFrame(() => { view.scrollDOM.scrollTop = viewState?.editorScroll || 0 })
    view.scrollDOM.addEventListener('scroll', scroll)

    const handleCtx = (e: MouseEvent) => {
      const sel = view.state.selection.main
      if (sel.from === sel.to || !cbRef.current.onContextMenu) return
      e.preventDefault()
      const from = view.state.doc.lineAt(sel.from)
      const to = view.state.doc.lineAt(sel.to)
      cbRef.current.onContextMenu({
        startLine: from.number, startCol: sel.from - from.from + 1,
        endLine: to.number, endCol: sel.to - to.from + 1,
        text: view.state.sliceDoc(sel.from, sel.to),
        x: e.clientX, y: e.clientY,
      })
    }
    view.dom.addEventListener('contextmenu', handleCtx)

    return () => {
      cancelAnimationFrame(frame)
      view.scrollDOM.removeEventListener('scroll', scroll)
      view.dom.removeEventListener('contextmenu', handleCtx)
      view.destroy()
      viewRef.current = null
    }
  }, [lang]) // recreate on lang change

  // Sync external content changes (refresh) without recreating
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const cur = view.state.doc.toString()
    if (cur !== content) {
      view.dispatch({ changes: { from: 0, to: cur.length, insert: content } })
    }
  }, [content])

  useEffect(()=>{viewRef.current?.dispatch({effects:readonlyComp.current.reconfigure(EditorState.readOnly.of(readOnly))})},[readOnly])

  // Update memo highlights
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const ranges = (memos || []).map(m => ({ startLine: m.startLine, endLine: m.endLine }))
    view.dispatch({ effects: setMemosEffect.of(ranges) })
  }, [memos])

  return <div ref={containerRef} className={`cm-wrapper ${compact?'cm-cell-editor':''}`} />
}
