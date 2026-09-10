import { useEffect, useState } from 'react'
import { api } from './api'
import { useStore, viewerKey, workspaceEntries } from './store'
import { initWs, terminalHandlers } from './ws'
import { Login } from './components/Login'
import { Toaster } from './components/Toaster'
import { Header } from './components/Header'
import { ExplorerColumn } from './components/Sidebar/ExplorerColumn'
import { Sidebar } from './components/Sidebar/Sidebar'
import { BrowserSurfaces } from './components/Viewer/BrowserPane'
import { DesktopSplitLayout } from './components/Viewer/DesktopSplitLayout'
import * as TM from './components/Terminal/TerminalManager'

const isDesktop = () => window.innerWidth > 768

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null)
  const [loadingMsg, setLoadingMsg] = useState('Connecting...')
  const [sidebarOpen, setSidebarOpen] = useState(window.innerWidth > 768)
  const [sidebarWidth, setSidebarWidth] = useState(280)
  const [explorerWidth, setExplorerWidth] = useState(240)
  const [explorerOpen, setExplorerOpen] = useState(isDesktop)
  const [desktop, setDesktop] = useState(isDesktop)
  const workspaceKey = useStore(viewerKey)
  useEffect(() => {
    let previousDesktop = isDesktop()
    const resize = () => {
      const next = isDesktop()
      if (previousDesktop && !next) { setSidebarOpen(false); setExplorerOpen(false) }
      previousDesktop = next
      setDesktop(next)
    }
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  const anyDirty = useStore(s => Object.values(s._viewerState).some(v => v.tabs.some(t => t.dirty)))
  useEffect(() => {
    if (!anyDirty) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [anyDirty])

  // Re-open the files that were open in this workspace (read fresh from disk).
  useEffect(() => { if (authed) useStore.getState().restoreViewerTabs(workspaceKey) }, [workspaceKey, authed])

  useEffect(() => {
    setLoadingMsg('Loading sessions...')
    api.workers()
      .then((sessions) => {
        setLoadingMsg(`${sessions.length} sessions loaded`)
        useStore.getState().setSessions(sessions)
        useStore.getState().loadProfiles()
        setAuthed(true)
      })
      .catch(() => setAuthed(false))
  }, [])

  useEffect(() => {
    if (!authed) return

    terminalHandlers.onSnapshot = TM.writeSnapshot
    terminalHandlers.onScreen = TM.writeScreen
    terminalHandlers.onStream = TM.writeStream

    initWs()

    const state = useStore.getState()
    const entries = workspaceEntries(state)
    const ids = entries.flatMap(e => e.ids)
    let remembered: string[] = []
    try { remembered = JSON.parse(localStorage.getItem('agentboard.lastWorkspace') || '[]') } catch {}
    const previous = entries.find(e => e.host === remembered[0] && e.cwd === remembered[1])
    if (previous) {
      state.setWorkspace(previous.cwd, previous.host)
      useStore.setState({activeId: previous.ids[0] || null})
    } else if (!state.activeId && ids.length > 0) {
      state.setActive(ids[0])  // TerminalPane's effect notifies + snapshots
    } else if (!state.workspaceCwd && entries.length) {
      state.setWorkspace(entries[0].cwd, entries[0].host)
    }

    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault()
        setSidebarOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)

    // Open a session from a notification click (?session=<id> or SW message).
    const openSession = (id: string) => {
      if (!id) return
      const tryOpen = () => {
        if (useStore.getState().sessions[id]) {
          useStore.getState().setActive(id)  // effect notifies + snapshots
          return true
        }
        return false
      }
      if (!tryOpen()) {
        const t = setInterval(() => { if (tryOpen()) clearInterval(t) }, 200)
        setTimeout(() => clearInterval(t), 5000)
      }
    }
    const initial = new URLSearchParams(location.search).get('session')
    if (initial) openSession(initial)
    const onSwMsg = (e: MessageEvent) => {
      if (e.data?.type === 'open-session' && e.data.url) {
        const sid = new URL(e.data.url, location.origin).searchParams.get('session')
        if (sid) openSession(sid)
      }
    }
    navigator.serviceWorker?.addEventListener('message', onSwMsg)

    return () => {
      window.removeEventListener('keydown', onKey)
      navigator.serviceWorker?.removeEventListener('message', onSwMsg)
    }
  }, [authed])

  if (authed === null) return (
    <div className="login-screen">
      <div className="loading-splash">
        <div className="spinner" />
        <span className="loading-text">{loadingMsg}</span>
      </div>
    </div>
  )
  if (!authed) return <Login onLogin={() => {
    setLoadingMsg('Loading sessions...')
    api.workers().then((sessions) => {
      setLoadingMsg(`${sessions.length} sessions loaded`)
      useStore.getState().setSessions(sessions)
      setAuthed(true)
    })
  }} />

  return (
    <div className="app">
      <BrowserSurfaces />
      <Toaster />
      <Header onToggleSidebar={() => setSidebarOpen((v) => !v)} />
      <div className="workspace">
        <Sidebar visible={sidebarOpen} onClose={() => setSidebarOpen(false)} width={sidebarWidth} />
        {sidebarOpen && desktop && (
          <div
            className="sidebar-resizer"
            onMouseDown={(e) => {
              e.preventDefault()
              const startX = e.clientX
              const startW = sidebarWidth
              const onMove = (ev: MouseEvent) => setSidebarWidth(Math.min(420, Math.max(240, startW + ev.clientX - startX)))
              const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); document.body.style.cursor = '' }
              document.body.style.cursor = 'col-resize'
              document.addEventListener('mousemove', onMove)
              document.addEventListener('mouseup', onUp)
            }}
          />
        )}
        {desktop && (explorerOpen ? <>
          <ExplorerColumn width={explorerWidth} onClose={() => setExplorerOpen(false)} />
          <div className="sidebar-resizer" title="파일 탐색기 너비 조절" onMouseDown={e => {
            e.preventDefault()
            const startX = e.clientX, startW = explorerWidth
            const move = (ev: MouseEvent) => setExplorerWidth(Math.min(420, Math.max(180, startW + ev.clientX - startX)))
            const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); document.body.style.cursor = '' }
            document.body.style.cursor = 'col-resize'
            document.addEventListener('mousemove', move); document.addEventListener('mouseup', up)
          }} />
        </> : <button className="explorer-reopen" onClick={() => setExplorerOpen(true)} title="파일 탐색기 열기">파일 ›</button>)}
        {!desktop && <>
          <button className="mobile-files-toggle" onClick={() => setExplorerOpen(v => !v)}>파일</button>
          {explorerOpen && <ExplorerColumn width={Math.min(320, window.innerWidth - 40)} onClose={() => setExplorerOpen(false)} />}
        </>}
        <main className="main-area">
          <DesktopSplitLayout />
        </main>
      </div>
    </div>
  )
}
