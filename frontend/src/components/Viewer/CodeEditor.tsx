import { useEffect, useRef } from 'react'
import { EditorView, keymap, lineNumbers, highlightActiveLine, Decoration, type DecorationSet } from '@codemirror/view'
import { EditorState, type Extension, StateField, StateEffect } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { oneDark } from '@codemirror/theme-one-dark'
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
  onSave: () => void
  onContextMenu: (info: SelectionInfo) => void
}

export function CodeEditor({ content, lang, memos, onChange, onSave, onContextMenu }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const cbRef = useRef({ onChange, onSave, onContextMenu })
  cbRef.current = { onChange, onSave, onContextMenu }

  // Recreate editor when lang changes (tab switch)
  useEffect(() => {
    if (!containerRef.current) return

    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLine(),
      history(),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        { key: 'Mod-s', run: () => { cbRef.current.onSave(); return true } },
      ]),
      EditorView.updateListener.of(update => {
        if (update.docChanged) cbRef.current.onChange(update.state.doc.toString())
      }),
      oneDark,
      EditorView.lineWrapping,
      getLangExt(lang),
      memoField,
    ]

    const view = new EditorView({
      state: EditorState.create({ doc: content, extensions }),
      parent: containerRef.current,
    })
    viewRef.current = view

    const handleCtx = (e: MouseEvent) => {
      const sel = view.state.selection.main
      if (sel.from === sel.to) return
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

  // Update memo highlights
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const ranges = (memos || []).map(m => ({ startLine: m.startLine, endLine: m.endLine }))
    view.dispatch({ effects: setMemosEffect.of(ranges) })
  }, [memos])

  return <div ref={containerRef} className="cm-wrapper" />
}
