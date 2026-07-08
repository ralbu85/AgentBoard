import { useState } from 'react'
import { useStore } from '../../store'

// Left navigation: a clean list of workspace folders. Sessions live in the main
// area (as tabs/grid), not here — this column has one job: pick a folder.
interface Props {
  onSelect?: () => void
}

const ATTENTION = new Set(['waiting'])

export function FolderList({ onSelect }: Props) {
  const sessions = useStore((s) => s.sessions)
  const activeId = useStore((s) => s.activeId)
  const workspaceCwd = useStore((s) => s.workspaceCwd)
  const effectiveState = useStore((s) => s.effectiveState)
  const setActive = useStore((s) => s.setActive)
  const setWorkspace = useStore((s) => s.setWorkspace)
  const openWorkspaceModal = useStore((s) => s.openWorkspaceModal)
  const workspaceFolders = useStore((s) => s.workspaceFolders)
  const [filter, setFilter] = useState('')

  // Workspaces = folders with sessions ∪ explicitly-registered folders (so a
  // just-created, still-empty workspace still shows).
  const folders = new Map<string, string[]>()
  for (const f of workspaceFolders) if (!folders.has(f)) folders.set(f, [])
  for (const id of Object.keys(sessions)) {
    const cwd = sessions[id].cwd || '~'
    if (!folders.has(cwd)) folders.set(cwd, [])
    folders.get(cwd)!.push(id)
  }

  const q = filter.trim().toLowerCase()
  const keys = [...folders.keys()]
    .filter((k) => !q || k.toLowerCase().includes(q))
    .sort((a, b) => (a.split('/').pop() || a).localeCompare(b.split('/').pop() || b))

  const effWorkspace = workspaceCwd || (activeId ? sessions[activeId]?.cwd : undefined)

  const selectFolder = (cwd: string) => {
    setWorkspace(cwd)
    const ids = folders.get(cwd) || []
    if (ids.length === 0) {
      setActive(null)  // empty workspace — main shows the "+ 세션 추가" prompt
    } else if (!ids.includes(activeId || '')) {
      const running = ids.find((id) => sessions[id].status === 'running') || ids[0]
      setActive(running)
    }
    onSelect?.()
  }

  return (
    <div className="folder-list">
      <div className="folder-list-head">
        <span className="fl-title">WORKSPACES</span>
        <button className="fl-add" title="워크스페이스 폴더 열기" onClick={openWorkspaceModal}>＋</button>
      </div>
      {folders.size >= 6 && (
        <div className="folder-filter-wrap">
          <input className="folder-filter" type="search" placeholder="폴더 검색…"
            value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      )}
      {keys.map((cwd) => {
        const ids = folders.get(cwd)!
        const name = cwd === '~' ? '~' : (cwd.split('/').filter(Boolean).pop() || cwd)
        const isActive = effWorkspace === cwd
        const running = ids.filter((id) => sessions[id].status === 'running').length
        const attention = ids.some((id) => ATTENTION.has(effectiveState(id) || ''))
        const s0 = ids.length ? sessions[ids[0]] : null
        const remote = s0 && s0.host && s0.host !== 'local' ? (s0.hostLabel || s0.host) : ''
        return (
          <div key={cwd} className={`folder-item ${isActive ? 'active' : ''}`}
            title={cwd} onClick={() => selectFolder(cwd)}>
            <span className={`folder-attn ${attention ? 'on' : ''}`} />
            <svg className="folder-ico" width="15" height="15" viewBox="0 0 20 20" fill="none">
              <path d="M2 5C2 4 3 3 4 3H8L10 5H16C17 5 18 6 18 7V15C18 16 17 17 16 17H4C3 17 2 16 2 15V5Z"
                fill={isActive ? 'var(--accent)' : 'none'} opacity={isActive ? '0.25' : '1'}
                stroke="currentColor" strokeWidth="1.4" />
            </svg>
            <span className="folder-name">{name}</span>
            {remote && <span className="folder-host">{remote}</span>}
            <span className="folder-count">{running}</span>
          </div>
        )
      })}
      {keys.length === 0 && (
        <div className="folder-empty">
          <p>워크스페이스가 없습니다</p>
          <button className="btn btn-primary btn-xs" onClick={openWorkspaceModal}>+ 워크스페이스 열기</button>
        </div>
      )}
    </div>
  )
}
