import { useState, useRef } from 'react'
import { useStore } from '../../store'
import { SessionList } from './SessionList'
import { FilePanel } from '../FilePanel'

interface Props {
  visible: boolean
  onClose?: () => void
  width?: number
}

export function Sidebar({ visible, onClose, width }: Props) {
  const [showFiles, setShowFiles] = useState(false)
  const [filePath, setFilePath] = useState('')
  const [fileHeight, setFileHeight] = useState(280)
  const activeId = useStore(s => s.activeId)
  const cwd = useStore(s => activeId ? s.sessions[activeId]?.cwd || '~' : '~')
  const isMobile = window.innerWidth <= 768
  const dragging = useRef(false)

  if (!visible) return null

  const handleOpenFiles = (path: string) => {
    setFilePath(path)
    setShowFiles(true)
  }

  const onResizeStart = (e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    const startY = e.clientY
    const startH = fileHeight
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      const sidebar = document.querySelector('.sidebar') as HTMLElement
      const maxH = sidebar ? sidebar.clientHeight - 80 : 600
      setFileHeight(Math.min(maxH, Math.max(60, startH - (ev.clientY - startY))))
    }
    const onUp = () => {
      dragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  return (
    <>
      <div className="sidebar-backdrop" onClick={onClose} />
      <aside className="sidebar" style={width && !isMobile ? { width } : undefined}>
        <div className="sidebar-section sidebar-sessions">
          <div className="sidebar-section-header">Sessions</div>
          <SessionList
            onSelect={isMobile ? onClose : undefined}
            onOpenFiles={!isMobile ? handleOpenFiles : undefined}
          />
        </div>
        {!isMobile && showFiles && (
          <div className="sidebar-files-section" style={{ height: fileHeight + 32 }}>
            <div className="sidebar-files-resizer" onMouseDown={onResizeStart} />
            <div className="sidebar-files-header">
              <span className="sidebar-files-label">FILES</span>
              <button className="btn btn-xs sidebar-files-close" onClick={() => setShowFiles(false)}>&times;</button>
            </div>
            <div className="sidebar-filepanel" style={{ height: fileHeight }}>
              <FilePanel initialPath={filePath || cwd} onClose={() => setShowFiles(false)} />
            </div>
          </div>
        )}
      </aside>
    </>
  )
}
