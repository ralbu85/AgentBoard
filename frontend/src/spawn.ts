import { api } from './api'
import { useStore } from './store'
import { notifyActive } from './ws'
import { useToasts } from './toasts'

// Agent/session types the "+" offers. AgentBoard sessions are AI CLI agents by
// intent; a bare shell is available only via the explicit "터미널" choice.
export const AGENTS = [
  { id: 'claude', label: 'Claude', icon: '🤖', cmd: 'claude' },
  { id: 'codex', label: 'Codex', icon: '🧠', cmd: 'codex' },
  { id: 'bash', label: '터미널', icon: '>_', cmd: 'bash' },
]

// Spawn a session and focus it. Local sessions get their id back synchronously,
// so we insert the tab optimistically and focus immediately — no polling.
export async function spawnAndFocus(cwd: string, host = 'local', cmd = 'claude') {
  const reqId = (crypto?.randomUUID?.() ?? `r${Date.now()}${Math.random()}`)
  let res: any
  try {
    res = await api.spawn(cwd, cmd, host, reqId)
  } catch {
    res = null
  }
  if (!res || res.ok === false) {
    useToasts.getState().push('세션 생성 실패' + (res?.error ? `: ${res.error}` : ''))
    return
  }

  const st = useStore.getState()
  if (host === 'local' && res.id != null) {
    const id = String(res.id)
    st.upsertSession({ id, cwd, cmd, host })   // instant tab
    st.setWorkspace(cwd)
    st.setActive(id)                            // → jump to the new tab, ready
    notifyActive(id)
    return
  }

  // Remote: the agent assigns the id and it arrives over the WebSocket; match it.
  const start = Date.now()
  const poll = setInterval(() => {
    const s = useStore.getState()
    const id = s._spawnReqs[reqId]
    if (id && s.sessions[id]) {
      clearInterval(poll)
      s.setWorkspace(cwd)
      s.setActive(id)
      notifyActive(id)
    } else if (Date.now() - start > 8000) {
      clearInterval(poll)
      useToasts.getState().push('원격 세션 생성 응답이 없습니다')
    }
  }, 100)
}
