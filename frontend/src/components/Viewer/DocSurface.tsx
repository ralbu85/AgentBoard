import {useLayoutEffect, useRef, useState, type ReactNode} from 'react'
import {CodeEditor} from './CodeEditor'
import type {Memo, SelectionInfo} from './FileContent'
import {isEditableFile, useStore, type ViewerTab} from '../../store'
import {MOD, readPref, useDocSync, writePref, type SaveState} from './docSync'
import {HtmlPreview} from './HtmlPreview'
import {MarkdownPreview} from './MarkdownPreview'
import {openFileTab} from './openFile'

/** Every text file tab is a DocSurface: one toolbar (preview / side by side /
 *  source, click-to-edit, undo, save state), one disk banner and one save
 *  policy (docSync). A format only supplies its rendered view, which edits
 *  through `DocEdit`. Notebooks reuse the toolbar pieces and the edit toggle. */

export type DocMode = 'view' | 'split' | 'source'
type Kind = 'html' | 'markdown' | 'code'
const kindOf = (tab: ViewerTab): Kind => tab.type === 'markdown' ? 'markdown' : tab.type === 'code' && /\.html?$/i.test(tab.name) ? 'html' : 'code'
const modePref = (kind: Kind) => `agentboard.doc.mode.${kind}`
const EDIT_PREF = 'agentboard.doc.edit'
const UNDO_LIMIT = 50
export const EDIT_HINT = `글자를 클릭해 그 자리에서 고칩니다. Enter 저장 · Shift+Enter 줄바꿈 · ${MOD}+Enter 같은 수준에 추가 · Esc 닫기`

/** What a rendered view gets from the surface around it. */
export interface DocEdit {
  writable: boolean
  editing: boolean                                      // ✎ 텍스트 편집 is on
  current: () => string                                 // the buffer, ahead of the prop while an edit travels the store
  apply: (base: string, next: string) => void           // an inline edit: an undo step, the buffer, saved at once
  undo: () => void
  setPaused: (paused: (() => boolean) | null) => void   // an inline editor is open: hold disk loads and undo
  reread: () => Promise<void>                           // read the file from disk now (새로고침)
}

/** The ✎ toggle, shared by every format (HTML, Markdown, notebook cells). */
export function useEditToggle(writable: boolean) {
  const [on, setOn] = useState(() => {
    const saved = readPref(EDIT_PREF)
    return writable && (saved === null ? readPref('agentboard.htmlView.edit') === '1' || readPref('agentboard.mdView.edit') === '1' : saved === '1')
  })
  const toggle = () => { setOn(!on); writePref(EDIT_PREF, on ? '0' : '1') }
  return [writable && on, toggle] as const
}

const SAVE_TEXT: Record<SaveState, string> = {saved: '저장됨', pending: '수정됨', saving: '저장 중…', error: '저장 실패 · 다시 시도 중', conflict: '저장 멈춤'}
export function SaveBadge({state, error}: {state: SaveState; error?: string}) {
  return <span className={`doc-save doc-save-${state}`} role="status"
    title={error || '편집은 자동으로 저장되고, 에이전트가 파일을 바꾸면 1초 안에 반영됩니다.'}>{SAVE_TEXT[state]}</span>
}
export const EditToggle = ({on, onToggle, title = EDIT_HINT}: {on: boolean; onToggle: () => void; title?: string}) =>
  <button className="doc-tool" aria-pressed={on} onClick={onToggle} title={title}>✎ 텍스트 편집</button>
export const DocBanner = ({children}: {children: ReactNode}) => <div className="doc-banner" role="status">{children}</div>

export function DocSurface({tab, ownerKey, memos, onContextMenu, onViewChange}: {
  tab: ViewerTab; ownerKey: string; memos?: Memo[]
  onContextMenu?: (info: SelectionInfo) => void
  onViewChange?: (view: NonNullable<ViewerTab['viewState']>) => void
}) {
  const kind = kindOf(tab), rendered = kind !== 'code', writable = isEditableFile(tab)
  const local = JSON.parse(ownerKey)[0] === 'local'
  const [mode, setModeState] = useState<DocMode>(() => {
    if (!rendered) return 'source'
    const saved = readPref(modePref(kind))
    return saved === 'source' || saved === 'split' && writable ? saved : 'view'
  })
  const [editing, toggleEditing] = useEditToggle(writable)
  const [undoCount, setUndoCount] = useState(0)
  const undoStack = useRef<string[]>([])
  // The latest buffer, ahead of the prop while an edit travels the store.
  const contentRef = useRef(tab.content)
  const lastProp = useRef(tab.content)
  if (lastProp.current !== tab.content) { lastProp.current = tab.content; contentRef.current = tab.content }
  const paused = useRef<(() => boolean) | null>(null)
  const sync = useDocSync(tab, ownerKey, {
    paused: () => !!paused.current?.(),
    onLoad: value => { undoStack.current = []; setUndoCount(0); contentRef.current = value },   // undo must not revert the agent's write
  })
  const [slot, setSlot] = useState<HTMLDivElement | null>(null)

  const change = (value: string) => { contentRef.current = value; useStore.getState().updateTab(tab.id, value, ownerKey) }
  const doc: DocEdit = {
    writable, editing,
    current: () => contentRef.current,
    apply: (base, next) => {
      if (next === base) return
      undoStack.current.push(base)
      if (undoStack.current.length > UNDO_LIMIT) undoStack.current.shift()
      setUndoCount(undoStack.current.length)
      change(next)
      sync.flush()
    },
    undo: () => {
      if (paused.current?.()) return
      const value = undoStack.current.pop()
      setUndoCount(undoStack.current.length)
      if (value === undefined) return
      change(value)
      sync.flush()
    },
    setPaused: fn => { paused.current = fn },
    reread: sync.reread,
  }
  const setMode = (next: DocMode) => { setModeState(next); writePref(modePref(kind), next) }

  // The rendered markdown keeps its scroll position across tab switches.
  const scroller = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    el.scrollTop = tab.viewState?.scrollTop || 0
    const save = () => onViewChange?.({scrollTop: el.scrollTop})
    el.addEventListener('scroll', save, {passive: true})
    return () => el.removeEventListener('scroll', save)
  }, [mode])

  const showsPreview = rendered && mode !== 'source'
  return <div className="doc-surface" tabIndex={-1} onKeyDown={e => {
    if (!showsPreview || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.key.toLowerCase() !== 'z' || (e.target as HTMLElement).closest('textarea, input, .cm-editor, [contenteditable]')) return
    e.preventDefault(); doc.undo()
  }}>
    {(rendered || writable) && <div className="doc-toolbar">
      {rendered && <div className="doc-modes" role="group" aria-label="보기 방식">
        <button aria-pressed={mode === 'view'} onClick={() => setMode('view')}>미리보기</button>
        {writable && <button aria-pressed={mode === 'split'} onClick={() => setMode('split')} title="소스와 미리보기를 나란히">나란히</button>}
        <button aria-pressed={mode === 'source'} onClick={() => setMode('source')}>소스</button>
      </div>}
      {showsPreview && writable && <>
        <EditToggle on={editing} onToggle={toggleEditing}/>
        <button className="doc-tool" disabled={!undoCount} onClick={doc.undo} title={`미리보기에서 한 수정 되돌리기 (${MOD}+Z)`}>↶ 되돌리기</button>
      </>}
      <div className="doc-extras" ref={setSlot}/>
      {writable && <SaveBadge state={sync.state} error={sync.error}/>}
    </div>}
    {sync.conflict && <DocBanner>
      <span>이 탭의 수정과 디스크의 파일이 둘 다 바뀌어 자동 저장을 멈췄습니다. 어느 쪽을 남길까요?</span>
      <button className="doc-tool" onClick={sync.keepDisk}>디스크 버전 불러오기</button>
      <button className="doc-tool" onClick={sync.keepMine}>이 탭 내용으로 저장</button>
    </DocBanner>}
    <div className={`doc-body doc-${mode}`}>
      {mode !== 'view' && <CodeEditor content={tab.content} lang={kind === 'code' ? tab.lang : kind} memos={memos} readOnly={!writable}
        onChange={change} onSave={sync.flush} onContextMenu={onContextMenu} viewState={tab.viewState} onViewChange={onViewChange}/>}
      {showsPreview && (kind === 'html'
        ? <HtmlPreview content={tab.content} path={tab.path} local={local} doc={doc} slot={slot} onOpenFile={file => void openFileTab(file, ownerKey)}/>
        : <div ref={scroller} className="doc-scroll">
          <MarkdownPreview content={tab.content} filePath={tab.path} local={local} doc={doc} slot={slot} delay={mode === 'split' ? 150 : 0} onContextMenu={onContextMenu}
            onOpenFile={file => void openFileTab(file, ownerKey)}/>
        </div>)}
    </div>
  </div>
}
