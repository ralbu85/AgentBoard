import { useStore } from '../../store'
import { FilePanel } from '../FilePanel'

export function ExplorerColumn({ width, onClose }: { width: number; onClose: () => void }) {
  const cwd = useStore(s => s.workspaceCwd)
  const host = useStore(s => s.workspaceHost)
  const open = useStore(s => s.openWorkspaceModal)
  const name = cwd?.split('/').filter(Boolean).pop() || cwd || '파일 탐색기'
  return <aside className="explorer-column" style={{ width }} aria-label="선택한 워크스페이스 파일">
    <div className="explorer-column-heading">
      <strong>{name}</strong><small title={cwd || ''}>{host}{cwd && ` · ${cwd}`}</small>
    </div>
    {cwd ? host === 'local'
      ? <div className="sidebar-explorer"><FilePanel key={`${host}:${cwd}`} initialPath={cwd} onClose={onClose} /></div>
      : <p className="folder-empty">원격 파일 탐색은 아직 지원하지 않습니다.<br />선택한 머신: {host}</p>
      : <div className="workspace-sidebar-empty"><p>워크스페이스를 선택해 주세요.</p><button className="btn" onClick={open}>폴더 열기</button></div>}
  </aside>
}
