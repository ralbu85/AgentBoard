import { useState, useRef } from 'react'
import { useStore } from '../../store'
import { api } from '../../api'
import { send } from '../../ws'

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
  onOpenFiles?: () => void
}

export function SessionList({ onSelect, onOpenFiles }: Props) {
  const sessions = useStore((s) => s.sessions)
  const activeId = useStore((s) => s.activeId)
  const titles = useStore((s) => s.titles)
  const effectiveState = useStore((s) => s.effectiveState)
  const setActive = useStore((s) => s.setActive)
  const removeSession = useStore((s) => s.removeSession)
  const openSpawn = useStore((s) => s.openSpawn)
  const workspaceCwd = useStore((s) => s.workspaceCwd)
  const setWorkspace = useStore((s) => s.setWorkspace)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [groupBy, setGroupBy] = useState<'folder' | 'host'>(
    () => (localStorage.getItem('agentboard.groupBy') as 'folder' | 'host') || 'folder'
  )
  const setGroup = (g: 'folder' | 'host') => { setGroupBy(g); localStorage.setItem('agentboard.groupBy', g) }
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggleCollapse = (key: string) =>
    setCollapsed((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n })
  const editRef = useRef<HTMLInputElement>(null)

  const handleSelect = (id: string) => {
    // Switching sessions: setActive drives TerminalPane's effect, which
    // notifyActive()s and pulls a fresh snapshot. Re-clicking the already-active
    // session doesn't change activeId (no effect), so resync explicitly.
    if (id === activeId) send({ type: 'resync', id })
    setActive(id)
    setWorkspace(sessions[id]?.cwd || '~')  // files panel follows the session's folder
    onSelect?.()
  }

  // Clicking a folder header makes it the active workspace (files panel + new session).
  const selectFolder = (key: string) => {
    if (groupBy !== 'folder') return
    setWorkspace(key)
    setCollapsed((prev) => { const n = new Set(prev); n.delete(key); return n })  // ensure expanded
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

  const handleFiles = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    // Switch to this session first, then open files (effect notifies + snapshots)
    if (id !== activeId) setActive(id)
    setWorkspace(sessions[id]?.cwd || '~')
    onOpenFiles?.()
  }

  const allIds = Object.keys(sessions)
  const q = filter.trim().toLowerCase()
  const ids = q
    ? allIds.filter((id) => {
        const s = sessions[id]
        const title = titles[id] || ''
        const hostLabel = s.hostLabel || s.host || ''
        return (
          title.toLowerCase().includes(q) ||
          s.cmd.toLowerCase().includes(q) ||
          s.cwd.toLowerCase().includes(q) ||
          s.sessionName.toLowerCase().includes(q) ||
          hostLabel.toLowerCase().includes(q) ||
          id.includes(q)
        )
      })
    : allIds

  // Group by folder (cwd) or machine (host). Folder is the default — the user
  // often runs several sessions in one project folder.
  const groups = new Map<string, string[]>()
  for (const id of ids) {
    const s = sessions[id]
    const key = groupBy === 'folder' ? (s.cwd || '~') : (s.host || 'local')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(id)
  }
  const labelOf = (key: string) => {
    if (groupBy === 'host') return key === 'local' ? 'This machine' : (sessions[groups.get(key)![0]].hostLabel || key)
    return key === '~' ? '~' : (key.split('/').pop() || key)
  }
  const orderedKeys = [...groups.keys()].sort((a, b) => {
    if (groupBy === 'host') {
      if (a === 'local') return -1
      if (b === 'local') return 1
    }
    return labelOf(a).localeCompare(labelOf(b))
  })
  const showHeaders = groups.size > 0

  const renderItem = (id: string) => {
    const s = sessions[id]
    const state = effectiveState(id) || 'running'
    const title = titles[id] || `#${id} ${s.cmd}`
    const isActive = id === activeId
    const folder = s.cwd.split('/').pop() || s.cwd
    // In folder mode the group header already names the folder, so showing it on
    // every row is redundant — surface the machine (for remote) instead.
    const contextLabel = groupBy === 'folder'
      ? (s.host && s.host !== 'local' ? (s.hostLabel || s.host) : '')
      : folder

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
            {contextLabel && <span className="session-path">{contextLabel}</span>}
            <span className={`session-state state-${state}`}>{STATE_LABELS[state] || state}</span>
          </div>
        </div>
        {onOpenFiles && s.status !== 'stopped' && s.status !== 'completed' && (
          <button
            className="btn btn-xs session-files-btn"
            onClick={(e) => handleFiles(e, id)}
            title="Browse files"
          >
            <svg width="12" height="12" viewBox="0 0 20 20" fill="none"><path d="M2 5C2 4 3 3 4 3H8L10 5H16C17 5 18 6 18 7V15C18 16 17 17 16 17H4C3 17 2 16 2 15V5Z" stroke="currentColor" strokeWidth="1.5"/></svg>
          </button>
        )}
        <button
          className={`btn btn-xs session-action ${s.status === 'stopped' || s.status === 'completed' ? 'action-remove' : ''}`}
          onClick={(e) => handleAction(e, id, s)}
        >
          {s.status === 'stopped' || s.status === 'completed' ? '✕' : '■'}
        </button>
      </div>
    )
  }

  return (
    <div className="session-list">
      <div className="session-groupby">
        <button className={`sgb-btn ${groupBy === 'folder' ? 'active' : ''}`} onClick={() => setGroup('folder')}>폴더</button>
        <button className={`sgb-btn ${groupBy === 'host' ? 'active' : ''}`} onClick={() => setGroup('host')}>머신</button>
      </div>
      {allIds.length >= 5 && (
        <div className="session-filter-wrap">
          <input
            className="session-filter"
            type="search"
            placeholder={`Filter ${allIds.length} sessions…`}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      )}
      {orderedKeys.map((key) => {
        const groupIds = groups.get(key)!
        const firstHost = sessions[groupIds[0]].host || 'local'
        const isFolder = groupBy === 'folder'
        const isCollapsed = collapsed.has(key)
        // Highlight the selected workspace folder; fall back to the active session's.
        const effectiveWs = workspaceCwd || (activeId ? sessions[activeId]?.cwd : undefined)
        const isWorkspace = isFolder && effectiveWs === key
        return (
          <div className="session-group" key={key}>
            {showHeaders && (
              <div className={`session-group-header ${isWorkspace ? 'active-workspace' : ''}`} title={key}>
                {isFolder && (
                  <span
                    className={`sgh-arrow ${isCollapsed ? '' : 'open'}`}
                    onClick={(e) => { e.stopPropagation(); toggleCollapse(key) }}
                  >▶</span>
                )}
                <span className="sgh-label" onClick={() => selectFolder(key)}>{labelOf(key)}</span>
                <span className="sgh-count">{groupIds.length}</span>
                {isFolder && (
                  <button
                    className="sgh-add"
                    title={`이 폴더에 새 세션: ${key}`}
                    onClick={(e) => { e.stopPropagation(); openSpawn({ cwd: key, host: firstHost }) }}
                  >
                    +
                  </button>
                )}
              </div>
            )}
            {!isCollapsed && groupIds.map(renderItem)}
          </div>
        )
      })}
      {ids.length === 0 && <div className="empty-msg">{q ? 'No matches' : 'No sessions'}</div>}
    </div>
  )
}
