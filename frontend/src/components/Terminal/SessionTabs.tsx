import {AgentIcon} from '../AgentIcon'
import { useState } from 'react'
import { useStore, completionKey, sessionLabel } from '../../store'
import { notifyActive } from '../../ws'
import { CLEAN_TERMINAL, spawnAndFocus } from '../../spawn'
import { SessionStatusBadge } from '../SessionStatusBadge'
import { sessionStatus } from '../../sessionStatus'

// Tabs for the sessions in the current workspace folder + a "+ | ▾" launcher.
// "+" runs the default profile; "▾" opens the profile menu (Claude variants,
// Codex, terminal, custom, edit).
export function SessionTabs({ wsCwd }: { wsCwd: string }) {
  const connection = useStore(s => s.connection)
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
      <div className="session-tabs-scroll" role="tablist" aria-label="터미널 세션">
        {ids.map((id) => {
          const s = sessions[id]
          const status = sessionStatus(s, connection === 'online' ? effectiveState(id) : 'disconnected')
          const title = sessionLabel(s,titles)
          const hostTag = s.host && s.host !== 'local' ? (s.hostLabel || s.host) : ''
          return (
            <div key={id} className={`session-tab ${id === activeId ? 'active' : ''}`}
              role="tab" aria-selected={id===activeId} tabIndex={id===activeId?0:-1}
              aria-label={`${title}, ${status.label}`} title={`${title}${hostTag?` · ${hostTag}`:''} · ${status.label}`} onClick={() => select(id)}
              onKeyDown={e=>{
                if(e.target!==e.currentTarget)return
                if(e.key==='Enter'||e.key===' '){e.preventDefault();select(id)}
                const index=ids.indexOf(id)
                const next=e.key==='ArrowRight'?(index+1)%ids.length:e.key==='ArrowLeft'?(index+ids.length-1)%ids.length:e.key==='Home'?0:e.key==='End'?ids.length-1:-1
                if(next>=0){e.preventDefault();select(ids[next]);(e.currentTarget.parentElement?.children[next] as HTMLElement)?.focus()}
              }}>
              <AgentIcon session={s}/>
              <span className="session-tab-title">{title}</span>
              <SessionStatusBadge status={status} />
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
