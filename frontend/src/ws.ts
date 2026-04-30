import { useStore } from './store'
import type { WsMessage } from './types'

let ws: WebSocket | null = null
let _pendingActive: string | null = null
const _pendingSend: object[] = []
let _retryDelay = 1000  // ms; doubles per failure up to 30s

// Terminal write callbacks — set by TerminalManager
export const terminalHandlers = {
  onSnapshot: null as ((id: string, data: string) => void) | null,
  onScreen: null as ((id: string, data: string) => void) | null,
  onStream: null as ((id: string, data: string) => void) | null,
}

// Debug counters (accessible from console/tests)
window.__wsDebug = { screenCount: 0, lastScreenId: '', lastScreenLen: 0, snapshotCount: 0 }

export function initWs() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  ws = new WebSocket(`${proto}://${location.host}/ws`)

  ws.onopen = () => {
    document.getElementById('status-dot')?.classList.remove('off')
    _retryDelay = 1000  // reset backoff on successful connect
    // Always re-send current active session on (re)connect
    const activeId = _pendingActive || useStore.getState().activeId
    if (activeId) {
      send({ type: 'active', id: activeId })
    }
    _pendingActive = null
    // Flush messages that were queued while the socket was connecting
    while (_pendingSend.length > 0) {
      const msg = _pendingSend.shift()!
      ws!.send(JSON.stringify(msg))
    }
  }

  ws.onclose = (e) => {
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
    const msg: WsMessage = JSON.parse(e.data)

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
      terminalHandlers.onSnapshot?.(msg.id, msg.data)
    } else if (msg.type === 'screen') {
      const d = window.__wsDebug
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
  } else {
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
