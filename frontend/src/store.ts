import {observeCompletion} from './completions'
import {uiId} from './uiId'
import { create } from 'zustand'
import type { Session, WsMessage, SpawnProfile } from './types'
import { useToasts } from './toasts'
import { browserUrl } from './components/Viewer/browserUrl'
import { api } from './api'

export interface ViewerTab {
  id: string
  name: string
  path: string
  content: string
  type: 'code' | 'markdown' | 'latex' | 'pdf' | 'image' | 'diff' | 'notebook' | 'terminal' | 'browser'
  lang: string
  dirty?: boolean
  version?: string
  browser?: { history: string[]; index: number }
  sessionId?: string
  viewState?: { scrollTop?: number; scrollLeft?: number; page?: number; zoom?: number; pageOffset?: number; pdfScrollLeft?: number; cursor?: number; editorScroll?: number }
}

interface AppState {
  connection: 'connecting' | 'online' | 'offline'
  hiddenSessions: string[]
  setSessionHidden: (id: string, hidden: boolean) => void
  sessions: Record<string, Session>
  activeId: string | null
  titles: Record<string, string>
  tunnelUrl: string | null

  // Viewer tabs per workspace (host + root path)
  _restoredWorkspaces: Record<string, boolean>
  updateTabView: (id: string, view: NonNullable<ViewerTab['viewState']>, key?: string) => void
  reorderTab: (id: string, target: string, after?: boolean) => void
  ensureSessionTabs: (key: string) => void
  _viewerState: Record<string, { tabs: ViewerTab[]; activeTabId: string | null }>
  viewerTabs: ViewerTab[]       // computed: current session's tabs
  activeTabId: string | null    // computed: current session's active tab

  // Completion flash tracking
  _completedAt: Record<string, number>
  unreadCompletions: string[]
  acknowledgeCompletion: (id: string) => void

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
  workspaceHost: string

  // How the workspace shows its sessions: one at a time, or all tiled.
  viewMode: 'single' | 'grid'

  // Launch profiles for the "+" button (Claude variants, Codex, terminal, …).
  profiles: SpawnProfile[]
  profileEditorOpen: boolean

  // Registered workspace folders — a workspace can exist with 0 sessions, so
  // these are tracked explicitly (persisted) in addition to session-derived ones.
  workspaceFolders: string[]
  workspaceModalOpen: boolean
  workspaceOrder: string[]
  hiddenWorkspaces: string[]

  // Actions
  openProfileEditor: () => void
  closeProfileEditor: () => void
  openWorkspaceModal: () => void
  closeWorkspaceModal: () => void
  addWorkspaceFolder: (cwd: string) => void
  removeWorkspaceFolder: (cwd: string, host?: string) => void
  reorderWorkspace: (key: string, before: string, after?: boolean) => void
  restoreWorkspace: (key: string) => void
  openSpawn: (preset?: { cwd?: string; host?: string }) => void
  closeSpawn: () => void
  setWorkspace: (cwd: string, host?: string) => void
  setViewMode: (m: 'single' | 'grid') => void
  upsertSession: (s: { id: string; cwd: string; cmd: string; host?: string }) => void
  loadProfiles: () => Promise<void>
  saveProfiles: (profiles: SpawnProfile[]) => Promise<void>
  setActive: (id: string | null) => void
  removeSession: (id: string) => void
  openBrowser: (url?: string, key?: string) => void
  navigateBrowser: (id: string, url: string, key: string) => void
  stepBrowser: (id: string, delta: number, key: string) => void
  openTab: (tab: ViewerTab, key?: string) => void
  closeTab: (id: string) => void
  updateTab: (tabId: string, content: string, key?: string) => void
  markTabSaved: (tabId: string, content?: string, version?: string, key?: string) => void
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
        id: t.id, path: t.path, name: t.name, type: t.type, lang: t.lang, sessionId: t.sessionId, browser: t.browser, viewState: t.viewState,
        content: (t.type === 'pdf' || t.type === 'image') ? t.content : undefined,
      }))
    localStorage.setItem(`agentboard.viewer.${sessionId}`, JSON.stringify({ tabs: meta, activeTabId: vs.activeTabId }))
  } catch { /* quota / disabled — ignore */ }
}

export function viewerKey(state: Pick<AppState, 'workspaceCwd' | 'workspaceHost' | 'activeId' | 'sessions'>): string {
  const session = state.activeId ? state.sessions[state.activeId] : undefined
  return JSON.stringify([state.workspaceHost || session?.host || 'local', state.workspaceCwd || session?.cwd || '~'])
}

function readStringList(key: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]')
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
  } catch { return [] }
}
function persistList(key: string, value: string[]) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage disabled */ }
}

export function sessionLabel(session: Session, titles: Record<string, string>): string {
  const manual = titles[session.id]?.trim()
  const generic = /^(?:(?:claude|codex|terminal|bash|zsh)\s*[·# ]*\d+|#\d+\s*(?:claude|codex|terminal|bash|zsh))$/i
  if (manual && !generic.test(manual)) return manual
  return session.autoTitle?.trim() || `${session.cmd || session.process || '터미널'} · 제목 대기`
}

export const completionKey = (session: Session) => JSON.stringify([session.host || 'local', session.sessionName || session.id, session.cwd || '~'])

export const workspaceId = (cwd: string, host = 'local') => JSON.stringify([host, cwd])
export interface WorkspaceEntry { key: string; cwd: string; host: string; ids: string[] }
export function workspaceEntries(state: Pick<AppState, 'sessions' | 'workspaceFolders' | 'workspaceOrder' | 'hiddenWorkspaces' | 'hiddenSessions'>, includeHidden = false): WorkspaceEntry[] {
  const entries = new Map<string, WorkspaceEntry>()
  const add = (cwd: string, host = 'local', id?: string) => {
    const key = workspaceId(cwd, host)
    if (!entries.has(key)) entries.set(key, { key, cwd, host, ids: [] })
    if (id) entries.get(key)!.ids.push(id)
  }
  for (const cwd of state.workspaceFolders) add(cwd)
  for (const session of Object.values(state.sessions)) {
    if (!includeHidden && state.hiddenSessions.includes(completionKey(session))) continue
    add(session.cwd || '~', session.host || 'local', session.id)
  }
  // Keep removed empty/remote workspaces available for restoration as well.
  for (const key of [...state.workspaceOrder, ...state.hiddenWorkspaces]) {
    try { const [host, cwd] = JSON.parse(key); if (typeof host === 'string' && typeof cwd === 'string') add(cwd, host) } catch {}
  }
  const rank = new Map(state.workspaceOrder.map((key, i) => [key, i]))
  return [...entries.values()].filter(e => includeHidden || !state.hiddenWorkspaces.includes(e.key))
    .sort((a, b) => (rank.get(a.key) ?? Infinity) - (rank.get(b.key) ?? Infinity) || a.cwd.localeCompare(b.cwd) || a.host.localeCompare(b.host))
}

const restoringViewers = new Set<string>()

export const useStore = create<AppState>((set, get) => ({
  connection: 'online',
  hiddenSessions: readStringList('agentboard.hiddenSessions'),
  setSessionHidden: (id, hidden) => {
    const state = get(), session = state.sessions[id]
    if (!session) return
    const key = completionKey(session)
    const next = hidden ? [...new Set([...state.hiddenSessions, key])] : state.hiddenSessions.filter(k => k !== key)
    persistList('agentboard.hiddenSessions', next)
    const viewers = {...state._viewerState}
    if (hidden) for (const [owner, view] of Object.entries(viewers)) {
      const tabs = view.tabs.filter(t => t.sessionId !== id)
      if (tabs.length === view.tabs.length) continue
      viewers[owner] = {tabs, activeTabId: tabs.some(t => t.id === view.activeTabId) ? view.activeTabId : tabs[0]?.id || null}
      persistViewer(owner, viewers[owner])
    }
    set({hiddenSessions: next, _viewerState: viewers, ...(hidden && state.activeId === id ? {activeId: null} : {})})
  },
  sessions: {},
  activeId: null,
  titles: {},
  tunnelUrl: null,
  _viewerState: {},
  _restoredWorkspaces: {},
  _completedAt: {},
  unreadCompletions: readStringList('agentboard.unreadCompletions'),
  acknowledgeCompletion: (id) => set(state => {
    const session = state.sessions[id]
    if (!session) return {}
    const unread = state.unreadCompletions.filter(key => key !== completionKey(session))
    persistList('agentboard.unreadCompletions', unread)
    const completed = { ...state._completedAt }; delete completed[id]
    return { unreadCompletions: unread, _completedAt: completed }
  }),
  _spawnReqs: {},
  spawnOpen: false,
  spawnPreset: {},
  workspaceCwd: null,
  workspaceHost: 'local',
  viewMode: ((typeof localStorage !== 'undefined' && localStorage.getItem('agentboard.viewMode')) as 'single' | 'grid') || 'single',
  profiles: [],
  profileEditorOpen: false,
  workspaceFolders: (() => {
    try { return JSON.parse(localStorage.getItem('agentboard.workspaceFolders') || '[]') } catch { return [] }
  })(),
  workspaceModalOpen: false,
  workspaceOrder: readStringList('agentboard.workspaceOrder'),
  hiddenWorkspaces: readStringList('agentboard.hiddenWorkspaces'),

  // These are unused placeholders — use selectors instead:
  // useStore(s => s._viewerState[s.activeId]?.tabs || [])
  viewerTabs: [],
  activeTabId: null,

  openSpawn: (preset = {}) => set({ spawnOpen: true, spawnPreset: preset }),
  closeSpawn: () => set({ spawnOpen: false, spawnPreset: {} }),
  setWorkspace: (cwd, host = 'local') => { persistList('agentboard.lastWorkspace', [host, cwd]); set({ workspaceCwd: cwd, workspaceHost: host }) },
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
    const next = state.workspaceFolders.includes(cwd) ? state.workspaceFolders : [...state.workspaceFolders, cwd]
    const hidden = state.hiddenWorkspaces.filter(key => key !== workspaceId(cwd))
    persistList('agentboard.workspaceFolders', next)
    persistList('agentboard.hiddenWorkspaces', hidden)
    return { workspaceFolders: next, hiddenWorkspaces: hidden }
  }),
  removeWorkspaceFolder: (cwd, host = 'local') => set((state) => {
    const key = workspaceId(cwd, host)
    const hidden = [...new Set([...state.hiddenWorkspaces, key])]
    persistList('agentboard.hiddenWorkspaces', hidden)
    const updates: Partial<AppState> = { hiddenWorkspaces: hidden }
    if (viewerKey(state) === key) {
      const next = workspaceEntries({ ...state, hiddenWorkspaces: hidden })[0]
      updates.workspaceCwd = next?.cwd || null
      updates.workspaceHost = next?.host || 'local'
      updates.activeId = next?.ids.find(id => state.sessions[id].status === 'running') || next?.ids[0] || null
    }
    return updates
  }),
  reorderWorkspace: (key, before, after = false) => set(state => {
    const keys = workspaceEntries(state).map(e => e.key)
    if (key === before || !keys.includes(key) || !keys.includes(before)) return {}
    const next = keys.filter(k => k !== key)
    next.splice(next.indexOf(before) + (after ? 1 : 0), 0, key)
    persistList('agentboard.workspaceOrder', next)
    return { workspaceOrder: next }
  }),
  restoreWorkspace: (key) => set(state => {
    const hidden = state.hiddenWorkspaces.filter(k => k !== key)
    persistList('agentboard.hiddenWorkspaces', hidden)
    const entry = workspaceEntries(state, true).find(e => e.key === key)
    const folders = entry?.host === 'local' && !state.workspaceFolders.includes(entry.cwd)
      ? [...state.workspaceFolders, entry.cwd] : state.workspaceFolders
    persistList('agentboard.workspaceFolders', folders)
    const order = entry && !state.workspaceOrder.includes(key) ? [...workspaceEntries(state, true).map(e => e.key)] : state.workspaceOrder
    persistList('agentboard.workspaceOrder', order)
    return { hiddenWorkspaces: hidden, workspaceFolders: folders, workspaceOrder: order }
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
  setActive: (id) => set((state) => {
    const session = id ? state.sessions[id] : undefined
    if (!session) return { activeId: id }
    const hiddenSessions = state.hiddenSessions.filter(k => k !== completionKey(session))
    persistList('agentboard.hiddenSessions', hiddenSessions)
    const key = workspaceId(session.cwd || '~', session.host || 'local')
    persistList('agentboard.lastWorkspace', [session.host || 'local', session.cwd || '~'])
    const hidden = state.hiddenWorkspaces.filter(k => k !== key)
    if (hidden.length !== state.hiddenWorkspaces.length) persistList('agentboard.hiddenWorkspaces', hidden)
    const current = state._viewerState[key] || { tabs: [], activeTabId: null }
    const tabId = `terminal:${id}`
    const tab: ViewerTab = { id: tabId, path: tabId, name: sessionLabel(session, state.titles), content: '', type: 'terminal', lang: '', sessionId: id! }
    const tabs = current.tabs.some(t => t.id === tabId) ? current.tabs : [...current.tabs, tab]
    if (state._restoredWorkspaces[key]) persistViewer(key, { tabs, activeTabId: tabId })
    return { hiddenSessions, activeId: id, workspaceCwd: session.cwd || '~', workspaceHost: session.host || 'local', hiddenWorkspaces: hidden,
      _viewerState: { ...state._viewerState, [key]: { tabs, activeTabId: tabId } } }
  }),

  openBrowser: (input = '', owner) => {
    const state = get(), key = owner || viewerKey(state)
    const url = input ? browserUrl(input) : null
    if (input && !url) { useToasts.getState().push('HTTP 또는 HTTPS 주소를 입력해 주세요.'); return }
    const existing = state._viewerState[key]?.tabs.find(t=>t.type==='browser' && t.browser?.history[t.browser.index]===url)
    if (existing) {
      const current=state._viewerState[key], next={...current,activeTabId:existing.id}
      set({_viewerState:{...state._viewerState,[key]:next}});persistViewer(key,next);return
    }
    const id = `browser:${uiId()}`
    state.openTab({id,path:id,name:url?new URL(url).host:'새 웹 탭',type:'browser',content:'',lang:'',browser:{history:url?[url]:[],index:url?0:-1}},key)
  },
  navigateBrowser: (id, input, key) => set(state => {
    const url=browserUrl(input), current=state._viewerState[key]
    if (!url || !current) return {}
    const tabs=current.tabs.map(tab=>{
      if(tab.id!==id||tab.type!=='browser')return tab
      const browser=tab.browser||{history:[],index:-1}
      const history=[...browser.history.slice(0,browser.index+1),url].slice(-50)
      return {...tab,name:new URL(url).host,browser:{history,index:history.length-1}}
    })
    const next={...current,tabs};persistViewer(key,next)
    return {_viewerState:{...state._viewerState,[key]:next}}
  }),
  stepBrowser: (id, delta, key) => set(state => {
    const current=state._viewerState[key];if(!current)return {}
    const tabs=current.tabs.map(tab=>{
      if(tab.id!==id||tab.type!=='browser'||!tab.browser)return tab
      const index=Math.max(0,Math.min(tab.browser.history.length-1,tab.browser.index+delta))
      const url=tab.browser.history[index]
      return url?{...tab,name:new URL(url).host,browser:{...tab.browser,index}}:tab
    })
    const next={...current,tabs};persistViewer(key,next)
    return {_viewerState:{...state._viewerState,[key]:next}}
  }),

  openTab: (tab, key) => {
    const { _viewerState } = get()
    const activeId = key || viewerKey(get())
    const cur = _viewerState[activeId] || { tabs: [], activeTabId: null }
    const existing = cur.tabs.find(t => t.path === tab.path)
    if (!existing && tab.type !== 'terminal') {
      try { tab = {...tab, viewState: JSON.parse(localStorage.getItem(`agentboard.fileView.${activeId}:${tab.path}`) || 'null') || tab.viewState} } catch {}
    }
    const nextVs = existing
      ? { ...cur, activeTabId: existing.id }
      : { tabs: [...cur.tabs, tab], activeTabId: tab.id }
    set({ _viewerState: { ..._viewerState, [activeId]: nextVs } })
    persistViewer(activeId, nextVs)
  },

  closeTab: (id) => {
    const { _viewerState } = get()
    const activeId = viewerKey(get())
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

  updateTab: (tabId, content, key) => {
    const { _viewerState } = get()
    const activeId = key || viewerKey(get())
    const cur = _viewerState[activeId] || { tabs: [], activeTabId: null }
    const tabs = cur.tabs.map(t => t.id === tabId ? { ...t, content, dirty: true } : t)
    set({ _viewerState: { ..._viewerState, [activeId]: { ...cur, tabs } } })
  },

  markTabSaved: (tabId, content, version, key) => {
    const state = get()
    const owner = key || viewerKey(state)
    const cur = state._viewerState[owner]
    if (!cur) return
    const tabs = cur.tabs.map(t => t.id === tabId ? {
      ...t, dirty: content !== undefined && t.content !== content,
      version: version ?? t.version,
    } : t)
    set({ _viewerState: { ...state._viewerState, [owner]: { ...cur, tabs } } })
  },

  openDiffTab: (path, name, diff) => {
    const { _viewerState } = get()
    const activeId = viewerKey(get())
    const id = `diff:${path}`
    const cur = _viewerState[activeId] || { tabs: [], activeTabId: null }
    const existing = cur.tabs.find(t => t.id === id)
    const tab: ViewerTab = { id, name: `⇄ ${name}`, path, content: diff, type: 'diff', lang: 'diff' }
    const tabs = existing ? cur.tabs.map(t => t.id === id ? tab : t) : [...cur.tabs, tab]
    set({ _viewerState: { ..._viewerState, [activeId]: { tabs, activeTabId: id } } })
  },

  openLogTab: (sessionId, name, content) => {
    const { _viewerState } = get()
    const activeId = viewerKey(get())
    // Ephemeral like diffs (id prefixed `log:`) — a live capture, not a file, so
    // it's excluded from persistViewer and re-fetched on demand, never restored.
    const id = `log:${sessionId}`
    const cur = _viewerState[activeId] || { tabs: [], activeTabId: null }
    const existing = cur.tabs.find(t => t.id === id)
    const tab: ViewerTab = { id, name: `📜 ${name}`, path: id, content, type: 'code', lang: '' }
    const tabs = existing ? cur.tabs.map(t => t.id === id ? tab : t) : [...cur.tabs, tab]
    set({ _viewerState: { ..._viewerState, [activeId]: { tabs, activeTabId: id } } })
  },

  restoreViewerTabs: async (key) => {
    const state = get()
    if (state._restoredWorkspaces[key] || restoringViewers.has(key)) return
    restoringViewers.add(key)
    const baseline = state._viewerState[key]
    let saved: {tabs?: ViewerTab[]; activeTabId?: string} | null = null
    try { saved = JSON.parse(localStorage.getItem(`agentboard.viewer.${key}`) || 'null') } catch {}
    if (!saved) {
      const legacyTabs: ViewerTab[] = []
      for (const session of Object.values(state.sessions)) {
        if (workspaceId(session.cwd || '~', session.host || 'local') !== key || session.host !== 'local') continue
        try {
          const legacy = JSON.parse(localStorage.getItem(`agentboard.viewer.${session.id}`) || 'null')
          for (const tab of legacy?.tabs || []) if (!legacyTabs.some(t => t.id === tab.id)) legacyTabs.push(tab)
        } catch {}
      }
      saved = {tabs: legacyTabs, activeTabId: legacyTabs[0]?.id}
    }
    const restored: ViewerTab[] = []
    for (const tab of saved.tabs || []) {
      if (tab.type === 'browser') {
        const history=(tab.browser?.history||[]).map(browserUrl).filter((url):url is string=>!!url).slice(-50)
        const index=Math.max(-1,Math.min(history.length-1,tab.browser?.index??history.length-1))
        restored.push({...tab,content:'',browser:{history,index}});continue
      }
      if (tab.type === 'terminal') {
        const session = tab.sessionId ? get().sessions[tab.sessionId] : undefined
        if (session && !get().hiddenSessions.includes(completionKey(session)) && workspaceId(session.cwd || '~', session.host || 'local') === key) restored.push({...tab, content: ''})
        continue
      }
      try { if (JSON.parse(key)[0] !== 'local') continue } catch { continue }
      if (tab.type === 'pdf' || tab.type === 'image') { restored.push({...tab, content: tab.content || ''}); continue }
      try {
        const res = await api.readFile(tab.path)
        restored.push({...tab, content: res.content || '', version: res.version})
      } catch { /* file disappeared */ }
    }
    set(current => {
      const latest = current._viewerState[key]
      const latestTabs = latest?.tabs || []
      const tabs = [...restored.map(t => latestTabs.find(n => n.id === t.id) || t), ...latestTabs.filter(t => !restored.some(r => r.id === t.id))]
      const chosen = latest === baseline ? saved?.activeTabId : latest?.activeTabId
      const activeTabId = tabs.some(t => t.id === chosen) ? chosen! : tabs[0]?.id || null
      const active = tabs.find(t => t.id === activeTabId)
      const vs = { tabs, activeTabId }
      persistViewer(key, vs)
      return { _viewerState: {...current._viewerState, [key]: vs}, _restoredWorkspaces: {...current._restoredWorkspaces, [key]: true},
        ...(viewerKey(current) === key && active?.type === 'terminal' && active.sessionId ? {activeId: active.sessionId} : {}) }
    })
    restoringViewers.delete(key)
  },

  ensureSessionTabs: (key) => set(state => {
    const current = state._viewerState[key] || {tabs:[],activeTabId:null}
    const tabs = current.tabs.filter(tab => !tab.sessionId || (state.sessions[tab.sessionId] && !state.hiddenSessions.includes(completionKey(state.sessions[tab.sessionId]))))
    const missing = Object.values(state.sessions).filter(session => !state.hiddenSessions.includes(completionKey(session)) && workspaceId(session.cwd || '~', session.host || 'local') === key && !tabs.some(tab => tab.sessionId === session.id))
    if (!missing.length && tabs.length === current.tabs.length) return {}
    const added: ViewerTab[] = missing.map(session => ({id:`terminal:${session.id}`,path:`terminal:${session.id}`,name:sessionLabel(session,state.titles),type:'terminal',content:'',lang:'',sessionId:session.id}))
    const nextTabs = [...tabs,...added]
    const next = {tabs:nextTabs,activeTabId:nextTabs.some(t=>t.id===current.activeTabId)?current.activeTabId:nextTabs[0]?.id||null}
    persistViewer(key,next)
    return {_viewerState:{...state._viewerState,[key]:next}}
  }),

  updateTabView: (id, view, key) => set(state => {
    const owner = key || viewerKey(state), current = state._viewerState[owner]
    if (!current?.tabs.some(t => t.id === id)) return {}
    const next = {...current, tabs: current.tabs.map(t => t.id === id ? {...t, viewState: {...t.viewState, ...view}} : t)}
    const updated = next.tabs.find(t => t.id === id)!
    if (updated.type !== 'terminal') { try { localStorage.setItem(`agentboard.fileView.${owner}:${updated.path}`, JSON.stringify(updated.viewState)) } catch {} }
    persistViewer(owner, next)
    return {_viewerState: {...state._viewerState, [owner]: next}}
  }),
  reorderTab: (id, target, after = false) => set(state => {
    const key = viewerKey(state), current = state._viewerState[key]
    const item = current?.tabs.find(t => t.id === id)
    if (!item || id === target || !current.tabs.some(t => t.id === target)) return {}
    const tabs = current.tabs.filter(t => t.id !== id)
    tabs.splice(tabs.findIndex(t => t.id === target) + (after ? 1 : 0), 0, item)
    const next = {...current, tabs}; persistViewer(key, next)
    return {_viewerState: {...state._viewerState, [key]: next}}
  }),

  setActiveTab: (id) => {
    const { _viewerState } = get()
    const activeId = viewerKey(get())
    const cur = _viewerState[activeId] || { tabs: [], activeTabId: null }
    const nextVs = { ...cur, activeTabId: id }
    set({ _viewerState: { ..._viewerState, [activeId]: nextVs } })
    persistViewer(activeId, nextVs)
  },

  removeSession: (id) => {
    const state = get()
    const { [id]: _, ...rest } = state.sessions
    const unread = state.unreadCompletions.filter(key => !state.sessions[id] || key !== completionKey(state.sessions[id]))
    persistList('agentboard.unreadCompletions', unread)
    const updates: Partial<AppState> = { sessions: rest, unreadCompletions: unread }
    if (state.activeId === id) {
      const ids = Object.keys(rest).filter(id => rest[id].cwd === state.workspaceCwd && (rest[id].host || 'local') === state.workspaceHost)
      updates.activeId = ids.length > 0 ? ids[0] : null
    }
    set(updates)
  },

  setSessions: (sessions) => {
    const state = get(), unread = new Set(state.unreadCompletions)
    const map: Record<string, Session> = {}
    for (const s of sessions) {
      map[s.id] = { ...s, host: s.host || 'local', online: s.online !== false }
      if (s.completionId && observeCompletion(map[s.id], s.completionId, true)) unread.add(completionKey(map[s.id]))
    }
    // A missing remote host is disconnected, not a terminated process.
    for (const s of Object.values(state.sessions)) if (s.host !== 'local' && !map[s.id]) map[s.id] = {...s, online:false}
    persistList('agentboard.unreadCompletions', [...unread])
    set({ sessions: map, unreadCompletions: [...unread], ...(state.activeId && !map[state.activeId] ? {activeId: Object.values(map).find(s=>s.cwd===state.workspaceCwd && s.host===state.workspaceHost && !state.hiddenSessions.includes(completionKey(s)))?.id || null} : {}) })
  },

  handleMessage: (msg) => {
    const state = get()

    switch (msg.type) {
      case 'sessions':
        state.setSessions(msg.sessions)
        break
      case 'host-connection':
        set({sessions: Object.fromEntries(Object.entries(state.sessions).map(([id,s]) => [id, s.host === msg.host ? {...s,online:msg.online} : s]))})
        break
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
              aiState: state.sessions[msg.id]?.aiState || null,
              process: state.sessions[msg.id]?.process || '',
              createdAt: state.sessions[msg.id]?.createdAt || 0,
              memKB: state.sessions[msg.id]?.memKB || 0,
              completionId: state.sessions[msg.id]?.completionId,
              autoTitle: state.sessions[msg.id]?.autoTitle,
              lastActivityAt: state.sessions[msg.id]?.lastActivityAt,
              online: true,
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
        const unread = state.unreadCompletions.filter(key => key !== completionKey(state.sessions[msg.id]))
        persistList('agentboard.unreadCompletions', unread)
        const updates: Partial<AppState> = { sessions: rest, unreadCompletions: unread }
        if (state.activeId === msg.id) {
          const ids = Object.keys(rest).filter(id => rest[id].cwd === state.workspaceCwd && (rest[id].host || 'local') === state.workspaceHost)
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

        const unread = new Set(state.unreadCompletions)
        if (msg.status === 'completed' && s.status !== 'completed') unread.add(completionKey(s))
        persistList('agentboard.unreadCompletions', [...unread])
        // Track completion time for flash
        const ca = { ...state._completedAt }
        if (prev === 'working' && msg.status === 'completed') {
          ca[msg.id] = Date.now()
        }

        set({
          sessions: { ...state.sessions, [msg.id]: updated },
          _completedAt: ca,
          unreadCompletions: [...unread],
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
        const unread = new Set(state.unreadCompletions)
        const newCompletion = msg.state === 'idle' && (msg.completionId ? observeCompletion(s, msg.completionId) : msg.completionId == null && s.aiState === 'working')
        if (newCompletion) {
          ca[msg.id] = Date.now()
          unread.add(completionKey(s))
          persistList('agentboard.unreadCompletions', [...unread])
        }
        set({
          sessions: { ...state.sessions, [msg.id]: { ...s, aiState: msg.state, completionId: msg.completionId ?? s.completionId } },
          _completedAt: ca,
          unreadCompletions: [...unread],
        })
        break
      }

      case 'activity': {
        const s = state.sessions[msg.id]
        if (s) set({sessions: {...state.sessions, [msg.id]: {...s, lastActivityAt: msg.lastActivityAt}}})
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
              autoTitle: msg.autoTitle ?? s.autoTitle,
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
    if (state.connection !== 'online' || s.online === false) return 'disconnected'
    if (s.status === 'stopped') return 'stopped'
    if (s.status === 'completed') return 'completed'

    // A completed turn is an unread event, not a temporary process state.
    return s.aiState || 'running'
  },
}))
