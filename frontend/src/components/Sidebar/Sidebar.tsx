import { useState } from 'react'
import { FolderList } from './FolderList'
import { FilePanel } from '../FilePanel'
import { useStore } from '../../store'

interface Props { visible: boolean; onClose?: () => void; width?: number }

export function Sidebar({ visible, onClose, width }: Props) {
  const isMobile = window.innerWidth <= 768
  const cwd = useStore(s => s.workspaceCwd || (s.activeId ? s.sessions[s.activeId]?.cwd : undefined) || '~')
  const host = useStore(s => s.workspaceHost)
  const [filesOpen, setFilesOpen] = useState(true)
  if (!visible) return null
  return (
    <>
      <div className="sidebar-backdrop" onClick={onClose} />
      <aside className="sidebar" style={width && !isMobile ? { width } : undefined}>
        <div className={`workspace-navigation ${!isMobile && filesOpen ? 'with-explorer' : ''}`}>
          <FolderList onSelect={isMobile ? onClose : undefined} />
        </div>
        {!isMobile && (filesOpen ? (
          <div className="sidebar-explorer">
            {host === 'local'
              ? <FilePanel key={`${host}:${cwd}`} initialPath={cwd} onClose={() => setFilesOpen(false)} />
              : <p className="folder-empty">원격 파일 탐색은 아직 지원하지 않습니다.<br />선택한 머신: {host}</p>}
          </div>
        ) : <button className="sidebar-files-reopen" onClick={() => setFilesOpen(true)}>파일 탐색기 열기</button>)}
      </aside>
    </>
  )
}
