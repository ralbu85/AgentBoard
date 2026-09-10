import { FolderList } from './FolderList'
interface Props { visible: boolean; onClose?: () => void; width?: number }

export function Sidebar({ visible, onClose, width }: Props) {
  const isMobile = window.innerWidth <= 768
  if (!visible) return null
  return <>
    <div className="sidebar-backdrop" onClick={onClose} />
    <aside className="sidebar workspace-sidebar" aria-label="워크스페이스 현황" style={width && !isMobile ? { width } : undefined}>
      <FolderList onSelect={isMobile ? onClose : undefined} />
    </aside>
  </>
}
