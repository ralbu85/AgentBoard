import {create} from 'zustand'
import {isEditableFile, useStore} from './store'

// A deploy swaps the served index.html, but an open page keeps running the JS
// it loaded: nothing inside it (a view's 새로고침) can show the new app. When the
// served page names another entry chunk, the app offers a reload; it never
// reloads by itself (an auto-reload loops on slow mobile).

export const useAppUpdate = create<{outdated: boolean}>(() => ({outdated: false}))

const ENTRY = /<script\b[^>]*\bsrc="([^"]*\/assets\/[^"]+\.js)"/
const running = () => document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')?.getAttribute('src') || ''
let last = 0

/** True when the server now serves a newer build than this page runs. */
export async function checkForUpdate(force = false): Promise<boolean> {
  const mine = running()
  if (!mine) return false   // dev server: no built entry chunk
  if (useAppUpdate.getState().outdated) return true
  if (!force && Date.now() - last < 30_000) return false
  last = Date.now()
  try {
    const res = await fetch('/', {cache: 'no-store', credentials: 'include', signal: AbortSignal.timeout?.(10_000)})
    const live = res.ok ? ENTRY.exec(await res.text())?.[1] : ''
    if (!live || live === mine) return false
    useAppUpdate.setState({outdated: true})
    return true
  } catch { return false }
}

/** Reload the app once every open file has saved its last edit. */
export async function reloadApp() {
  const {_viewerState, saveTab} = useStore.getState()
  const saves = Object.entries(_viewerState).flatMap(([key, vs]) =>
    vs.tabs.filter(t => t.dirty && isEditableFile(t)).map(t => saveTab(t.id, key)))
  const results = await Promise.all(saves)
  if (results.some(r => r && !r.ok) && !window.confirm('저장하지 못한 수정이 있습니다. 그래도 새로고침할까요?')) return
  location.reload()
}

/** Check when the server comes back (a deploy restarts it) and when the reader returns. */
export function watchForUpdates() {
  const wake = () => { if (document.visibilityState === 'visible') void checkForUpdate() }
  document.addEventListener('visibilitychange', wake)
  window.addEventListener('focus', wake)
}
