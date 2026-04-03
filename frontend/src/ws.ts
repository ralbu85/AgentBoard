import { useStore } from './store'
import type { WsMessage } from './types'

let ws: WebSocket | null = null
let _resizeTimer: ReturnType<typeof setTimeout> | null = null
let _pendingActive: string | null = null

// Terminal write callbacks — set by TerminalManager
export const terminalHandlers = {
  onSnapshot: null as ((id: string, data: string) => void) | null,
  onScreen: null as ((id: string, data: string) => void) | null,
  onStream: null as ((id: string, data: string) => void) | null,
}

// Debug counters (accessible from console/tests)
;(window as any).__wsDebug = { screenCount: 0, lastScreenId: '', lastScreenLen: 0, snapshotCount: 0 }

export function initWs() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  ws = new WebSocket(`${proto}://${location.host}/ws`)

  ws.onopen = () => {
    document.getElementById('status-dot')?.classList.remove('off')
    // Always re-send current active session on (re)connect
    const activeId = _pendingActive || useStore.getState().activeId
    if (activeId) {
      send({ type: 'active', id: activeId })
    }
    _pendingActive = null
  }

  ws.onclose = () => {
    document.getElementById('status-dot')?.classList.add('off')
    ws = null
    setTimeout(initWs, 2000)
  }

  ws.onmessage = (e) => {
    const msg: WsMessage = JSON.parse(e.data)

    // Route terminal data to xterm.js (outside React render)
    // Only use snapshot + screen (capture-pane polling).
    // Do NOT use stream (pipe-pane) — raw escape sequences destroy scrollback.
    if (msg.type === 'snapshot') {
      (window as any).__wsDebug.snapshotCount++
      terminalHandlers.onSnapshot?.(msg.id, msg.data)
    } else if (msg.type === 'screen') {
      const d = (window as any).__wsDebug
      d.screenCount++
      d.lastScreenId = msg.id
      d.lastScreenLen = msg.data?.length || 0
      terminalHandlers.onScreen?.(msg.id, msg.data)
    }

    // Route state updates to Zustand store
    useStore.getState().handleMessage(msg)
  }
}

export function send(msg: object) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

let _lastSentRows = 0
export function sendResize(id: string, cols: number, rows: number) {
  if (rows === _lastSentRows) return  // rows unchanged, skip
  if (_resizeTimer) clearTimeout(_resizeTimer)
  _resizeTimer = setTimeout(() => {
    _lastSentRows = rows
    send({ type: 'resize', id, rows })
    send({ type: 'resync', id })
  }, 300)
}

export function notifyActive(id: string | null) {
  const d = (window as any).__wsDebug
  if (d) { d.lastNotifyActive = id; d.notifyActiveCount = (d.notifyActiveCount || 0) + 1; d.wsState = ws?.readyState }
  if (ws && ws.readyState === WebSocket.OPEN) {
    send({ type: 'active', id: id || '' })
  } else {
    // Queue for when WS connects
    _pendingActive = id
  }
}
