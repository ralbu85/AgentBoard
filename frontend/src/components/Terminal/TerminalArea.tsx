import { useState, useRef } from 'react'
import { useStore } from '../../store'
import { TerminalPane } from './TerminalPane'
import { InputCard } from './InputCard'
import { SessionGrid } from './SessionGrid'
import { SessionTabs } from './SessionTabs'
import { FilePanel } from '../FilePanel'

// The workspace: the selected folder's sessions (tabs → single/grid terminals)
// plus that folder's files. The left sidebar only picks the folder.
export function TerminalArea() {
  const viewMode = useStore((s) => s.viewMode)
  const setViewMode = useStore((s) => s.setViewMode)
  const activeId = useStore((s) => s.activeId)
  const workspaceCwd = useStore((s) => s.workspaceCwd)
  const sessions = useStore((s) => s.sessions)
  const activeCwd = useStore((s) => (activeId ? s.sessions[activeId]?.cwd : undefined))
  const wsCwd = workspaceCwd || activeCwd || '~'
  const hasSessions = Object.values(sessions).some((s) => (s.cwd || '~') === wsCwd)

  const [showFiles, setShowFiles] = useState(false)
  const [fileHeight, setFileHeight] = useState(260)
  const dragging = useRef(false)

  const onResizeStart = (e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    const startY = e.clientY
    const startH = fileHeight
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      const area = document.querySelector('.terminal-area') as HTMLElement
      const maxH = area ? area.clientHeight - 120 : 600
      setFileHeight(Math.min(maxH, Math.max(80, startH - (ev.clientY - startY))))
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
    <div className="terminal-area">
      <div className="workspace-bar">
        <SessionTabs wsCwd={wsCwd} />
        <div className="wb-actions">
          <div className="wb-toggle">
            <button className={viewMode === 'single' ? 'active' : ''} onClick={() => setViewMode('single')} title="단일 보기">▢</button>
            <button className={viewMode === 'grid' ? 'active' : ''} onClick={() => setViewMode('grid')} title="격자 보기">▦</button>
          </div>
          <button className={`wb-files-btn ${showFiles ? 'active' : ''}`} onClick={() => setShowFiles((v) => !v)} title="파일 패널">
            📄 파일
          </button>
        </div>
      </div>

      <div className="workspace-body">
        {!hasSessions ? (
          <div className="ws-empty-main">
            <p>이 워크스페이스에 세션이 없습니다.</p>
            <p>위 <b>＋</b> 버튼으로 에이전트 세션을 추가하세요.</p>
          </div>
        ) : viewMode === 'grid' ? (
          <SessionGrid />
        ) : (
          <TerminalPane />
        )}
      </div>
      {/* Input stays available in both views — it targets the active session. */}
      {hasSessions && activeId && <InputCard sessionId={activeId} />}

      {showFiles && (
        <div className="workspace-files" style={{ height: fileHeight }}>
          <div className="workspace-files-resizer" onMouseDown={onResizeStart} />
          <FilePanel key={wsCwd} initialPath={wsCwd} onClose={() => setShowFiles(false)} />
        </div>
      )}
    </div>
  )
}
