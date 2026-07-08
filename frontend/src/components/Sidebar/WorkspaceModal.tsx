import { useState, useEffect } from 'react'
import { useStore } from '../../store'
import { api } from '../../api'

// Create/open a workspace = pick a FOLDER (browse or type, optionally mkdir).
// Sessions are added later, inside the workspace, via the "+ | ▾" launcher.
export function WorkspaceModal() {
  const open = useStore((s) => s.workspaceModalOpen)
  const close = useStore((s) => s.closeWorkspaceModal)
  const addWorkspaceFolder = useStore((s) => s.addWorkspaceFolder)
  const setWorkspace = useStore((s) => s.setWorkspace)
  const setActive = useStore((s) => s.setActive)
  const sessions = useStore((s) => s.sessions)
  const [path, setPath] = useState('~')
  const [dirs, setDirs] = useState<string[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => { if (open) { setPath('~'); browse('~') } }, [open])
  if (!open) return null

  async function browse(p: string) {
    setLoading(true)
    try {
      const r = await api.browse(p)
      setPath(r.path || p)
      setDirs(Array.isArray(r.dirs) ? r.dirs : [])
    } catch { /* */ }
    setLoading(false)
  }

  const parent = () => browse(path.replace(/\/[^/]+\/?$/, '') || '/')

  const mkdir = async () => {
    const name = window.prompt('새 폴더 이름')?.trim()
    if (!name) return
    await api.mkdir(`${path.replace(/\/$/, '')}/${name}`)
    browse(path)
  }

  const openFolder = () => {
    const cwd = path
    addWorkspaceFolder(cwd)
    setWorkspace(cwd)
    const ids = Object.keys(sessions).filter((id) => (sessions[id].cwd || '~') === cwd)
    setActive(ids[0] || null)  // empty workspace → clear, user adds a session
    close()
  }

  return (
    <div className="spawn-backdrop" onClick={close}>
      <div className="spawn-modal" onClick={(e) => e.stopPropagation()}>
        <div className="spawn-header">
          <span>워크스페이스 폴더 열기</span>
          <button className="btn btn-xs" onClick={close}>&times;</button>
        </div>
        <div className="spawn-body">
          <label className="spawn-label">폴더 경로</label>
          <div className="ws-pathrow">
            <button className="btn btn-xs" onClick={parent} title="상위 폴더">↑</button>
            <input className="spawn-host-select" value={path} spellCheck={false}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') browse(path) }} />
            <button className="btn btn-xs" onClick={() => browse(path)}>이동</button>
          </div>
          <div className="ws-dirlist">
            {loading ? <div className="ws-empty">불러오는 중…</div>
              : dirs.length === 0 ? <div className="ws-empty">하위 폴더 없음</div>
              : dirs.map((d) => (
                <div key={d} className="ws-diritem" onClick={() => browse(`${path.replace(/\/$/, '')}/${d}`)}>
                  <span>📁</span> {d}
                </div>
              ))}
          </div>
          <button className="pe-add" onClick={mkdir}>+ 새 폴더 만들기</button>
        </div>
        <div className="spawn-footer">
          <button className="btn" onClick={close}>취소</button>
          <button className="btn btn-primary" onClick={openFolder}>이 폴더 열기</button>
        </div>
      </div>
    </div>
  )
}
