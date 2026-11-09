import {useLayoutEffect, useRef, useState, type ReactNode} from 'react'
import {CodeEditor} from './CodeEditor'
import type {Memo, SelectionInfo} from './FileContent'
import {isEditableFile, useStore, type ViewerTab} from '../../store'
import {MOD, readPref, useDocSync, writePref, type SaveState} from './docSync'
import {HtmlPreview} from './HtmlPreview'
import {MarkdownPreview} from './MarkdownPreview'
import {openFileTab} from './openFile'

/** Every text file tab is a DocSurface: one toolbar (보기 / 편집 / 나란히 /
 *  소스, undo, save state), one disk banner and one save policy (docSync). A
 *  format only supplies its rendered view, which edits through `DocEdit`.
 *  Notebooks reuse the toolbar pieces and the modes. */

// 보기 never edits on a click; 편집 edits where it is rendered; 나란히 adds the source.
export type DocMode = 'view' | 'edit' | 'split' | 'source'
type Kind = 'html' | 'markdown' | 'code'
const kindOf = (tab: ViewerTab): Kind => tab.type === 'markdown' ? 'markdown' : tab.type === 'code' && /\.html?$/i.test(tab.name) ? 'html' : 'code'
const EDIT_PREF = 'agentboard.doc.edit'   // the old ✎ switch: who had it on starts in 편집
const UNDO_LIMIT = 50
export const EDIT_HINT = `글자를 클릭해 그 자리에서 고칩니다. Enter 저장 · Shift+Enter 줄바꿈 · ${MOD}+Enter 같은 수준에 추가 · Esc 닫기`

/** What a rendered view gets from the surface around it. */
export interface DocEdit {
  writable: boolean
  editing: boolean                                      // a click edits (편집, 나란히)
  current: () => string                                 // the buffer, ahead of the prop while an edit travels the store
  apply: (base: string, next: string) => void           // an inline edit: an undo step, the buffer, saved at once
  undo: () => void
  setPaused: (paused: (() => boolean) | null) => void   // an inline editor is open: hold disk loads and undo
  reread: () => Promise<void>                           // read the file from disk now (새로고침)
  showSource?: (range: {from: number; to: number} | null) => void   // 원문: this part of the file in the source
}

/** The mode a kind of document was last shown in, among `allowed` (the first is the fallback). */
export function useDocMode(name: string, allowed: DocMode[]) {
  const key = `agentboard.doc.view.${name}`
  const [mode, setState] = useState<DocMode>(() => {
    const saved = readPref(key) as DocMode | null
    if (saved && allowed.includes(saved)) return saved
    const old = readPref(`agentboard.doc.mode.${name}`)   // from before 편집 was a mode
    const was: DocMode = old === 'source' || old === 'split' ? old : readPref(EDIT_PREF) === '1' ? 'edit' : 'view'
    return allowed.includes(was) ? was : allowed[0]
  })
  const setMode = (next: DocMode) => { setState(next); writePref(key, next) }
  return [allowed.includes(mode) ? mode : allowed[0], setMode] as const
}

const MODES: Record<DocMode, [string, string]> = {
  view: ['보기', '읽기만 합니다. 클릭해도 고쳐지지 않습니다'],
  edit: ['편집', EDIT_HINT],
  split: ['나란히', '원문과 미리보기를 나란히 봅니다. 미리보기에서도 고칠 수 있습니다'],
  source: ['소스', '원문만 봅니다'],
}
export const ModeSwitch = ({modes, mode, onChange, titles = {}}: {modes: DocMode[]; mode: DocMode; onChange: (mode: DocMode) => void; titles?: Partial<Record<DocMode, string>>}) =>
  <div className="doc-modes" role="group" aria-label="보기 방식">
    {modes.map(m => <button key={m} aria-pressed={mode === m} onClick={() => onChange(m)} title={titles[m] ?? MODES[m][1]}>{MODES[m][0]}</button>)}
  </div>

const SAVE_TEXT: Record<SaveState, string> = {saved: '저장됨', pending: '수정됨', saving: '저장 중…', error: '저장 실패 · 다시 시도 중', conflict: '저장 멈춤'}
export function SaveBadge({state, error}: {state: SaveState; error?: string}) {
  return <span className={`doc-save doc-save-${state}`} role="status"
    title={error || '편집은 자동으로 저장되고, 에이전트가 파일을 바꾸면 1초 안에 반영됩니다.'}>{SAVE_TEXT[state]}</span>
}
export const DocBanner = ({children}: {children: ReactNode}) => <div className="doc-banner" role="status">{children}</div>

export function DocSurface({tab, ownerKey, memos, onContextMenu, onViewChange}: {
  tab: ViewerTab; ownerKey: string; memos?: Memo[]
  onContextMenu?: (info: SelectionInfo) => void
  onViewChange?: (view: NonNullable<ViewerTab['viewState']>) => void
}) {
  const kind = kindOf(tab), rendered = kind !== 'code', writable = isEditableFile(tab)
  const local = JSON.parse(ownerKey)[0] === 'local'
  const [mode, setMode] = useDocMode(kind, !rendered ? ['source'] : writable ? ['view', 'edit', 'split', 'source'] : ['view', 'source'])
  const editing = writable && (mode === 'edit' || mode === 'split')
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
  const [reveal, setReveal] = useState<{from: number; to: number; seq: number} | undefined>()

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
    showSource: range => {
      if (mode === 'view' || mode === 'edit') setMode(writable ? 'split' : 'source')
      if (range) setReveal(r => ({...range, seq: (r?.seq || 0) + 1}))
    },
  }

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
    if (!showsPreview || !editing || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.key.toLowerCase() !== 'z' || (e.target as HTMLElement).closest('textarea, input, .cm-editor, [contenteditable]')) return
    e.preventDefault(); doc.undo()
  }}>
    {(rendered || writable) && <div className="doc-toolbar">
      {rendered && <ModeSwitch modes={writable ? ['view', 'edit', 'split', 'source'] : ['view', 'source']} mode={mode} onChange={setMode}/>}
      {showsPreview && editing && <button className="doc-tool" disabled={!undoCount} onClick={doc.undo} title={`미리보기에서 한 수정 되돌리기 (${MOD}+Z)`}>↶ 되돌리기</button>}
      <div className="doc-extras" ref={setSlot}/>
      {writable && <SaveBadge state={sync.state} error={sync.error}/>}
    </div>}
    {sync.conflict && <DocBanner>
      <span>이 탭의 수정과 디스크의 파일이 둘 다 바뀌어 자동 저장을 멈췄습니다. 어느 쪽을 남길까요?</span>
      <button className="doc-tool" onClick={sync.keepDisk}>디스크 버전 불러오기</button>
      <button className="doc-tool" onClick={sync.keepMine}>이 탭 내용으로 저장</button>
    </DocBanner>}
    <div className={`doc-body doc-${mode}`}>
      {(mode === 'split' || mode === 'source') && <CodeEditor content={tab.content} lang={kind === 'code' ? tab.lang : kind} memos={memos} readOnly={!writable}
        onChange={change} onSave={sync.flush} onContextMenu={onContextMenu} viewState={tab.viewState} onViewChange={onViewChange} reveal={reveal}/>}
      {showsPreview && (kind === 'html'
        ? <HtmlPreview content={tab.content} path={tab.path} local={local} doc={doc} slot={slot} onOpenFile={file => void openFileTab(file, ownerKey)}/>
        : <div ref={scroller} className="doc-scroll">
          <MarkdownPreview content={tab.content} filePath={tab.path} local={local} doc={doc} slot={slot} delay={mode === 'split' ? 150 : 0} onContextMenu={onContextMenu}
            onOpenFile={file => void openFileTab(file, ownerKey)}/>
        </div>)}
    </div>
  </div>
}
