import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../store'
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
  }, [activeId])

  // Poll scroll state for button visibility
  useEffect(() => {
    const interval = setInterval(() => {
      const id = useStore.getState().activeId
      setShowScrollBtn(TM.isScrolledUp(id || undefined))
    }, 300)
    return () => clearInterval(interval)
  }, [])

  // Re-scale font when container size changes (window resize, sidebar toggle, split drag…)
  useEffect(() => {
    const doRefit = () => {
      const id = useStore.getState().activeId
      if (id) requestAnimationFrame(() => TM.refit(id))
    }
    window.addEventListener('resize', doRefit)
    const ro = new ResizeObserver(doRefit)
    if (containerRef.current) ro.observe(containerRef.current)
    return () => { window.removeEventListener('resize', doRefit); ro.disconnect() }
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
