import { create } from 'zustand'
import type { Session, WsMessage, SpawnProfile } from './types'
import { useToasts } from './toasts'
import { api } from './api'

export interface ViewerTab {
  id: string
  name: string
  path: string
  content: string
  type: 'code' | 'markdown' | 'latex' | 'pdf' | 'image' | 'diff' | 'notebook'
  lang: string
  dirty?: boolean
}

interface AppState {
  sessions: Record<string, Session>
  activeId: string | null
  titles: Record<string, string>
  tunnelUrl: string | null

  // Viewer tabs (per session)
  _viewerState: Record<string, { tabs: ViewerTab[]; activeTabId: string | null }>
  viewerTabs: ViewerTab[]       // computed: current session's tabs
  activeTabId: string | null    // computed: current session's active tab

  // Completion flash tracking
  _completedAt: Record<string, number>

  // Correlation map for spawns: reqId -> new session id (so the spawner can
  // match its own session, even amid concurrent spawns on the same host).
  _spawnReqs: Record<string, string>

  // Spawn modal open state + optional pre-fill (folder/host), so any component
  // (e.g. a folder header's "+ new session here") can launch it pre-filled.
  spawnOpen: boolean
  spawnPreset: { cwd?: string; host?: string }

  // The folder shown in the workspace file panel. Follows the selected folder
  // or the active session; null → fall back to the active session's cwd.
  workspaceCwd: string | null

  // How the workspace shows its sessions: one at a time, or all tiled.
  viewMode: 'single' | 'grid'

  // Launch profiles for the "+" button (Claude variants, Codex, terminal, …).
  profiles: SpawnProfile[]
  profileEditorOpen: boolean

  // Registered workspace folders — a workspace can exist with 0 sessions, so
  // these are tracked explicitly (persisted) in addition to session-derived ones.
  workspaceFolders: string[]
  workspaceModalOpen: boolean

  // Actions
  openProfileEditor: () => void
  closeProfileEditor: () => void
  openWorkspaceModal: () => void
  closeWorkspaceModal: () => void
  addWorkspaceFolder: (cwd: string) => void
  removeWorkspaceFolder: (cwd: string) => void
  openSpawn: (preset?: { cwd?: string; host?: string }) => void
  closeSpawn: () => void
  setWorkspace: (cwd: string) => void
  setViewMode: (m: 'single' | 'grid') => void
  upsertSession: (s: { id: string; cwd: string; cmd: string; host?: string }) => void
  loadProfiles: () => Promise<void>
  saveProfiles: (profiles: SpawnProfile[]) => Promise<void>
  setActive: (id: string | null) => void
  removeSession: (id: string) => void
  openTab: (tab: ViewerTab) => void
  closeTab: (id: string) => void
  updateTab: (tabId: string, content: string) => void
  markTabSaved: (tabId: string) => void
  openDiffTab: (path: string, name: string, diff: string) => void
  openLogTab: (sessionId: string, name: string, content: string) => void
  restoreViewerTabs: (sessionId: string) => Promise<void>
  setActiveTab: (id: string) => void
  handleMessage: (msg: WsMessage) => void
  effectiveState: (id: string) => string | null
  setSessions: (sessions: Session[]) => void
}

// Persist open-tab structure (not live content) per session, so a reload can
// re-open the same files — read fresh from disk on restore.
function persistViewer(sessionId: string, vs: { tabs: ViewerTab[]; activeTabId: string | null }) {
  try {
    const meta = vs.tabs
      // diffs and captured logs are derived/live, not files — re-run on demand,
      // never restored from disk (their `path` isn't a real file).
      .filter((t) => t.type !== 'diff' && !t.id.startsWith('log:'))
      .map((t) => ({
        id: t.id, path: t.path, name: t.name, type: t.type, lang: t.lang,
        content: (t.type === 'pdf' || t.type === 'image') ? t.content : undefined,
      }))
    if (meta.length) localStorage.setItem(`agentboard.viewer.${sessionId}`, JSON.stringify({ tabs: meta, activeTabId: vs.activeTabId }))
    else localStorage.removeItem(`agentboard.viewer.${sessionId}`)
  } catch { /* quota / disabled — ignore */ }
}

export const useStore = create<AppState>((set, get) => ({
  sessions: {},
  activeId: null,
  titles: {},
  tunnelUrl: null,
  _viewerState: {},
  _completedAt: {},
  _spawnReqs: {},
  spawnOpen: false,
  spawnPreset: {},
  workspaceCwd: null,
  viewMode: ((typeof localStorage !== 'undefined' && localStorage.getItem('agentboard.viewMode')) as 'single' | 'grid') || 'single',
  profiles: [],
  profileEditorOpen: false,
  workspaceFolders: (() => {
    try { return JSON.parse(localStorage.getItem('agentboard.workspaceFolders') || '[]') } catch { return [] }
  })(),
  workspaceModalOpen: false,

  // These are unused placeholders — use selectors instead:
  // useStore(s => s._viewerState[s.activeId]?.tabs || [])
  viewerTabs: [],
  activeTabId: null,

  openSpawn: (preset = {}) => set({ spawnOpen: true, spawnPreset: preset }),
  closeSpawn: () => set({ spawnOpen: false, spawnPreset: {} }),
  setWorkspace: (cwd) => set({ workspaceCwd: cwd }),
  setViewMode: (m) => { try { localStorage.setItem('agentboard.viewMode', m) } catch {} ; set({ viewMode: m }) },
  // Optimistic insert so a just-created session's tab appears instantly; the
  // ws `spawned` event reconciles it (same id). No-op if it already arrived.
  upsertSession: (s) => set((state) => state.sessions[s.id] ? {} : {
    sessions: {
      ...state.sessions,
      [s.id]: {
        id: s.id, sessionName: '', cwd: s.cwd, cmd: s.cmd,
        status: 'running', aiState: null, process: '', createdAt: 0, memKB: 0,
        host: s.host || 'local',
      },
    },
  }),
  openProfileEditor: () => set({ profileEditorOpen: true }),
  closeProfileEditor: () => set({ profileEditorOpen: false }),
  openWorkspaceModal: () => set({ workspaceModalOpen: true }),
  closeWorkspaceModal: () => set({ workspaceModalOpen: false }),
  addWorkspaceFolder: (cwd) => set((state) => {
    if (state.workspaceFolders.includes(cwd)) return {}
    const next = [...state.workspaceFolders, cwd]
    try { localStorage.setItem('agentboard.workspaceFolders', JSON.stringify(next)) } catch {}
    return { workspaceFolders: next }
  }),
  removeWorkspaceFolder: (cwd) => set((state) => {
    const next = state.workspaceFolders.filter((f) => f !== cwd)
    try { localStorage.setItem('agentboard.workspaceFolders', JSON.stringify(next)) } catch {}
    return { workspaceFolders: next }
  }),
  loadProfiles: async () => {
    try { const r = await api.profiles(); set({ profiles: Array.isArray(r?.profiles) ? r.profiles : [] }) }
    catch { /* keep empty */ }
  },
  saveProfiles: async (profiles) => {
    set({ profiles })  // optimistic
    try { const r = await api.saveProfiles(profiles); if (Array.isArray(r?.profiles)) set({ profiles: r.profiles }) }
    catch { useToasts.getState().push('프로필 저장 실패') }
  },
  setActive: (id) => set({ activeId: id }),

  openTab: (tab) => {
    const { activeId, _viewerState } = get()
    if (!activeId) return
    const cur = _viewerState[activeId] || { tabs: [], activeTabId: null }
    const existing = cur.tabs.find(t => t.path === tab.path)
    const nextVs = existing
      ? { ...cur, activeTabId: existing.id }
      : { tabs: [...cur.tabs, tab], activeTabId: tab.id }
    set({ _viewerState: { ..._viewerState, [activeId]: nextVs } })
    persistViewer(activeId, nextVs)
  },

  closeTab: (id) => {
    const { activeId, _viewerState } = get()
    if (!activeId) return
    const cur = _viewerState[activeId] || { tabs: [], activeTabId: null }
    const tab = cur.tabs.find(t => t.id === id)
    if (tab?.dirty && !window.confirm(`저장하지 않은 변경이 있습니다: ${tab.name}\n닫을까요?`)) return
    const idx = cur.tabs.findIndex(t => t.id === id)
    const next = cur.tabs.filter(t => t.id !== id)
    let nextActive = cur.activeTabId
    if (cur.activeTabId === id) {
      nextActive = next.length > 0 ? next[Math.min(idx, next.length - 1)].id : null
    }
    const nextVs = { tabs: next, activeTabId: nextActive }
    set({ _viewerState: { ..._viewerState, [activeId]: nextVs } })
    persistViewer(activeId, nextVs)
  },

  updateTab: (tabId, content) => {
    const { activeId, _viewerState } = get()
    if (!activeId) return
    const cur = _viewerState[activeId] || { tabs: [], activeTabId: null }
    const tabs = cur.tabs.map(t => t.id === tabId ? { ...t, content, dirty: true } : t)
    set({ _viewerState: { ..._viewerState, [activeId]: { ...cur, tabs } } })
  },

  markTabSaved: (tabId) => {
    const { activeId, _viewerState } = get()
    if (!activeId) return
    const cur = _viewerState[activeId] || { tabs: [], activeTabId: null }
    const tabs = cur.tabs.map(t => t.id === tabId ? { ...t, dirty: false } : t)
    set({ _viewerState: { ..._viewerState, [activeId]: { ...cur, tabs } } })
  },

  openDiffTab: (path, name, diff) => {
    const { activeId, _viewerState } = get()
    if (!activeId) return
    const id = `diff:${path}`
    const cur = _viewerState[activeId] || { tabs: [], activeTabId: null }
    const existing = cur.tabs.find(t => t.id === id)
    const tab: ViewerTab = { id, name: `⇄ ${name}`, path, content: diff, type: 'diff', lang: 'diff' }
    const tabs = existing ? cur.tabs.map(t => t.id === id ? tab : t) : [...cur.tabs, tab]
    set({ _viewerState: { ..._viewerState, [activeId]: { tabs, activeTabId: id } } })
  },

  openLogTab: (sessionId, name, content) => {
    const { activeId, _viewerState } = get()
    if (!activeId) return
    // Ephemeral like diffs (id prefixed `log:`) — a live capture, not a file, so
    // it's excluded from persistViewer and re-fetched on demand, never restored.
    const id = `log:${sessionId}`
    const cur = _viewerState[activeId] || { tabs: [], activeTabId: null }
    const existing = cur.tabs.find(t => t.id === id)
    const tab: ViewerTab = { id, name: `📜 ${name}`, path: id, content, type: 'code', lang: '' }
    const tabs = existing ? cur.tabs.map(t => t.id === id ? tab : t) : [...cur.tabs, tab]
    set({ _viewerState: { ..._viewerState, [activeId]: { tabs, activeTabId: id } } })
  },

  restoreViewerTabs: async (sessionId) => {
    const { _viewerState } = get()
    if (_viewerState[sessionId]?.tabs?.length) return  // already populated
    let saved: any
    try { saved = JSON.parse(localStorage.getItem(`agentboard.viewer.${sessionId}`) || 'null') } catch { return }
    if (!saved?.tabs?.length) return
    const tabs: ViewerTab[] = []
    for (const m of saved.tabs) {
      if (m.type === 'pdf' || m.type === 'image') {
        tabs.push({ id: m.id, path: m.path, name: m.name, type: m.type, lang: m.lang, content: m.content || '' })
        continue
      }
      try {
        const res = await api.readFile(m.path)  // fresh from disk
        let content = res.content || ''
        if (m.path.endsWith('.json')) { try { content = JSON.stringify(JSON.parse(content), null, 2) } catch {} }
        tabs.push({ id: m.id, path: m.path, name: m.name, type: m.type, lang: m.lang, content })
      } catch { /* file gone — drop it */ }
    }
    if (!tabs.length) return
    const activeTabId = tabs.find(t => t.id === saved.activeTabId)?.id || tabs[0].id
    set((s) => (s._viewerState[sessionId]?.tabs?.length ? {} : {
      _viewerState: { ...s._viewerState, [sessionId]: { tabs, activeTabId } },
    }))
  },

  setActiveTab: (id) => {
    const { activeId, _viewerState } = get()
    if (!activeId) return
    const cur = _viewerState[activeId] || { tabs: [], activeTabId: null }
    const nextVs = { ...cur, activeTabId: id }
    set({ _viewerState: { ..._viewerState, [activeId]: nextVs } })
    persistViewer(activeId, nextVs)
  },

  removeSession: (id) => {
    const state = get()
    const { [id]: _, ...rest } = state.sessions
    const updates: Partial<AppState> = { sessions: rest }
    if (state.activeId === id) {
      const ids = Object.keys(rest)
      updates.activeId = ids.length > 0 ? ids[0] : null
    }
    set(updates)
  },

  setSessions: (sessions) => {
    const map: Record<string, Session> = {}
    for (const s of sessions) map[s.id] = { ...s, host: s.host || 'local' }
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
              host: msg.host || 'local',
              hostLabel: msg.hostLabel,
            },
          },
          ...(msg.reqId ? { _spawnReqs: { ...state._spawnReqs, [msg.reqId]: msg.id } } : {}),
        })
        break

      case 'spawn-error':
        useToasts.getState().push(`세션 생성 실패${msg.hostLabel ? ` (${msg.hostLabel})` : ''}: ${msg.error}`)
        break

      case 'removed': {
        if (!state.sessions[msg.id]) break
        const { [msg.id]: _, ...rest } = state.sessions
        const updates: Partial<AppState> = { sessions: rest }
        if (state.activeId === msg.id) {
          const ids = Object.keys(rest)
          updates.activeId = ids.length > 0 ? ids[0] : null
        }
        set(updates)
        break
      }

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
            [msg.id]: {
              ...s, process: msg.process, createdAt: msg.createdAt, memKB: msg.memKB,
              altScreen: msg.altScreen ?? s.altScreen,
            },
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
