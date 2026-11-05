import {useEffect, useRef, useState} from 'react'
import {CodeEditor} from './CodeEditor'
import {useStore, type ViewerTab} from '../../store'
import {useToasts} from '../../toasts'
import {api} from '../../api'
import {uiId} from '../../uiId'
import type {PreviewRestore} from './htmlPreviewRuntime'
import type {PreviewOp} from './htmlSource'

// parse5 is only needed once an HTML file is previewed.
type SourceLib = typeof import('./htmlSource')
let sourceLib: Promise<SourceLib> | null = null
const loadSourceLib = () => sourceLib ||= import('./htmlSource')

type Mode = 'preview' | 'split' | 'source'
const MODE_KEY = 'agentboard.htmlView.mode', EDIT_KEY = 'agentboard.htmlView.edit'
const readPref = (key: string) => { try { return localStorage.getItem(key) } catch { return null } }
const writePref = (key: string, value: string) => { try { localStorage.setItem(key, value) } catch { /* private mode */ } }
// Where each file was being read (scroll, slide hash) survives tab switches.
const places = new Map<string, PreviewRestore>()

// Inert parse (template content never runs scripts or loads resources), so the
// serializer formats source text exactly as the iframe formats its DOM.
const normalizeHtml = (html: string) => { const t = document.createElement('template'); t.innerHTML = html; return t.innerHTML }
// Polling must stay quiet: a deleted file would otherwise toast every second.
const quietJson = async (url: string) => {
  const res = await fetch(url, {credentials: 'include'})
  return res.ok ? res.json() : null
}
const viewState = (m: Record<string, unknown>): PreviewRestore | null => {
  const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : 0
  const scrolls = Array.isArray(m.scrolls) ? m.scrolls.filter((s): s is PreviewRestore['scrolls'][number] =>
    Array.isArray(s) && s.length === 4 && typeof s[0] === 'number' && typeof s[1] === 'string' && typeof s[2] === 'number' && typeof s[3] === 'number').slice(0, 20) : []
  return {x: finite(m.x), y: finite(m.y), hash: typeof m.hash === 'string' ? m.hash.slice(0, 512) : '', scrolls}
}
const previewOp = (m: Record<string, unknown>): PreviewOp | null => {
  if ((m.t !== 'commit' && m.t !== 'add' && m.t !== 'delete') || typeof m.i !== 'number' || typeof m.tag !== 'string' || typeof m.before !== 'string') return null
  if (m.t === 'commit' && typeof m.after !== 'string') return null
  return {t: m.t, i: m.i, tag: m.tag, before: m.before, after: typeof m.after === 'string' ? m.after : undefined, add: m.add === true}
}

export function HtmlView({content, tab, ownerKey, onChange, onSave}: {content: string; tab?: ViewerTab; ownerKey?: string; onChange?: (value: string) => void; onSave?: () => void}) {
  // Without a tab (file-panel peek) the view is a read-only preview.
  const writable = !!(tab && ownerKey && onChange)
  const [lib, setLib] = useState<SourceLib | null>(null)
  const [mode, setModeState] = useState<Mode>(() => {
    const saved = readPref(MODE_KEY)
    return saved === 'source' || saved === 'split' && writable ? saved : 'preview'
  })
  const [editing, setEditing] = useState(() => writable && readPref(EDIT_KEY) === '1')
  const [srcDoc, setSrcDoc] = useState('')
  const [undoCount, setUndoCount] = useState(0)
  const [saveState, setSaveState] = useState<'' | 'saving' | 'saved' | 'error'>('')
  const [diskChanged, setDiskChanged] = useState(false)
  const iframe = useRef<HTMLIFrameElement>(null)
  const contentRef = useRef(content)
  const lastProp = useRef(content)
  if (lastProp.current !== content) { lastProp.current = content; contentRef.current = content }
  const synced = useRef<string | null>(null)   // source the iframe currently shows
  const token = useRef('')
  const view = useRef<PreviewRestore | null>(tab ? places.get(tab.path) || null : null)
  const frameEditing = useRef(false)           // a text block is open in the iframe
  const editingRef = useRef(editing); editingRef.current = editing
  const undo = useRef<string[]>([])
  const writes = useRef(0)
  const saveChain = useRef<Promise<void>>(Promise.resolve())
  const reloadTimer = useRef(0)

  useEffect(() => { let alive = true; void loadSourceLib().then(m => { if (alive) setLib(m) }); return () => { alive = false } }, [])

  const findTab = () => tab && ownerKey ? useStore.getState()._viewerState[ownerKey]?.tabs.find(t => t.id === tab.id) : undefined
  const reply = (message: Record<string, unknown>) => iframe.current?.contentWindow?.postMessage({...message, __ab: token.current}, '*')
  const reload = () => {
    if (!lib) return
    window.clearTimeout(reloadTimer.current)
    const value = contentRef.current
    token.current = uiId()
    synced.current = value
    frameEditing.current = false
    setSrcDoc(lib.buildDocument(value, {token: token.current, edit: writable && editingRef.current, restore: view.current}))
  }
  const scheduleReload = (delay = 300) => {
    window.clearTimeout(reloadTimer.current)
    reloadTimer.current = window.setTimeout(() => {
      // An open text block would lose its typing; its end re-schedules this.
      if (!frameEditing.current && contentRef.current !== synced.current) reload()
    }, delay)
  }
  useEffect(() => () => window.clearTimeout(reloadTimer.current), [])
  // A (re)mounted iframe always starts from the current source.
  useEffect(() => { if (lib && mode !== 'source') reload() }, [lib, mode])
  useEffect(() => { if (lib && mode !== 'source' && content !== synced.current) scheduleReload() }, [content])

  const persist = () => {
    if (!tab || !ownerKey) return
    writes.current++
    setSaveState('saving')
    saveChain.current = saveChain.current.then(async () => {
      const current = findTab()
      if (!current?.dirty) { setSaveState('saved'); return }
      // Saves the whole buffer (like the markdown checkbox toggle), with the
      // version check so an agent's newer write is never overwritten.
      const value = current.content
      const res = await api.writeFile(current.path, value, current.version)
      if (res?.ok === true) { useStore.getState().markTabSaved(current.id, value, res.version, ownerKey); setSaveState('saved') }
      else setSaveState('error')
    }).catch(() => setSaveState('error')).finally(() => { writes.current-- })
  }
  const setContent = (value: string) => {
    contentRef.current = value
    onChange?.(value)
  }
  const pushUndo = (value: string) => {
    undo.current.push(value)
    if (undo.current.length > 50) undo.current.shift()
    setUndoCount(undo.current.length)
  }
  const undoLast = () => {
    const value = undo.current.pop()
    setUndoCount(undo.current.length)
    if (value === undefined) return
    setContent(value)
    persist()
    scheduleReload(0)
  }

  const handlers = useRef<(m: Record<string, unknown>) => void>(() => {})
  handlers.current = m => {
    if (!lib) return
    if (m.t === 'view') {
      view.current = viewState(m)
      if (tab && view.current) places.set(tab.path, view.current)
      return
    }
    if (m.t === 'undo') { undoLast(); return }
    if (m.t === 'resync') { reload(); return }
    if (m.t === 'end') { frameEditing.current = false; scheduleReload(0); return }
    if (m.t === 'begin') {
      if (typeof m.i !== 'number' || typeof m.tag !== 'string' || typeof m.before !== 'string') return
      const target = {i: m.i, tag: m.tag, before: m.before}
      const found = !writable || !editingRef.current ? {error: '텍스트 편집이 꺼져 있습니다.'} : lib.locate(contentRef.current, target, normalizeHtml)
      if ('error' in found) { reply({t: 'begin-deny', i: target.i, reason: found.error}); return }
      frameEditing.current = true
      reply({t: 'begin-ok', i: target.i})
      return
    }
    const op = previewOp(m)
    if (!op) return
    frameEditing.current = false
    const base = contentRef.current
    // Not gated on the toggle: switching editing off commits the open block.
    const result = writable ? lib.applyPreviewOp(base, op, normalizeHtml) : {error: '읽기 전용 미리보기입니다.'}
    if ('error' in result) {
      useToasts.getState().push(result.error)
      reload()   // show the source as it really is
      return
    }
    pushUndo(base)
    setContent(result.content)
    persist()
    if (result.patches && synced.current === base) {
      synced.current = result.content
      if (result.focus !== undefined) frameEditing.current = true
      reply({t: 'patch', patches: result.patches, focus: result.focus})
    } else scheduleReload(0)
  }
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const m = e.data
      if (!iframe.current || e.source !== iframe.current.contentWindow || !m || typeof m !== 'object' || m.__ab !== token.current) return
      handlers.current(m)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  // Agents write the file on disk; follow those writes while this tab is open.
  useEffect(() => {
    if (!tab || !ownerKey) return
    let alive = true, signature = '', busy = false
    const path = encodeURIComponent(tab.path)
    const check = async () => {
      if (busy || document.visibilityState === 'hidden') return
      busy = true
      try {
        const stat = await quietJson(`/api/file-stat?path=${path}`)
        if (!alive || typeof stat?.signature !== 'string' || stat.signature === signature || writes.current) return
        const file = await quietJson(`/api/file?path=${path}`)
        if (!alive || typeof file?.version !== 'string' || typeof file.content !== 'string' || writes.current) return
        signature = stat.signature
        const current = findTab()
        if (!current || file.version === current.version) { setDiskChanged(false); return }
        if (file.content === current.content) {
          useStore.getState().markTabSaved(current.id, current.content, file.version, ownerKey)
          setDiskChanged(false)
          return
        }
        if (current.dirty) { setDiskChanged(true); return }
        undo.current = []; setUndoCount(0)   // undo must not revert the agent's write
        contentRef.current = file.content
        useStore.getState().updateTab(current.id, file.content, ownerKey)
        useStore.getState().markTabSaved(current.id, file.content, file.version, ownerKey)
        setDiskChanged(false)
      } catch { /* offline: the next tick retries */ } finally { busy = false }
    }
    void check()
    const timer = window.setInterval(check, 1000)
    window.addEventListener('focus', check)
    return () => { alive = false; window.clearInterval(timer); window.removeEventListener('focus', check) }
  }, [tab?.id, tab?.path, ownerKey])

  const loadDisk = async () => {
    if (!tab || !ownerKey || !window.confirm('이 탭에서 저장하지 않은 수정을 버리고 디스크의 파일을 불러올까요?')) return
    const file = await quietJson(`/api/file?path=${encodeURIComponent(tab.path)}`).catch(() => null)
    if (typeof file?.content !== 'string') { useToasts.getState().push('파일을 다시 읽지 못했습니다.'); return }
    undo.current = []; setUndoCount(0)
    contentRef.current = file.content
    useStore.getState().updateTab(tab.id, file.content, ownerKey)
    useStore.getState().markTabSaved(tab.id, file.content, file.version, ownerKey)
    setDiskChanged(false)
  }
  const setMode = (next: Mode) => { setModeState(next); writePref(MODE_KEY, next) }
  const toggleEditing = () => {
    const next = !editing
    setEditing(next); editingRef.current = next
    writePref(EDIT_KEY, next ? '1' : '0')
    reply({t: 'mode', edit: next})
  }

  const status = saveState === 'saving' ? '저장 중…' : saveState === 'error' ? '저장 실패' : saveState === 'saved' ? '저장됨'
    : writable ? '파일이 바뀌면 자동 반영' : ''
  const preview = mode === 'source' ? null : lib
    ? <iframe ref={iframe} title="HTML 미리보기" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={srcDoc}/>
    : <div className="viewer-empty">미리보기 준비 중…</div>
  return <div className="html-view">
    <div className="html-view-toolbar">
      <button aria-pressed={mode === 'preview'} onClick={() => setMode('preview')}>미리보기</button>
      {writable && <button aria-pressed={mode === 'split'} onClick={() => setMode('split')} title="소스와 미리보기를 나란히">나란히</button>}
      <button aria-pressed={mode === 'source'} onClick={() => setMode('source')}>HTML 소스</button>
      {writable && mode !== 'source' && <>
        <button aria-pressed={editing} onClick={toggleEditing} title="미리보기에서 글자를 클릭해 바로 고칩니다. Enter 저장 · Ctrl+Enter 같은 수준에 추가 · Esc 취소">✎ 텍스트 편집</button>
        <button disabled={!undoCount} onClick={undoLast} title="미리보기에서 한 수정 되돌리기 (편집 중 Ctrl+Z)">↶ 되돌리기</button>
      </>}
      {mode !== 'source' && <button onClick={reload} title="스크립트를 처음부터 다시 실행">새로고침</button>}
      {status && <span className={saveState === 'error' ? 'html-view-error' : ''}>{status}</span>}
      <span title="미리보기는 파일에 들어 있는 리소스만 불러옵니다">외부 리소스·서버 연결 제외</span>
    </div>
    {diskChanged && <div className="html-view-banner" role="status">
      <span>디스크의 파일이 바뀌었습니다. 이 탭에 저장하지 않은 수정이 있어 자동으로 불러오지 않았습니다.</span>
      <button onClick={loadDisk}>디스크 버전 불러오기</button>
    </div>}
    <div className={`html-view-body html-view-${mode}`}>
      {mode !== 'preview' && <CodeEditor content={content} lang="html" readOnly={!writable} onChange={onChange || (() => {})} onSave={onSave || (() => {})}/>}
      {preview}
    </div>
  </div>
}
