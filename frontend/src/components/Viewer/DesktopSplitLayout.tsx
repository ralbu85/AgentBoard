import { useState, useCallback, useEffect } from 'react'
import { useStore, viewerKey } from '../../store'
import { TerminalArea } from '../Terminal/TerminalArea'
import { ViewerPane } from './ViewerPane'
import { PaneResizer } from './PaneResizer'

export function DesktopSplitLayout() {
  const [leftWidth, setLeftWidth] = useState(55)
  const hasViewerTabs = useStore(s => (s._viewerState[viewerKey(s)]?.tabs.length || 0) > 0)

  const hasSessions = useStore(s => Object.values(s.sessions).some(session =>
    JSON.stringify([session.host || 'local', session.cwd || '~']) === viewerKey(s)))

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
    // Only trigger height refit, not width resize — prevents garbled wide content
    window.dispatchEvent(new Event('resize'))
  }, [])

  // Empty workspaces are useful for reading/editing without an agent.
  if (hasViewerTabs && !hasSessions) {
    return <div className="split-layout"><div className="pane-viewer" style={{ width: '100%' }}><ViewerPane /></div></div>
  }

  // No viewer tabs → terminal fullscreen
  if (!hasViewerTabs) {
    return (
      <div className="split-layout">
        <div className="pane-terminal" style={{ width: '100%' }}>
          <TerminalArea />
        </div>
      </div>
    )
  }

  return (
    <div className="split-layout">
      <div className="pane-terminal" style={{ width: `${leftWidth}%` }}>
        <TerminalArea />
      </div>
      <PaneResizer onResize={onResize} onResizeEnd={onResizeEnd} />
      <div className="pane-viewer" style={{ width: `${100 - leftWidth}%` }}>
        <ViewerPane />
      </div>
    </div>
  )
}
