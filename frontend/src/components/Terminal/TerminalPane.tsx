import { useEffect, useRef, useState } from 'react'
import { useStore, sessionLabel } from '../../store'
import { api } from '../../api'
import { useToasts } from '../../toasts'
import { notifyActive } from '../../ws'
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

export function TerminalPane({ sessionId }: { sessionId?: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const activeId = useStore((s) => sessionId || s.activeId)
  const altScreen = useStore((s) => ((sessionId || s.activeId) ? s.sessions[(sessionId || s.activeId)!]?.altScreen : false))
  const [readability, setReadability] = useState(TM.getReadability)
  const changeReadability = (patch: Partial<ReturnType<typeof TM.getReadability>>) => { TM.setReadability(patch); setReadability(TM.getReadability()) }
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  // Mobile "select text": snapshot the terminal into plain selectable text so
  // the OS's own long-press range-select + copy works (native, no custom copy).
  const [selectText, setSelectText] = useState<string | null>(null)
  const isMobile = window.innerWidth <= 768
  const currentState = useStore(s => activeId ? s.effectiveState(activeId) : null)
  const stateInfo = STATE_DISPLAY[currentState || ''] || STATE_DISPLAY.idle
  // Full-screen apps scroll via the app (PageUp forwarded), so xterm's own
  // scroll state can't tell us — always offer the jump-to-bottom button there.
  const btnVisible = showScrollBtn || !!altScreen

  useEffect(() => {
    if (!activeId || !containerRef.current) return
    TM.open(activeId, containerRef.current)
    TM.reveal(activeId)
    // The terminal element may have been sized for a different container
    // (rotation, split-pane drag, mobile keyboard) before this session was
    // last viewed. Recompute now that it's visible again.
    TM.refit(activeId)
    // Every session switch funnels through here (both layouts mount TerminalPane).
    // Re-assert active so the backend returns a fresh snapshot that fully clears
    // this terminal's old buffer — otherwise switch paths that don't call
    // notifyActive themselves (e.g. kill/remove auto-select) leave stale content.
    if (useStore.getState().activeId === activeId) notifyActive(activeId)
  }, [activeId])

  // Poll scroll state for button visibility
  useEffect(() => {
    const interval = setInterval(() => {
      const id = sessionId || useStore.getState().activeId
      // If a snapshot was held back while the user was scrolled up, apply it
      // now that they're back at the bottom (idle sessions send no further
      // frames, so writeScreen alone can't flush it).
      TM.flushDeferred(id || undefined)
      setShowScrollBtn(TM.isScrolledUp(id || undefined))
    }, 300)
    return () => clearInterval(interval)
  }, [sessionId])

  // Refit on container size changes. Debounced so keyboard show/hide animation
  // (many ResizeObserver fires) collapses into one resize round-trip.
  useEffect(() => {
    let timer: number | undefined
    const doRefit = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        const id = sessionId || useStore.getState().activeId
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
  }, [sessionId])

  // Full scrollback beyond the ~2000-line streamed snapshot. Opens in the viewer
  // as a searchable text tab (desktop split only; the viewer isn't mounted on
  // mobile). Local sessions only — remote would need an agent round-trip.
  const canFullLog = !!activeId && !activeId.includes(':') && window.innerWidth > 768
  const openFullLog = async () => {
    if (!activeId) return
    const res = await api.capture(activeId)
    if (!res || res.ok === false || typeof res.text !== 'string') {
      useToasts.getState().push(res?.error || '로그를 불러오지 못했습니다')
      return
    }
    const state = useStore.getState()
    const title = state.sessions[activeId] ? sessionLabel(state.sessions[activeId], state.titles) : '터미널'
    useStore.getState().openLogTab(activeId, `${title} 로그`, res.text)
  }

  const handleScrollBottom = () => {
    if (!activeId) return
    TM.scrollToBottom(activeId)
    if (altScreen) {
      // App-managed scroll (Claude TUI etc.): jump the app itself to the latest.
      api.key(activeId, 'End')
      for (let i = 0; i < 4; i++) api.key(activeId, 'PageDown')
    }
    setShowScrollBtn(false)
  }

  return (
    <div className="terminal-pane-shell">
      <div className="terminal-toolbar">
        <div className="terminal-font-controls" aria-label="터미널 가독성 설정">
          <button onClick={() => changeReadability({fontSize: readability.fontSize - 1})} disabled={readability.fontSize <= 12} title="터미널 글씨 작게">A−</button>
          <button onClick={() => changeReadability({fontSize: isMobile ? 12 : 15, lineHeight: 1})} title="기본 글씨 크기와 행간으로">{readability.fontSize}px</button>
          <button onClick={() => changeReadability({fontSize: readability.fontSize + 1})} disabled={readability.fontSize >= 22} title="터미널 글씨 크게">A+</button>
          <button aria-pressed={readability.adaptiveColumns} onClick={() => changeReadability({adaptiveColumns: !readability.adaptiveColumns})} title="폭에 맞춰 줄바꿈 / 80열 고정">{readability.adaptiveColumns ? '자동 폭' : '80열'}</button>
        </div>
      {activeId && (
        <div className={`terminal-state-badge tsb-${currentState || 'idle'}`}>
          <span className="state-icon">{stateInfo.icon}</span>
          {stateInfo.label}
        </div>
      )}
      {canFullLog && (
        <button className="full-log-btn" onClick={openFullLog} title="전체 스크롤백을 뷰어에서 열기">
          📜 전체 로그
        </button>
      )}
      {activeId && isMobile && (
        <button className="select-text-btn" onClick={() => setSelectText(TM.getBufferText(activeId))} title="텍스트 선택 (길게 눌러 범위 지정 → 복사)">
          텍스트 선택
        </button>
      )}
      </div>
      <div ref={containerRef} className="terminal-container">
      {selectText !== null && (
        <div className="term-select-overlay">
          <div className="tso-bar">
            <span className="tso-hint">길게 눌러 범위 지정 → 복사</span>
            <button className="tso-close" onClick={() => setSelectText(null)}>✕ 닫기</button>
          </div>
          <pre className="tso-text">{selectText}</pre>
        </div>
      )}
      {btnVisible && (
        <button
          className="scroll-bottom-btn"
          onClick={handleScrollBottom}
          aria-label="맨 아래로"
          title="맨 아래로"
        >
          <span className="sb-arrow">↓</span>
          <span className="sb-text"> 맨아래</span>
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
    </div>
  )
}
