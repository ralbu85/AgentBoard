import { useEffect, useRef, useState } from 'react'
import { useStore, sessionLabel } from '../../store'
import { api } from '../../api'
import { useToasts } from '../../toasts'
import { notifyActive } from '../../ws'
import * as TM from './TerminalManager'
import { AgentIcon } from '../AgentIcon'
import {ConversationView} from './ConversationView'
import { SessionStatusBadge } from '../SessionStatusBadge'
import { sessionStatus } from '../../sessionStatus'

import '@xterm/xterm/css/xterm.css'

export function TerminalPane({ sessionId }: { sessionId?: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const activeId = useStore((s) => sessionId || s.activeId)
  const altScreen = useStore((s) => ((sessionId || s.activeId) ? s.sessions[(sessionId || s.activeId)!]?.altScreen : false))
  const [readability, setReadability] = useState(TM.getReadability)
  const changeReadability = (patch: Partial<ReturnType<typeof TM.getReadability>>) => { TM.setReadability(patch); setReadability(TM.getReadability()) }
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const [conversation,setConversation]=useState(false)
  const isMobile = TM.isMobileViewport
  const currentState = useStore(s => activeId ? s.effectiveState(activeId) : null)
  const agentSession = useStore(s => activeId ? s.sessions[activeId] : undefined)
  const stateInfo = sessionStatus(agentSession, currentState)
  // Full-screen apps scroll via the app (PageUp forwarded), so xterm's own
  // scroll state can't tell us — always offer the jump-to-bottom button there.
  const btnVisible = showScrollBtn || !!altScreen

  useEffect(() => {
    if (!activeId || !containerRef.current || conversation) return
    const container=containerRef.current
    TM.mountInto(activeId, container)
    // Every session switch funnels through here (both layouts mount TerminalPane).
    // Re-assert active so the backend returns a fresh snapshot that fully clears
    // this terminal's old buffer — otherwise switch paths that don't call
    // notifyActive themselves (e.g. kill/remove auto-select) leave stale content.
    if (useStore.getState().activeId === activeId) notifyActive(activeId)
    return()=>TM.unmountFrom(activeId,container)
  }, [activeId,conversation])

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
  }, [sessionId,conversation])

  // Refit on container size changes. Debounced so keyboard show/hide animation
  // (many ResizeObserver fires) collapses into one local display resize.
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
  }, [sessionId,conversation])

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
        {activeId&&<div className="terminal-reading-mode" aria-label="출력 보기">
          <button aria-pressed={!conversation} onClick={()=>setConversation(false)}>터미널</button>
          <button aria-pressed={conversation} disabled={agentSession?.host!=='local'&&!!agentSession?.host} onClick={()=>setConversation(true)} title="원본 대화를 화면 폭에 맞춰 읽기">대화</button>
        </div>}
        <div className="terminal-font-controls" aria-label="터미널 가독성 설정">
          <button onClick={() => changeReadability({fontSize: readability.fontSize - 1})} disabled={readability.fontSize <= 12} title="터미널 글씨 작게">A−</button>
          <button onClick={() => changeReadability({fontSize: isMobile ? 12 : 15, lineHeight: 1})} title="기본 글씨 크기와 행간으로">{readability.fontSize}px</button>
          <button onClick={() => changeReadability({fontSize: readability.fontSize + 1})} disabled={readability.fontSize >= 22} title="터미널 글씨 크게">A+</button>
          <span className="terminal-width-mode" title={isMobile?'글씨 크기를 유지하고 긴 출력을 화면 폭에 맞춰 줄바꿈합니다.':'터미널 영역 너비에 따라 열 수를 자동 조절합니다.'}>{isMobile?'자동 줄바꿈':'자동 폭'}</span>
        </div>
      {activeId && (
        <div className="terminal-session-status">
          <AgentIcon session={agentSession} />
          <SessionStatusBadge status={stateInfo} />
        </div>
      )}
      {canFullLog && (
        <button className="full-log-btn" onClick={openFullLog} title="전체 스크롤백을 뷰어에서 열기">
          📜 전체 로그
        </button>
      )}
      {activeId && !isMobile && <button className="select-text-btn" onMouseDown={e=>e.preventDefault()} onClick={()=>void TM.copySelection(activeId)} title="선택한 텍스트 복사 (Ctrl+C / Cmd+C)">선택 복사</button>}
      </div>
      {conversation&&activeId?<ConversationView key={activeId} sessionId={activeId}/>:<div ref={containerRef} className="terminal-container">
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
      </div>}
    </div>
  )
}
