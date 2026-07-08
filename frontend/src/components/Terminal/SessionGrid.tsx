import { useEffect, useRef } from 'react'
import { useStore } from '../../store'
import { notifyActive, send } from '../../ws'
import * as TM from './TerminalManager'
import '@xterm/xterm/css/xterm.css'

const STATE_COLORS: Record<string, string> = {
  working: '#a78bfa', waiting: '#fbbf24', idle: '#6e7681',
  completed: '#34d399', stopped: '#f87171', running: '#6e7681',
}
const STATE_LABELS: Record<string, string> = {
  working: 'Thinking', waiting: 'Asking', completed: 'Done',
  idle: 'Idle', stopped: 'Stopped', running: 'Idle',
}

function GridTile({ id }: { id: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const s = useStore((st) => st.sessions[id])
  const rawTitle = useStore((st) => st.titles[id])
  const state = useStore((st) => st.effectiveState(id)) || 'running'
  const activeId = useStore((st) => st.activeId)
  const setActive = useStore((st) => st.setActive)
  const isActive = activeId === id
  const title = rawTitle || `#${id} ${s?.cmd || ''}`

  useEffect(() => {
    const el = ref.current
    if (!el) return
    TM.mountInto(id, el)
    send({ type: 'resync', id })
    const t = setTimeout(() => TM.refit(id), 130)
    return () => clearTimeout(t)
  }, [id])

  const focus = () => { setActive(id); notifyActive(id) }

  return (
    <div className={`grid-tile ${isActive ? 'active' : ''}`} onClick={focus}>
      <div className="grid-tile-bar">
        <span className={`session-dot dot-${state}`} style={{ background: STATE_COLORS[state] || '#6e7681' }} />
        <span className="grid-tile-title">{title}</span>
        <span className={`session-state state-${state}`}>{STATE_LABELS[state] || state}</span>
      </div>
      <div className="grid-tile-term" ref={ref} />
    </div>
  )
}

export function SessionGrid() {
  const sessions = useStore((s) => s.sessions)
  const workspaceCwd = useStore((s) => s.workspaceCwd)
  const activeId = useStore((s) => s.activeId)
  const activeCwd = activeId ? sessions[activeId]?.cwd : undefined
  const wsCwd = workspaceCwd || activeCwd || '~'

  const ids = Object.keys(sessions).filter((id) => {
    const s = sessions[id]
    return s.cwd === wsCwd && s.status !== 'stopped' && s.status !== 'completed'
  })
  const key = ids.join(',')

  // Keep the focused session live; refresh the other tiles on an interval so the
  // whole folder updates without needing every tile to fast-poll.
  useEffect(() => {
    if (activeId && ids.includes(activeId)) notifyActive(activeId)
    const t = setInterval(() => {
      const cur = useStore.getState().activeId
      for (const id of ids) if (id !== cur) send({ type: 'resync', id })
    }, 1500)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, activeId])

  useEffect(() => {
    const onResize = () => ids.forEach((id) => TM.refit(id))
    const t = setTimeout(onResize, 130)
    window.addEventListener('resize', onResize)
    return () => { clearTimeout(t); window.removeEventListener('resize', onResize) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  if (ids.length === 0) {
    return <div className="grid-empty">이 폴더에 실행 중인 세션이 없습니다</div>
  }

  const cols = ids.length === 1 ? 1 : 2
  return (
    <div className="session-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {ids.map((id) => <GridTile key={id} id={id} />)}
    </div>
  )
}
