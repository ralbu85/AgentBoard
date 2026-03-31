import { create } from 'zustand'
import type { Session, WsMessage } from './types'

interface TermHubState {
  sessions: Record<string, Session>
  activeId: string | null
  titles: Record<string, string>
  tunnelUrl: string | null

  // Completion flash tracking
  _completedAt: Record<string, number>

  // Actions
  setActive: (id: string | null) => void
  removeSession: (id: string) => void
  handleMessage: (msg: WsMessage) => void
  effectiveState: (id: string) => string | null
  setSessions: (sessions: Session[]) => void
}

export const useStore = create<TermHubState>((set, get) => ({
  sessions: {},
  activeId: null,
  titles: {},
  tunnelUrl: null,
  _completedAt: {},

  setActive: (id) => set({ activeId: id }),

  removeSession: (id) => {
    const state = get()
    const { [id]: _, ...rest } = state.sessions
    const updates: Partial<TermHubState> = { sessions: rest }
    if (state.activeId === id) {
      const ids = Object.keys(rest)
      updates.activeId = ids.length > 0 ? ids[0] : null
    }
    set(updates as any)
  },

  setSessions: (sessions) => {
    const map: Record<string, Session> = {}
    for (const s of sessions) map[s.id] = s
    set({ sessions: map })
  },

  handleMessage: (msg) => {
    const state = get()

    switch (msg.type) {
      case 'spawned':
        set({
          sessions: {
            ...state.sessions,
            [msg.id]: {
              id: msg.id,
              sessionName: msg.sessionName,
              cwd: msg.cwd,
              cmd: msg.cmd,
              status: msg.status as Session['status'],
              aiState: null,
              process: '',
              createdAt: 0,
              memKB: 0,
            },
          },
        })
        break

      case 'status': {
        const s = state.sessions[msg.id]
        if (!s) break
        const prev = s.aiState
        const updated = { ...s, status: msg.status as Session['status'] }
        if (msg.status === 'completed') updated.aiState = null

        // Track completion time for flash
        const ca = { ...state._completedAt }
        if (prev === 'working' && (msg.status === 'completed' || msg.status === 'running')) {
          ca[msg.id] = Date.now()
        }

        set({
          sessions: { ...state.sessions, [msg.id]: updated },
          _completedAt: ca,
        })
        break
      }

      case 'cwd': {
        const s = state.sessions[msg.id]
        if (s) set({ sessions: { ...state.sessions, [msg.id]: { ...s, cwd: msg.cwd } } })
        break
      }

      case 'aiState': {
        const s = state.sessions[msg.id]
        if (!s) break
        const ca = { ...state._completedAt }
        if (s.aiState === 'working' && msg.state === 'idle') {
          ca[msg.id] = Date.now()
        }
        set({
          sessions: { ...state.sessions, [msg.id]: { ...s, aiState: msg.state } },
          _completedAt: ca,
        })
        break
      }

      case 'info': {
        const s = state.sessions[msg.id]
        if (s) set({
          sessions: {
            ...state.sessions,
            [msg.id]: { ...s, process: msg.process, createdAt: msg.createdAt, memKB: msg.memKB },
          },
        })
        break
      }

      case 'title':
        set({ titles: { ...state.titles, [msg.id]: msg.title } })
        break

      case 'titles':
        set({ titles: { ...state.titles, ...msg.titles } })
        break

      case 'tunnel':
        set({ tunnelUrl: msg.url })
        break
    }
  },

  effectiveState: (id) => {
    const state = get()
    const s = state.sessions[id]
    if (!s) return null
    if (s.status === 'stopped') return 'stopped'
    if (s.status === 'completed') return 'completed'

    const completedAt = state._completedAt[id]
    if (completedAt && Date.now() - completedAt < 10000) return 'completed'

    return s.aiState || 'running'
  },
}))
