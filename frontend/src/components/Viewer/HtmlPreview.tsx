import {useEffect, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import {useToasts} from '../../toasts'
import {uiId} from '../../uiId'
import type {DocEdit} from './DocSurface'
import type {PreviewRestore} from './htmlPreviewRuntime'
import type {PreviewOp} from './htmlSource'

// parse5 is only needed once an HTML file is previewed.
type SourceLib = typeof import('./htmlSource')
let sourceLib: Promise<SourceLib> | null = null
const loadSourceLib = () => sourceLib ||= import('./htmlSource')

// Where each file was being read (scroll, slide hash) survives tab switches.
const places = new Map<string, PreviewRestore>()

// Inert parse (template content never runs scripts or loads resources), so the
// serializer formats source text exactly as the iframe formats its DOM.
const normalizeHtml = (html: string) => { const t = document.createElement('template'); t.innerHTML = html; return t.innerHTML }
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

/** The rendered side of an HTML file: a sandboxed iframe that follows the
 *  source, with click-to-edit text when `doc` allows it. Without `doc` it is a
 *  read-only preview (the file-panel peek). */
export function HtmlPreview({content, path, doc, slot}: {content: string; path?: string; doc?: DocEdit; slot?: HTMLElement | null}) {
  const writable = !!doc?.writable
  const editing = !!doc?.editing
  const [lib, setLib] = useState<SourceLib | null>(null)
  const [srcDoc, setSrcDoc] = useState('')
  const iframe = useRef<HTMLIFrameElement>(null)
  const current = () => doc ? doc.current() : content
  const synced = useRef<string | null>(null)   // source the iframe currently shows
  const token = useRef('')
  const view = useRef<PreviewRestore | null>(path ? places.get(path) || null : null)
  const frameEditing = useRef(false)           // a text block is open in the iframe
  const editingRef = useRef(editing); editingRef.current = editing
  const reloadTimer = useRef(0)

  useEffect(() => { let alive = true; void loadSourceLib().then(m => { if (alive) setLib(m) }); return () => { alive = false } }, [])
  // An open text block holds disk loads (its source range must stay put).
  useEffect(() => { doc?.setPaused(() => frameEditing.current); return () => doc?.setPaused(null) }, [])

  const reply = (message: Record<string, unknown>) => iframe.current?.contentWindow?.postMessage({...message, __ab: token.current}, '*')
  const reload = () => {
    if (!lib) return
    window.clearTimeout(reloadTimer.current)
    const value = current()
    token.current = uiId()
    synced.current = value
    frameEditing.current = false
    setSrcDoc(lib.buildDocument(value, {token: token.current, edit: writable && editingRef.current, restore: view.current}))
  }
  const scheduleReload = (delay = 300) => {
    window.clearTimeout(reloadTimer.current)
    reloadTimer.current = window.setTimeout(() => {
      // An open text block would lose its typing; its end re-schedules this.
      if (!frameEditing.current && current() !== synced.current) reload()
    }, delay)
  }
  useEffect(() => () => window.clearTimeout(reloadTimer.current), [])
  // A (re)mounted iframe always starts from the current source.
  useEffect(() => { if (lib) reload() }, [lib])
  useEffect(() => { if (lib && content !== synced.current) scheduleReload() }, [content])
  // Turning editing off commits an open block inside the page.
  useEffect(() => { reply({t: 'mode', edit: editing}) }, [editing])

  const handlers = useRef<(m: Record<string, unknown>) => void>(() => {})
  handlers.current = m => {
    if (!lib) return
    if (m.t === 'view') {
      view.current = viewState(m)
      if (path && view.current) places.set(path, view.current)
      return
    }
    if (m.t === 'undo') { doc?.undo(); return }
    if (m.t === 'resync') { reload(); return }
    if (m.t === 'end') { frameEditing.current = false; scheduleReload(0); return }
    if (m.t === 'begin') {
      if (typeof m.i !== 'number' || typeof m.tag !== 'string' || typeof m.before !== 'string') return
      const target = {i: m.i, tag: m.tag, before: m.before}
      const found = !writable || !editingRef.current ? {error: '텍스트 편집이 꺼져 있습니다.'} : lib.locate(current(), target, normalizeHtml)
      if ('error' in found) { reply({t: 'begin-deny', i: target.i, reason: found.error}); return }
      frameEditing.current = true
      reply({t: 'begin-ok', i: target.i})
      return
    }
    const op = previewOp(m)
    if (!op) return
    frameEditing.current = false
    const base = current()
    // Not gated on the toggle: switching editing off commits the open block.
    const result = doc?.writable ? lib.applyPreviewOp(base, op, normalizeHtml) : {error: '읽기 전용 미리보기입니다.'}
    if ('error' in result) {
      useToasts.getState().push(result.error)
      reload()   // show the source as it really is
      return
    }
    doc!.apply(base, result.content)
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

  return <>
    {slot && createPortal(<>
      <button className="doc-tool" onClick={reload} title="페이지 스크립트를 처음부터 다시 실행">새로고침</button>
      <span className="doc-note" title="미리보기는 파일에 들어 있는 리소스만 불러옵니다">외부 리소스·서버 연결 제외</span>
    </>, slot)}
    {lib
      ? <iframe ref={iframe} className="html-preview-frame" title="HTML 미리보기" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={srcDoc}/>
      : <div className="viewer-empty">미리보기 준비 중…</div>}
  </>
}
