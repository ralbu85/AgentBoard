import { useState } from 'react'
import { useStore } from '../../store'
import { api } from '../../api'
import { notifyActive } from '../../ws'
import { spawnAndFocus } from '../../spawn'

const STATE_COLORS: Record<string, string> = {
  working: '#a78bfa', waiting: '#fbbf24', idle: '#6e7681',
  completed: '#34d399', stopped: '#f87171', running: '#6e7681',
}

// Tabs for the sessions in the current workspace folder + a "+ | ▾" launcher.
// "+" runs the default profile; "▾" opens the profile menu (Claude variants,
// Codex, terminal, custom, edit).
export function SessionTabs({ wsCwd }: { wsCwd: string }) {
  const sessions = useStore((s) => s.sessions)
  const titles = useStore((s) => s.titles)
  const activeId = useStore((s) => s.activeId)
  const effectiveState = useStore((s) => s.effectiveState)
  const setActive = useStore((s) => s.setActive)
  const setWorkspace = useStore((s) => s.setWorkspace)
  const removeSession = useStore((s) => s.removeSession)
  const openSpawn = useStore((s) => s.openSpawn)
  const openProfileEditor = useStore((s) => s.openProfileEditor)
  const profiles = useStore((s) => s.profiles)
  const [menuOpen, setMenuOpen] = useState(false)

  const ids = Object.keys(sessions).filter((id) => (sessions[id].cwd || '~') === wsCwd)
  const host = ids.length ? (sessions[ids[0]].host || 'local') : 'local'
  const defaultProfile = profiles.find((p) => p.default) || profiles[0]

  const select = (id: string) => { setActive(id); setWorkspace(sessions[id]?.cwd || wsCwd); notifyActive(id) }
  const launch = (command: string) => { setMenuOpen(false); spawnAndFocus(wsCwd, host, command) }
  const addDefault = () => launch(defaultProfile?.command || 'claude')

  const close = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    const s = sessions[id]
    if (s.status === 'stopped' || s.status === 'completed') {
      await api.remove(id); removeSession(id)
    } else {
      await api.kill(id)
    }
  }

  return (
    <div className="session-tabs">
      <div className="session-tabs-scroll">
        {ids.map((id) => {
          const s = sessions[id]
          const state = effectiveState(id) || 'running'
          const title = titles[id] || `#${id} ${s.cmd}`
          const hostTag = s.host && s.host !== 'local' ? (s.hostLabel || s.host) : ''
          return (
            <div key={id} className={`session-tab ${id === activeId ? 'active' : ''}`}
              title={hostTag ? `${title} · ${hostTag}` : title} onClick={() => select(id)}>
              <span className={`session-dot dot-${state}`} style={{ background: STATE_COLORS[state] || '#6e7681' }} />
              <span className="session-tab-title">{title}</span>
              <button className="session-tab-close" onClick={(e) => close(e, id)} title="닫기">✕</button>
            </div>
          )
        })}
      </div>

      <div className="session-tab-addwrap">
        <button className="session-tab-add-main" title={`새 세션: ${defaultProfile?.label || 'Claude'}`} onClick={addDefault}>＋</button>
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
