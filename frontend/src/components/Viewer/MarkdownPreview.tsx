import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import type {SelectionInfo} from './FileContent'
import type {DocEdit} from './DocSurface'
import {useToasts} from '../../toasts'
import {writeClipboard} from '../Terminal/clipboard'
import {MOD, readPref, writePref} from './docSync'
import {deleteBlock, insertAfter, isQuarto, locateBlock, renderBlocks, replaceBlock, toggleTask, type MdBlock} from './markdownBlocks'
import {INLINE_KINDS, inlineModel, normalize, readInline, readTyped} from './markdownInline'
import type {Links} from 'marked'
import type {MarkdownAttachments} from '../../markdown'

/** Rendered Markdown / Quarto (Notion-style), editable block by block: a click
 *  on a paragraph, heading or list item edits its text where it is rendered;
 *  other blocks (code, tables, math) and 원문 open the block's own markdown. */
const MD_ZOOM_LEVELS = [0.5, 0.75, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2, 2.5]

interface Editor {
  mode: 'edit' | 'add'   // edit `block`, or add a sibling after it
  block: MdBlock
  host: HTMLElement      // mount point inserted next to the rendered block (its toolbar)
  el?: HTMLElement       // the rendered block, hidden while its markdown is edited
  initial: string
  caret: number
  inline?: InlineEdit    // edited where it is rendered, not as markdown
}

/** A block's text made editable in the rendered document. */
interface InlineEdit {
  region: HTMLElement    // the contenteditable text
  anchor: HTMLElement    // the block's element (for a new block: the one it follows)
  read: () => string     // the block's markdown as it stands now ('' when emptied)
  cleanup: () => void    // puts the rendered block back as it was
}

const BLOCK_TAGS = /^(ul|ol|p|div|pre|blockquote|table|h[1-6]|details|hr|dl|figure|section|header)$/
const makeEditable = (region: HTMLElement) => {
  region.classList.add('md-inline-edit')
  region.setAttribute('contenteditable', 'plaintext-only')
  if (region.isContentEditable === false) region.setAttribute('contenteditable', 'true')   // no plaintext-only
  region.tabIndex = -1
  return region
}

/** Make the block's own text editable where it is shown; null when the text
 *  on screen can't be mapped back to its markdown (the caller opens that). */
function editInPlace(block: MdBlock, el: HTMLElement, opts: {quarto: boolean; filePath?: string; links: Links; attachments?: MarkdownAttachments}): InlineEdit | null {
  const model = inlineModel(block, opts)
  if (!model) return null
  const snapshot = el.innerHTML
  let region = el
  if (block.kind === 'item') {
    if (el.localName !== 'li') return null
    // A loose item's text is its first paragraph. The task box and sub-lists stay out of the edit.
    const lead = Array.from(el.children).find(c => c.localName !== 'input')
    const box = lead?.localName === 'p' && !lead.hasAttribute('data-mb') ? lead : el
    const nodes: ChildNode[] = []
    for (const node of Array.from(box.childNodes)) {
      if (node instanceof Element && node.localName === 'input') continue
      if (node instanceof Element && BLOCK_TAGS.test(node.localName)) break
      nodes.push(node)
    }
    region = document.createElement('span')
    if (nodes[0]) nodes[0].before(region)
    else box.append(region)
    region.append(...nodes)
  }
  if (normalize(region.textContent || '') !== normalize(model.text)) { el.innerHTML = snapshot; return null }
  region.innerHTML = model.html
  for (const atom of region.querySelectorAll<HTMLElement>('[data-ma]')) atom.contentEditable = 'false'
  for (const link of region.querySelectorAll('a')) link.removeAttribute('href')   // a click places the caret
  makeEditable(region)
  return {region, anchor: el, read: () => readInline(model, region), cleanup: () => {
    el.innerHTML = snapshot
    if (region === el) { el.classList.remove('md-inline-edit'); el.removeAttribute('contenteditable'); el.removeAttribute('tabindex') }
  }}
}

/** An empty block of the same kind right after `el`, to type a new sibling into. */
function addInPlace(block: MdBlock, el: HTMLElement): InlineEdit | null {
  const tag = block.kind === 'item' ? el.localName === 'li' && 'li'
    : block.kind === 'heading' ? /^h[1-6]$/.test(el.localName) && el.localName
    : !block.sibling && 'p'
  if (!tag) return null
  const region = document.createElement(tag)
  region.className = 'md-inline-new'
  region.dataset.placeholder = tag === 'li' ? '새 항목' : tag === 'p' ? '새 문단' : '새 제목'
  ;(el.closest('summary') ?? el).after(region)
  return {region: makeEditable(region), anchor: el, read: () => block.sibling + readTyped(region), cleanup: () => region.remove()}
}

/** Put the caret where the click landed (else at the end of the text). */
function placeCaret(region: HTMLElement, x?: number, y?: number) {
  region.focus({preventScroll: true})
  const selection = window.getSelection()
  if (!selection) return
  const doc = document as Document & {caretPositionFromPoint?: (x: number, y: number) => {offsetNode: Node; offset: number} | null}
  let range: Range | null = null
  if (x !== undefined && y !== undefined) {
    const pos = doc.caretPositionFromPoint?.(x, y)
    if (pos) { range = document.createRange(); range.setStart(pos.offsetNode, pos.offset) }
    else range = document.caretRangeFromPoint?.(x, y) ?? null
    if (range && !region.contains(range.startContainer)) range = null
  }
  if (!range) { range = document.createRange(); range.selectNodeContents(region); range.collapse(false) }
  selection.removeAllRanges(); selection.addRange(range)
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

export function MarkdownPreview({content, filePath, attachments, doc, slot, delay = 0, zoomable = true, onContextMenu}: {
  content: string; filePath?: string; doc?: DocEdit; slot?: HTMLElement | null
  attachments?: MarkdownAttachments   // a notebook cell's images
  delay?: number                      // side by side: re-render once typing pauses
  zoomable?: boolean                  // a notebook cell follows the notebook, not the document zoom
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
  const pending = useRef<{at: number; inline: boolean} | null>(null)   // open an addition after the block starting here, once rendered
  const current = () => doc ? doc.current() : content
  // The document only re-renders when no editor is open: a re-render would
  // replace the element the editor is mounted next to.
  const [shown, setShown] = useState(content)
  useEffect(() => {
    if (editor || shown === content) return
    const timer = window.setTimeout(() => setShown(content), delay)
    return () => window.clearTimeout(timer)
  }, [content, editor, delay])
  const rendered = useMemo(() => renderBlocks(shown, {filePath, quarto, tasks: writable, attachments}), [shown, filePath, quarto, writable, attachments])
  useEffect(() => { doc?.setPaused(() => !!editorRef.current || pending.current !== null); return () => doc?.setPaused(null) }, [])
  const toast = (text: string) => useToasts.getState().push(text)

  const apply = (base: string, next: string) => {
    if (next === base) return
    setShown(next)
    doc?.apply(base, next)
  }

  const open = (mode: Editor['mode'], block: MdBlock, el: HTMLElement, caret?: number, text?: string) => {
    const host = document.createElement(el.tagName === 'LI' ? 'li' : 'div')
    host.className = 'md-block-editor'
    // Something inside a collapsed callout or cell would open out of sight.
    for (let d = el.closest('details'); d; d = d.parentElement?.closest('details') ?? null) d.open = true
    const summary = el.closest('summary')   // a callout title
    if (summary) summary.after(host)
    else if (mode === 'edit') el.before(host)
    else el.after(host)
    if (mode === 'edit') el.hidden = true
    const initial = text ?? (mode === 'edit' ? block.text : block.sibling)
    const next: Editor = {mode, block, host, el: mode === 'edit' ? el : undefined, initial, caret: caret ?? initial.length}
    draft.current = initial
    editorRef.current = next
    setEditor(next)
  }
  /** Edit the block's text where it is rendered; false when it has to be edited as markdown. */
  const openInline = (mode: Editor['mode'], block: MdBlock, el: HTMLElement, x?: number, y?: number) => {
    const inline = mode === 'edit' ? editInPlace(block, el, {quarto, filePath, links: rendered.links, attachments}) : addInPlace(block, el)
    if (!inline) return false
    for (let d = el.closest('details'); d; d = d.parentElement?.closest('details') ?? null) d.open = true
    const host = document.createElement(inline.region.localName === 'li' || el.localName === 'li' ? 'li' : 'div')
    host.className = 'md-block-editor'
    ;(mode === 'add' ? inline.region : el.closest('summary') ?? el).after(host)
    const ed: Editor = {mode, block, host, initial: mode === 'edit' ? block.text : block.sibling, caret: 0, inline}
    // Every way out keeps the text, as in the markdown editor; only 취소 drops it.
    const keydown = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return   // Korean IME commits with Enter
      const mod = e.ctrlKey || e.metaKey, key = e.key.toLowerCase()
      if (key !== 'escape' && key !== 'enter' && !(mod && key === 's')) return
      e.preventDefault(); e.stopPropagation()
      if (key === 'enter' && e.shiftKey && !mod) document.execCommand?.('insertText', false, '\n')
      else commitRef.current(ed, inline.read(), key === 'enter' && mod ? 'add' : undefined)
    }
    // Switching windows keeps the editor; clicking elsewhere saves it.
    const focusout = (e: FocusEvent) => {
      const to = e.relatedTarget as Node | null
      if (!document.hasFocus() || ed.host.contains(to) || inline.region.contains(to)) return
      commitRef.current(ed, inline.read())
    }
    inline.region.addEventListener('keydown', keydown)
    inline.region.addEventListener('focusout', focusout)
    const restore = inline.cleanup
    inline.cleanup = () => { inline.region.removeEventListener('keydown', keydown); inline.region.removeEventListener('focusout', focusout); restore() }
    editorRef.current = ed
    setEditor(ed)
    placeCaret(inline.region, x, y)
    return true
  }
  const close = () => {
    const ed = editorRef.current
    if (!ed) return
    editorRef.current = null
    ed.inline?.cleanup()
    ed.host.remove()
    if (ed.el) ed.el.hidden = false
    setEditor(null)
  }
  const readDraft = (ed: Editor) => ed.inline ? ed.inline.read() : draft.current
  /** After `base` became `next`, add a sibling after the block starting at `at`. */
  const addAfter = (at: number, changed: boolean, inline: boolean) => {
    if (changed) { pending.current = {at, inline}; return }
    const k = rendered.blocks.map(b => b.start).lastIndexOf(at)
    const el = k < 0 ? null : bodyRef.current?.querySelector<HTMLElement>(`[data-mb="${k}"]`)
    if (el && !(inline && openInline('add', rendered.blocks[k], el))) open('add', rendered.blocks[k], el)
  }
  useLayoutEffect(() => {
    const next = pending.current
    if (next === null) return
    pending.current = null
    addAfter(next.at, false, next.inline)
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
      if (then) addAfter(result.at, true, !!ed.inline)
      return
    }
    if (text === ed.block.text) { close(); if (then) addAfter(ed.block.start, false, !!ed.inline); return }
    const at = locateBlock(base, ed.block)
    if (!at) { refuse(value); return }
    if (!text.trim() && at.next !== at.end) { toast('하위 항목이 있어 비울 수 없습니다. 지우려면 삭제를 누르세요.'); return }
    close()
    apply(base, text.trim() ? replaceBlock(base, at, text) : deleteBlock(base, at))
    if (then && text.trim()) addAfter(at.start, true, !!ed.inline)
  }
  const remove = (ed: Editor) => {
    if (editorRef.current !== ed || ed.mode !== 'edit') return
    const base = current(), at = locateBlock(base, ed.block)
    if (!at) { refuse(readDraft(ed)); return }
    close()
    apply(base, deleteBlock(base, at))
  }
  const cancel = (ed: Editor) => { if (editorRef.current === ed) close() }
  /** 원문: carry on in the block's markdown, with what was typed so far. */
  const toSource = (ed: Editor) => {
    if (editorRef.current !== ed || !ed.inline) return
    const text = ed.inline.read(), anchor = ed.inline.anchor
    close()
    open(ed.mode, ed.block, anchor, undefined, ed.mode === 'edit' ? text || ed.block.text : text)
  }
  // Leaving the view (tab switch, source mode) or turning editing off keeps what was typed.
  const commitRef = useRef(commit); commitRef.current = commit
  useEffect(() => () => { if (editorRef.current) commitRef.current(editorRef.current, readDraft(editorRef.current)) }, [])
  useEffect(() => { if (!editing && editorRef.current) commit(editorRef.current, readDraft(editorRef.current)) }, [editing])

  const handleClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    if (!target.isConnected) return   // a commit re-rendered the document under this click
    if (target instanceof HTMLInputElement && target.type === 'checkbox') {
      const li = target.closest<HTMLElement>('li[data-mb]'), block = li ? rendered.blocks[Number(li.dataset.mb)] : undefined
      if (editorRef.current) { e.preventDefault(); return }   // finish the open edit first
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
    if (!(INLINE_KINDS.has(block.kind) && openInline('edit', block, el, e.clientX, e.clientY))) open('edit', block, el, caretFor(block.text, e.clientX, e.clientY))
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
    <div ref={bodyRef} className={`md-rendered ${editing ? 'md-editable' : ''}`} style={zoomable ? {zoom} : undefined} dangerouslySetInnerHTML={{ __html: rendered.html }}
      onContextMenu={handleContextMenu} onClick={handleClick} onPointerOver={handleHover} onPointerLeave={handleHover} />
    {editor && createPortal(editor.inline
      ? <InlineBar mode={editor.mode} onCommit={then => commit(editor, editor.inline!.read(), then)} onCancel={() => cancel(editor)} onDelete={() => remove(editor)} onSource={() => toSource(editor)}/>
      : <BlockEditor key={editor.block.start + editor.mode} editor={editor} onDraft={value => { draft.current = value }}
        onCommit={(value, then) => commit(editor, value, then)} onCancel={() => cancel(editor)} onDelete={() => remove(editor)}/>, editor.host)}
  </>
}

/** The toolbar under a block edited where it is rendered. */
function InlineBar({mode, onCommit, onCancel, onDelete, onSource}: {
  mode: Editor['mode']; onCommit: (then?: 'add') => void; onCancel: () => void; onDelete: () => void; onSource: () => void
}) {
  const keep = (e: React.MouseEvent) => e.preventDefault()   // buttons must not take the caret out of the text
  return <div className="md-block-editor-bar">
    <button className="primary" onMouseDown={keep} onClick={() => onCommit()}>저장</button>
    <button onMouseDown={keep} onClick={() => onCommit('add')}>＋ 아래에 추가</button>
    {mode === 'edit' && <button onMouseDown={keep} onClick={onDelete}>삭제</button>}
    <button onMouseDown={keep} onClick={onSource} title="이 블록을 마크다운 원문으로 고칩니다 (굵게·링크·수식 넣기)">원문</button>
    <button onMouseDown={keep} onClick={onCancel} title="이번 수정을 버립니다">취소</button>
    <span className="md-block-editor-hint">{`Enter 저장 · Shift+Enter 줄바꿈 · ${MOD}+Enter 아래에 추가 · Esc 닫기`}</span>
  </div>
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
