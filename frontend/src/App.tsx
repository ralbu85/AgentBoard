import { useEffect, useState } from 'react'
import { api } from './api'
import { useStore } from './store'
import { initWs, terminalHandlers } from './ws'
import { Login } from './components/Login'
import { Toaster } from './components/Toaster'
import { Header } from './components/Header'
import { Sidebar } from './components/Sidebar/Sidebar'
import { TerminalArea } from './components/Terminal/TerminalArea'
import { DesktopSplitLayout } from './components/Viewer/DesktopSplitLayout'
import * as TM from './components/Terminal/TerminalManager'

const isDesktop = () => window.innerWidth > 768

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null)
  const [loadingMsg, setLoadingMsg] = useState('Connecting...')
  const [sidebarOpen, setSidebarOpen] = useState(window.innerWidth > 768)
  const [sidebarWidth, setSidebarWidth] = useState(220)

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
    const ids = Object.keys(state.sessions)
    if (!state.activeId && ids.length > 0) {
      state.setActive(ids[0])  // TerminalPane's effect notifies + snapshots
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
      <Toaster />
      <Header onToggleSidebar={() => setSidebarOpen((v) => !v)} />
      <div className="workspace">
        <Sidebar visible={sidebarOpen} onClose={() => setSidebarOpen(false)} width={sidebarWidth} />
        {sidebarOpen && isDesktop() && (
          <div
            className="sidebar-resizer"
            onMouseDown={(e) => {
              e.preventDefault()
              const startX = e.clientX
              const startW = sidebarWidth
              const onMove = (ev: MouseEvent) => setSidebarWidth(Math.min(400, Math.max(140, startW + ev.clientX - startX)))
              const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); document.body.style.cursor = '' }
              document.body.style.cursor = 'col-resize'
              document.addEventListener('mousemove', onMove)
              document.addEventListener('mouseup', onUp)
            }}
          />
        )}
        <main className="main-area">
          {isDesktop() ? (
            <DesktopSplitLayout />
          ) : (
            <TerminalArea />
          )}
        </main>
      </div>
    </div>
  )
}
