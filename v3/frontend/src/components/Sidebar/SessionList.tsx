import { useStore } from '../../store'
import { api } from '../../api'
import { notifyActive } from '../../ws'

const STATE_COLORS: Record<string, string> = {
  working: '#a78bfa',
  waiting: '#fbbf24',
  idle: '#6e7681',
  completed: '#34d399',
  stopped: '#f87171',
  running: '#6e7681',
}

const STATE_LABELS: Record<string, string> = {
  working: 'Thinking',
  waiting: 'Asking',
  completed: 'Done',
  idle: 'Idle',
  stopped: 'Stopped',
  running: 'Idle',
}

export function SessionList({ onSelect }: { onSelect?: () => void } = {}) {
  const sessions = useStore((s) => s.sessions)
  const activeId = useStore((s) => s.activeId)
  const titles = useStore((s) => s.titles)
  const effectiveState = useStore((s) => s.effectiveState)
  const setActive = useStore((s) => s.setActive)

  const handleSelect = (id: string) => {
    setActive(id)
    notifyActive(id)
    onSelect?.()
  }

  const removeSession = useStore((s) => s.removeSession)

  const handleAction = async (e: React.MouseEvent, id: string, s: { status: string }) => {
    e.stopPropagation()
    if (s.status === 'stopped' || s.status === 'completed') {
      await api.remove(id)
      removeSession(id)
    } else {
      await api.kill(id)
    }
  }

  const ids = Object.keys(sessions)

  return (
    <div className="session-list">
      {ids.map((id) => {
        const s = sessions[id]
        const state = effectiveState(id) || 'running'
        const title = titles[id] || `#${id} ${s.cmd}`
        const isActive = id === activeId
        const folder = s.cwd.split('/').pop() || s.cwd

        return (
          <div
            key={id}
            className={`session-item ${isActive ? 'active' : ''}`}
            onClick={() => handleSelect(id)}
          >
            <span className={`session-dot dot-${state}`} style={{ background: STATE_COLORS[state] || '#6e7681' }} />
            <div className="session-info">
              <div className="session-title">{title}</div>
              <div className="session-meta">
                <span className="session-path">{folder}</span>
                <span className={`session-state state-${state}`}>{STATE_LABELS[state] || state}</span>
              </div>
            </div>
            <button
              className={`btn btn-xs session-action ${s.status === 'stopped' || s.status === 'completed' ? 'action-remove' : ''}`}
              onClick={(e) => handleAction(e, id, s)}
            >
              {s.status === 'stopped' || s.status === 'completed' ? '✕' : '■'}
            </button>
          </div>
        )
      })}
      {ids.length === 0 && <div className="empty-msg">No sessions</div>}
    </div>
  )
}
