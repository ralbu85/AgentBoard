import { useState, useEffect } from 'react'
import { useStore } from '../store'
import { SessionManager } from './SessionManager'
import { SpawnModal } from './SpawnModal/SpawnModal'
import { ProfileEditor } from './SpawnModal/ProfileEditor'
import { WorkspaceModal } from './Sidebar/WorkspaceModal'
import { pushSupported, notificationsEnabled, enableNotifications, disableNotifications } from '../push'
import { useToasts } from '../toasts'

interface Props {
  onToggleSidebar: () => void
}

const ACTIVE_STATE_DISPLAY: Record<string, { label: string; icon: string; cls: string }> = {
  working:   { label: 'Thinking', icon: '●', cls: 'badge-working' },
  waiting:   { label: 'Asking',   icon: '◆', cls: 'badge-waiting' },
  completed: { label: 'Done',     icon: '✓', cls: 'badge-done' },
  idle:      { label: 'Idle',     icon: '○', cls: 'badge-idle' },
  disconnected: { label: '연결 끊김', icon: '○', cls: 'badge-offline' },
  running: { label: '확인 중', icon: '○', cls: 'badge-idle' },
  stopped:   { label: 'Stopped',  icon: '■', cls: 'badge-stopped' },
}

export function Header({ onToggleSidebar }: Props) {
  const connection = useStore(s => s.connection)
  const sessions = useStore((s) => s.sessions)
  const activeId = useStore((s) => s.activeId)
  const effectiveState = useStore((s) => s.effectiveState)
  const [showScan, setShowScan] = useState(false)
  const spawnOpen = useStore((s) => s.spawnOpen)
  const openSpawn = useStore((s) => s.openSpawn)
  const closeSpawn = useStore((s) => s.closeSpawn)
  const [notif, setNotif] = useState(false)
  const canNotify = pushSupported()

  useEffect(() => {
    if (canNotify) notificationsEnabled().then(setNotif)
  }, [canNotify])

  const toggleNotif = async () => {
    const toast = (m: string) => useToasts.getState().push(m)
    if (notif) {
      await disableNotifications()
      setNotif(false)
      toast('알림을 껐습니다')
      return
    }
    const r = await enableNotifications()
    if (r === 'ok') { setNotif(true); toast('알림 켜짐 — 세션이 입력 대기/완료되면 알려드립니다') }
    else if (r === 'denied') toast('브라우저에서 알림이 차단됨 — 사이트 알림 권한을 허용하세요')
    else if (r === 'unsupported') toast('이 브라우저는 푸시 알림 미지원 (iOS는 홈 화면에 추가 후 사용)')
    else toast('알림 설정에 실패했습니다')
  }

  const counts = Object.keys(sessions).reduce(
    (acc, id) => {
      const state = effectiveState(id)
      if (state === 'working') acc.working++
      else if (state === 'waiting') acc.waiting++
      else if (state === 'idle' || state === 'completed') acc.idle++
      return acc
    },
    { working: 0, waiting: 0, idle: 0 }
  )

  // Active session state for mobile display
  const activeState = activeId ? effectiveState(activeId) || 'idle' : null
  const activeDisplay = ACTIVE_STATE_DISPLAY[activeState || 'idle']

  // Show which machine the active session lives on (remote only).
  const activeSession = activeId ? sessions[activeId] : null
  const activeHostLabel = activeSession && activeSession.host && activeSession.host !== 'local'
    ? (activeSession.hostLabel || activeSession.host)
    : null

  const handleSpawn = () => {
    // Default to the current workspace folder so the user isn't asked to pick one.
    const st = useStore.getState()
    const cwd = st.workspaceCwd || (st.activeId ? st.sessions[st.activeId]?.cwd : undefined) || '~'
    const host = st.workspaceHost
    openSpawn({ cwd, host })
  }

  return (
    <header className="header">
      <div className="header-left">
        <button className="btn btn-icon" onClick={onToggleSidebar} title="Toggle sidebar (Ctrl+B)">
          ☰
        </button>
        <span id="status-dot" className={`status-dot ${connection==='online'?'':'off'}`} title={connection==='online'?'서버 연결됨':'서버 재연결 중'} />
        <span className="logo">AgentBoard</span>
      </div>
      <div className="header-center">
        {counts.working > 0 && <span className="badge badge-working">● {counts.working} Thinking</span>}
        {counts.waiting > 0 && <span className="badge badge-waiting">◆ {counts.waiting} Asking</span>}
        {counts.idle > 0 && <span className="badge badge-idle">○ {counts.idle} Idle</span>}
      </div>
      {activeDisplay && (
        <div className={`header-active-state ${activeDisplay.cls}`}>
          {activeHostLabel && <span className="header-host-label">{activeHostLabel}</span>}
          <span>{activeDisplay.icon}</span> {activeDisplay.label}
        </div>
      )}
      <div className="header-right">
        <button className="btn" title="인앱 브라우저 탭 열기" onClick={()=>useStore.getState().openBrowser()}>◎ 웹</button>
        {canNotify && (
          <button
            className={`btn btn-icon ${notif ? 'notif-on' : ''}`}
            onClick={toggleNotif}
            title={notif ? '알림 켜짐 (클릭해서 끄기)' : '알림 켜기 — 입력 대기/완료 시 푸시'}
          >
            {notif ? '🔔' : '🔕'}
          </button>
        )}
        <button className="btn" onClick={() => setShowScan(true)} title="전체 세션 관리 및 외부 tmux 세션 찾기">세션 관리</button>
        <button className="btn btn-primary" onClick={handleSpawn}>+ New</button>
      </div>

      <SpawnModal open={spawnOpen} onClose={closeSpawn} />
      <ProfileEditor />
      <WorkspaceModal />

      {showScan && <SessionManager onClose={() => setShowScan(false)} />}
    </header>
  )
}
