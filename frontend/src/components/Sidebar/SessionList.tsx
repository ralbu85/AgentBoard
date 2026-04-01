import { useState, useRef } from 'react'
import { useStore } from '../../store'
import { api } from '../../api'
import { notifyActive, send } from '../../ws'

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

interface Props {
  onSelect?: () => void
  onOpenFiles?: (cwd: string) => void
}

export function SessionList({ onSelect, onOpenFiles }: Props) {
  const sessions = useStore((s) => s.sessions)
  const activeId = useStore((s) => s.activeId)
  const titles = useStore((s) => s.titles)
  const effectiveState = useStore((s) => s.effectiveState)
  const setActive = useStore((s) => s.setActive)
  const removeSession = useStore((s) => s.removeSession)
  const [editingId, setEditingId] = useState<string | null>(null)
  const editRef = useRef<HTMLInputElement>(null)

  const handleSelect = (id: string) => {
    setActive(id)
    notifyActive(id)
    onSelect?.()
  }

  const startEdit = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    setEditingId(id)
    setTimeout(() => editRef.current?.select(), 50)
  }

  const saveTitle = (id: string, val: string) => {
    const trimmed = val.trim()
    if (trimmed) send({ type: 'title', id, title: trimmed })
    setEditingId(null)
  }

  const handleAction = async (e: React.MouseEvent, id: string, s: { status: string }) => {
    e.stopPropagation()
    if (s.status === 'stopped' || s.status === 'completed') {
      await api.remove(id)
      removeSession(id)
    } else {
      await api.kill(id)
    }
  }

  const handleFiles = (e: React.MouseEvent, cwd: string) => {
    e.stopPropagation()
    onOpenFiles?.(cwd)
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
              {editingId === id ? (
                <input ref={editRef} className="session-title-input" defaultValue={title}
                  onBlur={e => saveTitle(id, e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') saveTitle(id, (e.target as HTMLInputElement).value); if (e.key === 'Escape') setEditingId(null) }}
                  onClick={e => e.stopPropagation()}
                  autoFocus
                />
              ) : (
                <div className="session-title" onDoubleClick={e => startEdit(e, id)}>{title}</div>
              )}
              <div className="session-meta">
                <span className="session-path">{folder}</span>
                <span className={`session-state state-${state}`}>{STATE_LABELS[state] || state}</span>
              </div>
            </div>
            {onOpenFiles && s.status !== 'stopped' && s.status !== 'completed' && (
              <button
                className="btn btn-xs session-files-btn"
                onClick={(e) => handleFiles(e, s.cwd)}
                title="Browse files"
              >
                <svg width="12" height="12" viewBox="0 0 20 20" fill="none"><path d="M2 5C2 4 3 3 4 3H8L10 5H16C17 5 18 6 18 7V15C18 16 17 17 16 17H4C3 17 2 16 2 15V5Z" stroke="currentColor" strokeWidth="1.5"/></svg>
              </button>
            )}
            <button
              className={`btn btn-xs session-action ${s.status === 'stopped' || s.status === 'completed' ? 'action-remove' : ''}`}
              onClick={(e) => handleAction(e, id, s)}
            >
              {s.status === 'stopped' || s.status === 'completed' ? '\u2715' : '\u25A0'}
            </button>
          </div>
        )
      })}
      {ids.length === 0 && <div className="empty-msg">No sessions</div>}
    </div>
  )
}
