import { FolderList } from './FolderList'

interface Props {
  visible: boolean
  onClose?: () => void
  width?: number
}

// The left column: workspace (folder) navigation only. Sessions and files live
// in the main area now (see TerminalArea).
export function Sidebar({ visible, onClose, width }: Props) {
  const isMobile = window.innerWidth <= 768
  if (!visible) return null

  return (
    <>
      <div className="sidebar-backdrop" onClick={onClose} />
      <aside className="sidebar" style={width && !isMobile ? { width } : undefined}>
        <FolderList onSelect={isMobile ? onClose : undefined} />
      </aside>
    </>
  )
}
