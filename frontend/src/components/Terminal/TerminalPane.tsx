import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../store'
import { api } from '../../api'
import * as TM from './TerminalManager'

import '@xterm/xterm/css/xterm.css'

// Quick responses for a session that's waiting on a prompt. Claude Code prompts
// are usually a numbered menu (1 = affirmative) confirmed with Enter, cancelled
// with Esc — so these cover the common cases without opening the terminal.
const QUICK_KEYS: { label: string; key: string; cls?: string }[] = [
  { label: 'Yes ⏎', key: 'Enter', cls: 'qa-yes' },
  { label: '1', key: '1' },
  { label: '2', key: '2' },
  { label: '3', key: '3' },
  { label: 'No (Esc)', key: 'Escape', cls: 'qa-no' },
]

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
    // The terminal element may have been sized for a different container
    // (rotation, split-pane drag, mobile keyboard) before this session was
    // last viewed. Recompute now that it's visible again.
    TM.refit(activeId)
  }, [activeId])

  // Poll scroll state for button visibility
  useEffect(() => {
    const interval = setInterval(() => {
      const id = useStore.getState().activeId
      setShowScrollBtn(TM.isScrolledUp(id || undefined))
    }, 300)
    return () => clearInterval(interval)
  }, [])

  // Refit on container size changes. Debounced so keyboard show/hide animation
  // (many ResizeObserver fires) collapses into one resize round-trip.
  useEffect(() => {
    let timer: number | undefined
    const doRefit = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        const id = useStore.getState().activeId
        if (id) TM.refit(id)
      }, 150)
    }
    window.addEventListener('resize', doRefit)
    const ro = new ResizeObserver(doRefit)
    if (containerRef.current) ro.observe(containerRef.current)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('resize', doRefit)
      ro.disconnect()
    }
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
        <button
          className="scroll-bottom-btn"
          onClick={handleScrollBottom}
          aria-label="Scroll to bottom"
        >
          <span className="sb-arrow">↓</span>
          <span className="sb-text"> Bottom</span>
        </button>
      )}
      {activeId && currentState === 'waiting' && (
        <div className="quick-approve">
          <span className="qa-label">◆ 입력 대기 중</span>
          {QUICK_KEYS.map((k) => (
            <button
              key={k.key}
              className={`btn btn-xs qa-btn ${k.cls || ''}`}
              onClick={() => api.key(activeId, k.key)}
            >
              {k.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
