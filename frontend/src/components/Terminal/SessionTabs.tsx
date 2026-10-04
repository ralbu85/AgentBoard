import {AgentIcon} from '../AgentIcon'
import { useState } from 'react'
import { useStore, completionKey, sessionLabel } from '../../store'
import { notifyActive } from '../../ws'
import { CLEAN_TERMINAL, spawnAndFocus } from '../../spawn'

const STATE_COLORS: Record<string, string> = {
  working: '#a78bfa', waiting: '#fbbf24', idle: '#6e7681',
  completed: '#34d399', stopped: '#f87171', running: '#6e7681',
}

// Tabs for the sessions in the current workspace folder + a "+ | ▾" launcher.
// "+" runs the default profile; "▾" opens the profile menu (Claude variants,
// Codex, terminal, custom, edit).
export function SessionTabs({ wsCwd }: { wsCwd: string }) {
  const unreadCompletions = useStore(s => s.unreadCompletions)
  const sessions = useStore((s) => s.sessions)
  const titles = useStore((s) => s.titles)
  const activeId = useStore((s) => s.activeId)
  const effectiveState = useStore((s) => s.effectiveState)
  const setActive = useStore((s) => s.setActive)
  const setWorkspace = useStore((s) => s.setWorkspace)
  const openSpawn = useStore((s) => s.openSpawn)
  const openProfileEditor = useStore((s) => s.openProfileEditor)
  const profiles = useStore((s) => s.profiles)
  const [menuOpen, setMenuOpen] = useState(false)

  const workspaceHost = useStore(s => s.workspaceHost)
  const hiddenSessions=useStore(s=>s.hiddenSessions)
  const ids = Object.keys(sessions).filter((id) => (sessions[id].cwd || '~') === wsCwd && (sessions[id].host || 'local') === workspaceHost && !hiddenSessions.includes(completionKey(sessions[id])))
  const host = workspaceHost

  const select = (id: string) => { setActive(id); useStore.getState().acknowledgeCompletion(id); setWorkspace(sessions[id]?.cwd || wsCwd, sessions[id]?.host || 'local'); notifyActive(id) }
  const launch = (command: string) => { setMenuOpen(false); spawnAndFocus(wsCwd, host, command) }
  const addDefault = () => launch(CLEAN_TERMINAL)

  const close = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    useStore.getState().setSessionHidden(id,true)
  }

  return (
    <div className="session-tabs">
      <div className="session-tabs-scroll">
        {ids.map((id) => {
          const s = sessions[id]
          const unread = unreadCompletions.includes(completionKey(s))
          const state = effectiveState(id) || 'running'
          const title = sessionLabel(s,titles)
          const hostTag = s.host && s.host !== 'local' ? (s.hostLabel || s.host) : ''
          return (
            <div key={id} className={`session-tab ${id === activeId ? 'active' : ''} ${unread ? 'has-unread' : ''}`}
              title={hostTag ? `${title} · ${hostTag}` : title} onClick={() => select(id)}>
              <span className={`session-dot dot-${state}`} style={{ background: STATE_COLORS[state] || '#6e7681' }} />
              <AgentIcon session={s}/>
              <span className="session-tab-title">{title}</span>
              {unread && <span className="unread-chip" title="완료 후 미확인">✓ 미확인</span>}
              <button className="session-tab-close" onClick={(e) => close(e, id)} title="탭 닫기 (기기 간 동기화)">✕</button>
            </div>
          )
        })}
      </div>

      <div className="session-tab-addwrap">
        <button className="session-tab-add-main" title="새 일반 터미널" onClick={addDefault}>＋</button>
        <button className="session-tab-add-caret" title="에이전트 선택" onClick={() => setMenuOpen((v) => !v)}>▾</button>
        {menuOpen && (
          <>
            <div className="tab-add-backdrop" onClick={() => setMenuOpen(false)} />
            <div className="tab-add-menu">
              {profiles.map((p) => (
                <button key={p.id} onClick={() => launch(p.command)}>
                  <span className="taa-icon">{p.icon || '›'}</span> {p.label}
                </button>
              ))}
              <div className="taa-sep" />
              <button onClick={() => { setMenuOpen(false); openSpawn({ cwd: wsCwd, host }) }}>
                <span className="taa-icon">⌨</span> 사용자 지정…
              </button>
              <button onClick={() => { setMenuOpen(false); openProfileEditor() }}>
                <span className="taa-icon">⚙</span> 프로필 편집…
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
