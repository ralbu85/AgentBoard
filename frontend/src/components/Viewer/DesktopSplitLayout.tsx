import { useState, useCallback, useEffect } from 'react'
import { useStore } from '../../store'
import { TerminalPane } from '../Terminal/TerminalPane'
import { InputCard } from '../Terminal/InputCard'
import { ViewerPane } from './ViewerPane'
import { PaneResizer } from './PaneResizer'

interface Props {
  activeId: string | null
}

export function DesktopSplitLayout({ activeId }: Props) {
  const [leftWidth, setLeftWidth] = useState(55)
  const hasViewerTabs = useStore(s => (s._viewerState[s.activeId || '']?.tabs || []).length > 0)

  // Refit terminal when viewer appears/disappears
  useEffect(() => {
    const t = setTimeout(() => window.dispatchEvent(new Event('resize')), 50)
    return () => clearTimeout(t)
  }, [hasViewerTabs])

  const onResize = useCallback((dx: number) => {
    setLeftWidth(prev => {
      const el = document.querySelector('.split-layout') as HTMLElement
      if (!el) return prev
      return Math.min(80, Math.max(20, prev + (dx / el.clientWidth) * 100))
    })
  }, [])

  const onResizeEnd = useCallback(() => {
    window.dispatchEvent(new Event('resize'))
  }, [])

  // No viewer tabs → terminal fullscreen
  if (!hasViewerTabs) {
    return (
      <div className="split-layout">
        <div className="pane-terminal" style={{ width: '100%' }}>
          <TerminalPane />
          {activeId && <InputCard sessionId={activeId} />}
        </div>
      </div>
    )
  }

  return (
    <div className="split-layout">
      <div className="pane-terminal" style={{ width: `${leftWidth}%` }}>
        <TerminalPane />
        {activeId && <InputCard sessionId={activeId} />}
      </div>
      <PaneResizer onResize={onResize} onResizeEnd={onResizeEnd} />
      <div className="pane-viewer" style={{ width: `${100 - leftWidth}%` }}>
        <ViewerPane />
      </div>
    </div>
  )
}
