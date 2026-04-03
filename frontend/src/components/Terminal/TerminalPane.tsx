import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../store'
import { send, sendResize } from '../../ws'
import * as TM from './TerminalManager'

import '@xterm/xterm/css/xterm.css'

const STATE_DISPLAY: Record<string, { label: string; icon: string }> = {
  working:   { label: 'Thinking', icon: '●' },
  waiting:   { label: 'Asking',   icon: '◆' },
  completed: { label: 'Done',     icon: '✓' },
  idle:      { label: 'Idle',     icon: '○' },
  stopped:   { label: 'Stopped',  icon: '■' },
}

export function TerminalPane() {
  const containerRef = useRef<HTMLDivElement>(null)
  const activeId = useStore((s) => s.activeId)
  const effectiveState = useStore((s) => s.effectiveState)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const currentState = activeId ? effectiveState(activeId) : null
  const stateInfo = STATE_DISPLAY[currentState || ''] || STATE_DISPLAY.idle

  useEffect(() => {
    if (!activeId || !containerRef.current) return
    TM.open(activeId, containerRef.current)
    TM.show(activeId)
    // Single resize + resync after terminal renders (no repeated snapshots)
    const id = activeId
    const t1 = setTimeout(() => {
      const size = TM.resize(id)
      if (size && size.cols > 0 && size.rows > 0) {
        send({ type: 'resize', id, cols: size.cols, rows: size.rows })
      }
    }, 150)
    return () => { clearTimeout(t1) }
  }, [activeId])

  // Poll scroll state for button visibility
  useEffect(() => {
    const interval = setInterval(() => {
      setShowScrollBtn(TM.isScrolledUp())
    }, 300)
    return () => clearInterval(interval)
  }, [])

  // Refit terminal on container size change
  useEffect(() => {
    const doResize = () => {
      const id = useStore.getState().activeId
      if (!id) return
      requestAnimationFrame(() => {
        const size = TM.resize(id)
        if (size && size.cols > 0 && size.rows > 0) {
          sendResize(id, size.cols, size.rows)
        }
      })
    }
    window.addEventListener('resize', doResize)
    const ro = new ResizeObserver(doResize)
    if (containerRef.current) ro.observe(containerRef.current)
    return () => { window.removeEventListener('resize', doResize); ro.disconnect() }
  }, [])

  const handleScrollBottom = () => {
    if (activeId) TM.scrollToBottom(activeId)
    setShowScrollBtn(false)
  }

  return (
    <div ref={containerRef} className="terminal-container">
      {activeId && (
        <div className={`terminal-state-badge tsb-${currentState || 'idle'}`}>
          <span className="state-icon">{stateInfo.icon}</span>
          {stateInfo.label}
        </div>
      )}
      {showScrollBtn && (
        <button className="scroll-bottom-btn" onClick={handleScrollBottom}>↓ Bottom</button>
      )}
    </div>
  )
}
