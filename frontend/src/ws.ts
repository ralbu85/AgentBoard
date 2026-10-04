import { useStore } from './store'
import type { WsMessage } from './types'

let ws: WebSocket | null = null
let _pendingActive: string | null = null
const _pendingSend: object[] = []
let _retryDelay = 1000  // ms; doubles per failure up to 30s
let syncTimer: ReturnType<typeof setTimeout> | undefined
let syncDeadline: ReturnType<typeof setTimeout> | undefined
let wakeListenersInstalled = false

function requestSessionSync() {
  clearTimeout(syncTimer)
  if (!ws || ws.readyState !== WebSocket.OPEN || document.visibilityState === 'hidden') return
  if (syncDeadline) return
  const socket = ws
  socket.send(JSON.stringify({type: 'session-sync'}))
  syncDeadline = setTimeout(() => {
    syncDeadline = undefined
    if (ws !== socket) return
    useStore.setState({connection: 'offline'})
    // Closing a dead mobile TCP link may itself never emit onclose. Replace
    // the socket explicitly; its late callbacks are guarded by identity.
    ws = null
    socket.close()
    initWs()
  }, 8000)
}

function receivedSessionState() {
  clearTimeout(syncDeadline)
  syncDeadline = undefined
  clearTimeout(syncTimer)
  syncTimer = setTimeout(requestSessionSync, 15000)
}

// Terminal write callbacks — set by TerminalManager
export const terminalHandlers = {
  onConnect: null as (()=>void)|null,
  onSnapshot: null as ((id: string, data: string, cols?:number, rows?:number, fullRows?:boolean, gridVersion?:number, dynamicWidth?:boolean, wrappedRows?:number[]) => void) | null,
  onScreen: null as ((id: string, data: string, cols?:number, rows?:number, fullRows?:boolean, gridVersion?:number, dynamicWidth?:boolean, wrappedRows?:number[]) => void) | null,
  onStream: null as ((id: string, data: string, cols?:number, rows?:number, fullRows?:boolean, gridVersion?:number, dynamicWidth?:boolean, wrappedRows?:number[]) => void) | null,
}

// Debug counters (accessible from console/tests)
window.__wsDebug = { screenCount: 0, lastScreenId: '', lastScreenLen: 0, snapshotCount: 0 }

export function initWs() {
  if (!wakeListenersInstalled) {
    wakeListenersInstalled = true
    const wake = () => {
      if (document.visibilityState === 'hidden') {
        clearTimeout(syncTimer)
        clearTimeout(syncDeadline)
        syncDeadline = undefined
        return
      }
      if (!ws || ws.readyState === WebSocket.CLOSED) initWs()
      else requestSessionSync()
    }
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('pageshow', wake)
    window.addEventListener('online', wake)
    window.addEventListener('focus', wake)
  }
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return
  useStore.setState({connection: 'connecting'})
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  ws = new WebSocket(`${proto}://${location.host}/ws`)
  const socket = ws

  ws.onopen = () => {
    if (ws !== socket) return
    _retryDelay = 1000  // reset backoff on successful connect
    // Always re-send current active session on (re)connect
    const activeId = _pendingActive || useStore.getState().activeId
    if (activeId) {
      send({ type: 'active', id: activeId })
    }
    _pendingActive = null
    terminalHandlers.onConnect?.()
    // Flush messages that were queued while the socket was connecting
    while (_pendingSend.length > 0) {
      const msg = _pendingSend.shift()!
      ws!.send(JSON.stringify(msg))
    }
    requestSessionSync()
  }

  ws.onclose = (e) => {
    if (ws !== socket) return
    clearTimeout(syncTimer)
    clearTimeout(syncDeadline)
    syncDeadline = undefined
    useStore.setState({connection: 'offline'})
    document.getElementById('status-dot')?.classList.add('off')
    ws = null
    if (e.code === 4401) {
      // Server rejected the cookie — bounce to login via fresh load
      location.reload()
      return
    }
    setTimeout(initWs, _retryDelay)
    _retryDelay = Math.min(_retryDelay * 2, 30000)
  }

  ws.onmessage = (e) => {
    if (ws !== socket) return
    const msg: WsMessage = JSON.parse(e.data)
    if (msg.type === 'session-state') {
      receivedSessionState()
      useStore.setState({connection: 'online'})
      document.getElementById('status-dot')?.classList.remove('off')
    }

    // Route terminal data to xterm.js (outside React render).
    //  - snapshot: full pane + 2000 lines of scrollback. Sent on session switch,
    //              resize, resync, AND mid-burst (when tmux #{history_size} grew
    //              between two polls — see streamer._poll_active). writeSnapshot
    //              rebuilds the buffer atomically.
    //  - screen:   visible viewport overwrite (poll, ~80ms). Cheap diff frames
    //              that only touch the visible grid; scrollback is preserved.
    //  - stream:   raw pipe-pane FIFO. Disabled on the client — its escape
    //              sequences would shred xterm's scrollback. Backend-only,
    //              used solely to fill the state-detection ring buffer.
    if (msg.type === 'snapshot') {
      window.__wsDebug.snapshotCount++
      terminalHandlers.onSnapshot?.(msg.id, msg.data, msg.cols, msg.rows, msg.fullRows, msg.gridVersion, msg.dynamicWidth, msg.wrappedRows)
    } else if (msg.type === 'screen') {
      const d = window.__wsDebug
      d.screenCount++
      d.lastScreenId = msg.id
      d.lastScreenLen = msg.data?.length || 0
      terminalHandlers.onScreen?.(msg.id, msg.data, msg.cols, msg.rows, msg.fullRows, msg.gridVersion, msg.dynamicWidth, msg.wrappedRows)
    }

    // Route state updates to Zustand store
    useStore.getState().handleMessage(msg)
  }
}

export function send(msg: object) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  } else {
    // Geometry is transient; reconnect recomputes current visible viewports.
    if(['viewport','viewport-release'].includes((msg as {type?:string}).type||''))return
    _pendingSend.push(msg)
  }
}

export function notifyActive(id: string | null) {
  const d = window.__wsDebug
  if (d) { d.lastNotifyActive = id; d.notifyActiveCount = (d.notifyActiveCount || 0) + 1; d.wsState = ws?.readyState }
  if (ws && ws.readyState === WebSocket.OPEN) {
    send({ type: 'active', id: id || '' })
  } else {
    // Queue for when WS connects
    _pendingActive = id
  }
}
