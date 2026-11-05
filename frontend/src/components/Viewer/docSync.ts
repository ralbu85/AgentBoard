import {useEffect, useRef, useState} from 'react'
import {isEditableFile, useStore, type ViewerTab} from '../../store'
import {useToasts} from '../../toasts'
import {api} from '../../api'

// One sync policy for every open file: edits save themselves (a second after
// typing stops, or at once when an edit is committed), and an agent's writes to
// the file show up within a second while the tab is open.

export const SAVE_DELAY = 1000
const RETRY_DELAY = 5000

// Polling must stay quiet: a deleted file would otherwise toast every second.
export const quietJson = async (url: string) => {
  const res = await fetch(url, {credentials: 'include'})
  return res.ok ? res.json() : null
}
const findTab = (id: string, ownerKey: string) => useStore.getState()._viewerState[ownerKey]?.tabs.find(t => t.id === id)
const toast = (text: string) => useToasts.getState().push(text)
export const readPref = (key: string) => { try { return localStorage.getItem(key) } catch { return null } }
export const writePref = (key: string, value: string) => { try { localStorage.setItem(key, value) } catch { /* private mode */ } }

export type SaveState = 'saved' | 'pending' | 'saving' | 'error' | 'conflict'
export const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'

/** Autosave and disk follow for one open file tab. Nothing loads from disk
 *  while `paused` (an inline editor is open); `onLoad` runs just before a disk
 *  version replaces the buffer. When the tab and the file both changed,
 *  autosave stops and `conflict` asks which one to keep. */
export function useDocSync(tab: ViewerTab, ownerKey: string, opts: {paused?: () => boolean; onLoad?: (content: string) => void} = {}) {
  const live = isEditableFile(tab)
  const id = tab.id
  const [state, setState] = useState<SaveState>('saved')
  const [error, setError] = useState('')
  const [conflict, setConflictState] = useState(false)
  const latest = useRef(opts); latest.current = opts
  const writes = useRef(0)
  const timer = useRef(0)
  const stopped = useRef(false)
  const setConflict = (on: boolean) => {
    stopped.current = on
    setConflictState(on)
    if (on) { window.clearTimeout(timer.current); setState('conflict') }
  }
  const settle = () => { if (!writes.current) setState(findTab(id, ownerKey)?.dirty ? 'pending' : 'saved') }

  const flush = () => {
    window.clearTimeout(timer.current)
    if (!live || stopped.current || !findTab(id, ownerKey)?.dirty) return
    writes.current++
    setState('saving')
    void useStore.getState().saveTab(id, ownerKey).then(res => {
      writes.current--
      if (!res || res.ok) { setError(''); settle(); return }
      if (res.conflict) { setConflict(true); return }
      setState('error'); setError(res.error)
      timer.current = window.setTimeout(() => flushRef.current(), RETRY_DELAY)   // offline: retry quietly
    })
  }
  const flushRef = useRef(flush); flushRef.current = flush

  // A changed buffer saves itself once typing stops.
  useEffect(() => {
    if (!live || !tab.dirty || stopped.current) return
    if (!writes.current) setState('pending')
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => flushRef.current(), SAVE_DELAY)
  }, [tab.content, tab.dirty])
  // Leaving the tab or the page saves what is pending.
  useEffect(() => {
    const hide = () => { if (document.visibilityState === 'hidden') flushRef.current() }
    document.addEventListener('visibilitychange', hide)
    return () => { document.removeEventListener('visibilitychange', hide); flushRef.current(); window.clearTimeout(timer.current) }
  }, [])

  const load = (content: string, version: string) => {
    latest.current.onLoad?.(content)
    useStore.getState().updateTab(id, content, ownerKey)
    useStore.getState().markTabSaved(id, content, version, ownerKey)
    setConflict(false); setError(''); setState('saved')
  }
  // Poll /api/file-stat (cheap) and read the file only when it changed.
  useEffect(() => {
    if (!live) return
    let alive = true, signature = '', busy = false
    const path = encodeURIComponent(tab.path)
    const check = async () => {
      if (busy || document.visibilityState === 'hidden' || latest.current.paused?.()) return
      busy = true
      try {
        const stat = await quietJson(`/api/file-stat?path=${path}`)
        if (!alive || typeof stat?.signature !== 'string' || stat.signature === signature || writes.current) return
        const file = await quietJson(`/api/file?path=${path}`)
        if (!alive || typeof file?.version !== 'string' || typeof file.content !== 'string' || writes.current || latest.current.paused?.()) return
        signature = stat.signature
        const current = findTab(id, ownerKey)
        if (!current || file.version === current.version) return
        if (file.content === current.content) {
          useStore.getState().markTabSaved(id, current.content, file.version, ownerKey)
          setConflict(false); settle()
          return
        }
        if (current.dirty) { setConflict(true); return }
        load(file.content, file.version)
      } catch { /* offline: the next tick retries */ } finally { busy = false }
    }
    void check()
    const poll = window.setInterval(check, 1000)
    window.addEventListener('focus', check)
    return () => { alive = false; window.clearInterval(poll); window.removeEventListener('focus', check) }
  }, [id, tab.path, ownerKey, live])

  const readDisk = async () => {
    const file = await quietJson(`/api/file?path=${encodeURIComponent(tab.path)}`).catch(() => null)
    if (typeof file?.content !== 'string' || typeof file.version !== 'string') { toast('파일을 다시 읽지 못했습니다.'); return null }
    return file as {content: string; version: string}
  }
  const keepDisk = async () => {
    if (!window.confirm('이 탭의 수정을 버리고 디스크의 파일을 불러올까요?')) return
    const file = await readDisk()
    if (file) load(file.content, file.version)
  }
  const keepMine = async () => {
    if (!window.confirm('디스크에서 바뀐 내용을 이 탭의 내용으로 덮어쓸까요?')) return
    const file = await readDisk(), current = findTab(id, ownerKey)
    if (!file || !current) return
    const res = await api.saveFile(current.path, current.content, file.version)
    if (!res.ok) { toast(`저장하지 못했습니다: ${res.error}`); return }
    useStore.getState().markTabSaved(id, current.content, res.version, ownerKey)
    setConflict(false); setError(''); settle()
  }
  return {state, error, conflict, flush, keepDisk, keepMine}
}

/** Counts changes to a file on disk (checked once a second while visible) for
 *  views that reload rather than edit (PDF, images). A change counts once the
 *  file has stopped changing, so a half-written PDF is never loaded. */
export function useFileChanges(path?: string) {
  const [changes, setChanges] = useState(0)
  useEffect(() => {
    setChanges(0)
    if (!path) return
    let alive = true, busy = false, seen = '', moving = ''
    const check = async () => {
      if (busy || document.visibilityState === 'hidden') return
      busy = true
      try {
        const stat = await quietJson(`/api/file-stat?path=${encodeURIComponent(path)}`)
        if (!alive || typeof stat?.signature !== 'string') return
        if (!seen) seen = stat.signature
        else if (stat.signature === seen) moving = ''
        else if (stat.signature !== moving) moving = stat.signature
        else { seen = moving; moving = ''; setChanges(n => n + 1) }
      } catch { /* offline */ } finally { busy = false }
    }
    void check()
    const poll = window.setInterval(check, 1000)
    return () => { alive = false; window.clearInterval(poll) }
  }, [path])
  return changes
}
