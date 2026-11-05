import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import type {SelectionInfo} from './FileContent'
import type {DocEdit} from './DocSurface'
import {useToasts} from '../../toasts'
import {writeClipboard} from '../Terminal/clipboard'
import {MOD, readPref, writePref} from './docSync'
import {deleteBlock, insertAfter, isQuarto, locateBlock, renderBlocks, replaceBlock, toggleTask, type MdBlock} from './markdownBlocks'

/** Rendered Markdown / Quarto (Notion-style), editable block by block: a click
 *  opens the block's own markdown in place. */
const MD_ZOOM_LEVELS = [0.5, 0.75, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2, 2.5]

interface Editor {
  mode: 'edit' | 'add'   // edit `block`, or add a sibling after it
  block: MdBlock
  host: HTMLElement      // mount point inserted next to the rendered block
  el?: HTMLElement       // the rendered block, hidden while it is edited
  initial: string
  caret: number
}

/** Where in the block's source a click landed: the rendered text just before
 *  the caret, looked up in the source. */
function caretFor(text: string, x: number, y: number): number | undefined {
  const doc = document as Document & {caretPositionFromPoint?: (x: number, y: number) => {offsetNode: Node; offset: number} | null}
  const pos = doc.caretPositionFromPoint?.(x, y)
  const range = pos ? null : document.caretRangeFromPoint?.(x, y)
  const node = pos?.offsetNode ?? range?.startContainer, offset = pos?.offset ?? range?.startOffset ?? 0
  if (!node || node.nodeType !== Node.TEXT_NODE) return
  const before = (node.textContent || '').slice(0, offset).slice(-16)
  for (let n = before.length; n >= 2; n--) {
    const k = text.indexOf(before.slice(-n))
    if (k >= 0) return k + n
  }
}

export function MarkdownPreview({content, filePath, doc, slot, delay = 0, onContextMenu}: {
  content: string; filePath?: string; doc?: DocEdit; slot?: HTMLElement | null
  delay?: number   // side by side: re-render once typing pauses
  onContextMenu?: (info: SelectionInfo) => void
}) {
  const writable = !!doc?.writable
  const editing = !!doc?.editing
  const quarto = isQuarto(filePath || '')
  const bodyRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState<number>(() => {
    const saved = parseFloat(readPref('md-zoom') || '1')
    return MD_ZOOM_LEVELS.includes(saved) ? saved : 1
  })
  useEffect(() => { writePref('md-zoom', String(zoom)) }, [zoom])
  const [editor, setEditor] = useState<Editor | null>(null)
  const editorRef = useRef<Editor | null>(null)
  const draft = useRef('')                       // the open editor's current text
  const pending = useRef<number | null>(null)    // open an addition after the block starting here, once rendered
  const current = () => doc ? doc.current() : content
  // The document only re-renders when no editor is open: a re-render would
  // replace the element the editor is mounted next to.
  const [shown, setShown] = useState(content)
  useEffect(() => {
    if (editor || shown === content) return
    const timer = window.setTimeout(() => setShown(content), delay)
    return () => window.clearTimeout(timer)
  }, [content, editor, delay])
  const rendered = useMemo(() => renderBlocks(shown, {filePath, quarto, tasks: writable}), [shown, filePath, quarto, writable])
  useEffect(() => { doc?.setPaused(() => !!editorRef.current || pending.current !== null); return () => doc?.setPaused(null) }, [])
  const toast = (text: string) => useToasts.getState().push(text)

  const apply = (base: string, next: string) => {
    if (next === base) return
    setShown(next)
    doc?.apply(base, next)
  }

  const open = (mode: Editor['mode'], block: MdBlock, el: HTMLElement, caret?: number) => {
    const host = document.createElement(el.tagName === 'LI' ? 'li' : 'div')
    host.className = 'md-block-editor'
    // Something inside a collapsed callout or cell would open out of sight.
    for (let d = el.closest('details'); d; d = d.parentElement?.closest('details') ?? null) d.open = true
    const summary = el.closest('summary')   // a callout title
    if (summary) summary.after(host)
    else if (mode === 'edit') el.before(host)
    else el.after(host)
    if (mode === 'edit') el.hidden = true
    const initial = mode === 'edit' ? block.text : block.sibling
    const next: Editor = {mode, block, host, el: mode === 'edit' ? el : undefined, initial, caret: caret ?? initial.length}
    draft.current = initial
    editorRef.current = next
    setEditor(next)
  }
  const close = () => {
    const ed = editorRef.current
    if (!ed) return
    ed.host.remove()
    if (ed.el) ed.el.hidden = false
    editorRef.current = null
    setEditor(null)
  }
  /** After `base` became `next`, add a sibling after the block starting at `at`. */
  const addAfter = (at: number, changed: boolean) => {
    if (changed) { pending.current = at; return }
    const k = rendered.blocks.map(b => b.start).lastIndexOf(at)
    const el = k < 0 ? null : bodyRef.current?.querySelector<HTMLElement>(`[data-mb="${k}"]`)
    if (el) open('add', rendered.blocks[k], el)
  }
  useLayoutEffect(() => {
    const at = pending.current
    if (at === null) return
    pending.current = null
    addAfter(at, false)
  }, [rendered])

  // The source moved under an open editor: keep the typing safe and say so.
  const refuse = (value: string) => {
    void writeClipboard(value).catch(() => {})
    toast('편집하는 동안 원본이 바뀌어 이 블록을 찾지 못했습니다. 입력한 내용은 클립보드에 복사했습니다.')
  }
  const commit = (ed: Editor, value: string, then?: 'add') => {
    if (editorRef.current !== ed) return
    const base = current(), text = value.trimEnd()
    if (ed.mode === 'add') {
      if (!text.trim() || text.trim() === ed.block.sibling.trim()) { close(); return }
      const at = locateBlock(base, ed.block)
      if (!at) { refuse(value); return }
      const result = insertAfter(base, at, text)
      close()
      apply(base, result.content)
      if (then) addAfter(result.at, true)
      return
    }
    if (text === ed.block.text) { close(); if (then) addAfter(ed.block.start, false); return }
    const at = locateBlock(base, ed.block)
    if (!at) { refuse(value); return }
    if (!text.trim() && at.next !== at.end) { toast('하위 항목이 있어 비울 수 없습니다. 지우려면 삭제를 누르세요.'); return }
    close()
    apply(base, text.trim() ? replaceBlock(base, at, text) : deleteBlock(base, at))
    if (then && text.trim()) addAfter(at.start, true)
  }
  const remove = (ed: Editor) => {
    if (editorRef.current !== ed || ed.mode !== 'edit') return
    const base = current(), at = locateBlock(base, ed.block)
    if (!at) { refuse(draft.current); return }
    close()
    apply(base, deleteBlock(base, at))
  }
  const cancel = (ed: Editor) => { if (editorRef.current === ed) close() }
  // Leaving the view (tab switch, source mode) or turning editing off keeps what was typed.
  const commitRef = useRef(commit); commitRef.current = commit
  useEffect(() => () => { if (editorRef.current) commitRef.current(editorRef.current, draft.current) }, [])
  useEffect(() => { if (!editing && editorRef.current) commit(editorRef.current, draft.current) }, [editing])

  const handleClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    if (!target.isConnected) return   // a commit re-rendered the document under this click
    if (target instanceof HTMLInputElement && target.type === 'checkbox') {
      const li = target.closest<HTMLElement>('li[data-mb]'), block = li ? rendered.blocks[Number(li.dataset.mb)] : undefined
      if (!writable || !block || target.disabled) return
      const base = current(), at = locateBlock(base, block)
      if (!at) { e.preventDefault(); toast('파일이 바뀌어 체크 상자를 찾지 못했습니다.'); return }
      apply(base, toggleTask(base, at))
      return
    }
    if (!editing || editorRef.current || target.closest('a')) return
    const el = target.closest<HTMLElement>('[data-mb]')
    if (!el || !bodyRef.current?.contains(el)) return
    const summary = target.closest('summary')
    if (summary && !summary.contains(el)) return   // expanding a collapsed cell or callout
    if (window.getSelection()?.toString().trim()) return   // selecting text for a memo
    const block = rendered.blocks[Number(el.dataset.mb)]
    if (!block) return
    e.preventDefault()
    open('edit', block, el, caretFor(block.text, e.clientX, e.clientY))
  }
  // Outline only the innermost block under the pointer.
  const hovered = useRef<HTMLElement | null>(null)
  const handleHover = (e: React.PointerEvent) => {
    const el = editing && !editorRef.current ? (e.target as HTMLElement).closest<HTMLElement>('[data-mb]') : null
    if (el === hovered.current) return
    hovered.current?.removeAttribute('data-mb-hover')
    el?.setAttribute('data-mb-hover', '')
    hovered.current = el
  }
  useEffect(() => { if (!editing || editor) { hovered.current?.removeAttribute('data-mb-hover'); hovered.current = null } }, [editing, editor])

  const zoomIn = () => setZoom(z => MD_ZOOM_LEVELS[Math.min(MD_ZOOM_LEVELS.indexOf(z) + 1, MD_ZOOM_LEVELS.length - 1)] ?? z)
  const zoomOut = () => setZoom(z => MD_ZOOM_LEVELS[Math.max(MD_ZOOM_LEVELS.indexOf(z) - 1, 0)] ?? z)

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (!onContextMenu) return
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return
    e.preventDefault()
    e.stopPropagation()
    const text = sel.toString().trim()
    if(!bodyRef.current?.contains(sel.anchorNode)||!bodyRef.current.contains(sel.focusNode))return
    // Only claim line numbers for a unique exact source match. Rendered
    // emphasis, links and repeated passages are located by their quoted text.
    const offset=content.indexOf(text)
    const exact=offset>=0&&content.indexOf(text,offset+1)<0
    const startLine=exact?content.slice(0,offset).split('\n').length:0
    const endLine=exact?startLine+text.split('\n').length-1:0
    onContextMenu({ startLine, startCol: 0, endLine, endCol: 0, text, x: e.clientX, y: e.clientY })
  }, [onContextMenu, content])

  const crlf = writable && !rendered.blocks.length && shown.includes('\r')
  return <>
    {slot && createPortal(<>
      {crlf && <span className="doc-note">CRLF 줄바꿈 파일은 소스에서만 고칠 수 있습니다</span>}
      {onContextMenu && <button className="doc-tool" onMouseDown={e=>e.preventDefault()} onClick={handleContextMenu} title="문장을 선택한 뒤 메모 추가">선택에 메모</button>}
      <button className="md-zoom-btn" onClick={zoomOut} title="축소">−</button>
      <span className="md-zoom-label" onClick={() => setZoom(1)} title="100%로">{Math.round(zoom * 100)}%</span>
      <button className="md-zoom-btn" onClick={zoomIn} title="확대">+</button>
    </>, slot)}
    <div ref={bodyRef} className={`md-rendered ${editing ? 'md-editable' : ''}`} style={{ zoom }} dangerouslySetInnerHTML={{ __html: rendered.html }}
      onContextMenu={handleContextMenu} onClick={handleClick} onPointerOver={handleHover} onPointerLeave={handleHover} />
    {editor && createPortal(<BlockEditor key={editor.block.start + editor.mode} editor={editor} onDraft={value => { draft.current = value }}
      onCommit={(value, then) => commit(editor, value, then)} onCancel={() => cancel(editor)} onDelete={() => remove(editor)}/>, editor.host)}
  </>
}

function BlockEditor({editor, onDraft, onCommit, onCancel, onDelete}: {
  editor: Editor; onDraft: (value: string) => void; onCommit: (value: string, then?: 'add') => void; onCancel: () => void; onDelete: () => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const fit = () => { const t = ref.current; if (t) { t.style.height = 'auto'; t.style.height = `${t.scrollHeight + 2}px` } }
  useLayoutEffect(() => {
    const t = ref.current
    if (!t) return
    fit()
    t.focus({preventScroll: true})
    t.setSelectionRange(editor.caret, editor.caret)
    t.closest('.md-block-editor')?.scrollIntoView?.({block: 'nearest'})
  }, [])
  const multiline = editor.block.multiline && editor.mode === 'edit'
  const value = () => ref.current?.value ?? editor.initial
  const keep = (e: React.MouseEvent) => e.preventDefault()   // buttons must not blur the text
  return <>
    <textarea ref={ref} className="md-block-editor-text" defaultValue={editor.initial} spellCheck={false} placeholder="새 텍스트"
      aria-label={editor.mode === 'add' ? '새 블록' : '블록 원본 편집'}
      onInput={() => { fit(); onDraft(value()) }}
      onKeyDown={e => {
        // Every way out of the editor keeps the text; only 취소 drops it.
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCommit(value()); return }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); onCommit(value()); return }
        if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.keyCode === 229) return   // Korean IME commits with Enter
        if (e.ctrlKey || e.metaKey) { e.preventDefault(); e.stopPropagation(); onCommit(value(), 'add'); return }
        if (e.shiftKey || multiline) return
        e.preventDefault(); e.stopPropagation(); onCommit(value())
      }}
      onBlur={e => {
        // Switching windows keeps the editor; clicking elsewhere saves it.
        if (!document.hasFocus() || editor.host.contains(e.relatedTarget as Node | null)) return
        onCommit(value())
      }}/>
    <div className="md-block-editor-bar">
      <button className="primary" onMouseDown={keep} onClick={() => onCommit(value())}>저장</button>
      <button onMouseDown={keep} onClick={() => onCommit(value(), 'add')}>＋ 아래에 추가</button>
      {editor.mode === 'edit' && <button onMouseDown={keep} onClick={onDelete}>삭제</button>}
      <button onMouseDown={keep} onClick={onCancel} title="이번 수정을 버립니다">취소</button>
      <span className="md-block-editor-hint">{multiline ? `${MOD}+S 저장 · ${MOD}+Enter 아래에 추가 · Esc 닫기` : `Enter 저장 · Shift+Enter 줄바꿈 · ${MOD}+Enter 아래에 추가 · Esc 닫기`}</span>
    </div>
  </>
}
