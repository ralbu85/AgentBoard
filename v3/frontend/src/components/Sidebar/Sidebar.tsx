import { SessionList } from './SessionList'

interface Props {
  visible: boolean
  onClose?: () => void
}

export function Sidebar({ visible, onClose }: Props) {
  if (!visible) return null

  const isMobile = window.innerWidth <= 768

  return (
    <>
      <div className="sidebar-backdrop" onClick={onClose} />
      <aside className="sidebar">
        <div className="sidebar-section">
          <div className="sidebar-section-header">Sessions</div>
          <SessionList onSelect={isMobile ? onClose : undefined} />
        </div>
      </aside>
    </>
  )
}
