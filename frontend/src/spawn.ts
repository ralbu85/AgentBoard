import type { Session } from './types'
import { api } from './api'
import { useStore } from './store'
import { notifyActive } from './ws'
import { useToasts } from './toasts'

// Skip shell startup scripts that may activate tools or launch another agent.
export const CLEAN_TERMINAL = 'bash --noprofile --norc'
const pending = new Map<string, Promise<boolean>>()

export function spawnAndFocus(cwd: string, host = 'local', cmd = CLEAN_TERMINAL): Promise<boolean> {
  const key = JSON.stringify([host, cwd, cmd])
  const existing = pending.get(key)
  if (existing) return existing
  const request = launch(cwd, host, cmd).finally(() => pending.delete(key))
  pending.set(key, request)
  return request
}

function bounded<T>(request: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('서버 응답이 지연되고 있습니다. 생성되었을 수 있으니 세션 목록을 확인한 후 다시 시도하세요.')), milliseconds)
    request.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

async function launch(cwd: string, host: string, cmd: string): Promise<boolean> {
  const reqId = globalThis.crypto?.randomUUID?.() ?? `r${Date.now()}${Math.random()}`
  try {
    const res = await bounded(api.spawn(cwd, cmd, host, reqId), 30000)
    if (!res || res.ok === false) throw new Error(res?.error || '세션을 생성하지 못했습니다.')
    let id = host === 'local' && res.id != null ? String(res.id) : null
    if (!id) {
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        id = useStore.getState()._spawnReqs[reqId] || null
        if (id && useStore.getState().sessions[id]) break
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      if (!id || !useStore.getState().sessions[id])
        throw new Error('원격 서버의 생성 확인이 지연되고 있습니다. 세션 목록을 확인한 후 다시 시도하세요.')
    }
    // HTTP supplies the canonical cwd even when the spawned WS event was missed.
    if (!useStore.getState().sessions[id]) {
      const workers = await bounded(api.workers(), 10000)
      const created = Array.isArray(workers) ? workers.find((s: Session) => String(s.id) === id) : null
      if (!created) throw new Error('생성된 터미널을 확인하지 못했습니다. 세션 목록을 확인하세요.')
      useStore.setState(state => ({ sessions: { ...state.sessions, [id!]: state.sessions[id!] || { ...created, host: created.host || host } } }))
    }
    const state = useStore.getState()
    const session = state.sessions[id]
    state.setWorkspace(session.cwd || cwd, session.host || host)
    state.setActive(id)
    notifyActive(id)
    return true
  } catch (error) {
    useToasts.getState().push(error instanceof Error ? error.message : '터미널 생성 실패')
    return false
  }
}
