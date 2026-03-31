import { useStore } from '../store'
import { api } from '../api'

interface Props {
  onToggleSidebar: () => void
}

export function Header({ onToggleSidebar }: Props) {
  const sessions = useStore((s) => s.sessions)
  const effectiveState = useStore((s) => s.effectiveState)

  const counts = Object.keys(sessions).reduce(
    (acc, id) => {
      const state = effectiveState(id)
      if (state === 'working') acc.working++
      else if (state === 'waiting') acc.waiting++
      else if (state === 'idle' || state === 'completed') acc.idle++
      return acc
    },
    { working: 0, waiting: 0, idle: 0 }
  )

  const handleSpawn = async () => {
    await api.spawn('~')
  }

  return (
    <header className="header">
      <div className="header-left">
        <button className="btn btn-icon" onClick={onToggleSidebar} title="Toggle sidebar (Ctrl+B)">
          ☰
        </button>
        <span id="status-dot" className="status-dot" />
        <span className="logo">TermHub</span>
      </div>
      <div className="header-center">
        {counts.working > 0 && <span className="badge badge-working">● {counts.working} Thinking</span>}
        {counts.waiting > 0 && <span className="badge badge-waiting">◆ {counts.waiting} Asking</span>}
        {counts.idle > 0 && <span className="badge badge-idle">○ {counts.idle} Idle</span>}
      </div>
      <div className="header-right">
        <button className="btn btn-primary" onClick={handleSpawn}>+ New</button>
      </div>
    </header>
  )
}
