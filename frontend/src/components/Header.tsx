import { useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { SpawnModal } from './SpawnModal/SpawnModal'

interface Props {
  onToggleSidebar: () => void
}

const ACTIVE_STATE_DISPLAY: Record<string, { label: string; icon: string; cls: string }> = {
  working:   { label: 'Thinking', icon: '●', cls: 'badge-working' },
  waiting:   { label: 'Asking',   icon: '◆', cls: 'badge-waiting' },
  completed: { label: 'Done',     icon: '✓', cls: 'badge-done' },
  idle:      { label: 'Idle',     icon: '○', cls: 'badge-idle' },
  stopped:   { label: 'Stopped',  icon: '■', cls: 'badge-stopped' },
}

export function Header({ onToggleSidebar }: Props) {
  const sessions = useStore((s) => s.sessions)
  const activeId = useStore((s) => s.activeId)
  const effectiveState = useStore((s) => s.effectiveState)
  const [unmanaged, setUnmanaged] = useState<any[]>([])
  const [showScan, setShowScan] = useState(false)
  const [showSpawn, setShowSpawn] = useState(false)

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

  // Active session state for mobile display
  const activeState = activeId ? effectiveState(activeId) || 'idle' : null
  const activeDisplay = ACTIVE_STATE_DISPLAY[activeState || 'idle']

  const handleSpawn = () => setShowSpawn(true)

  const handleScan = async () => {
    const list = await api.scan()
    setUnmanaged(list)
    setShowScan(true)
  }

  const handleAttach = async (sessionName: string, cwd: string) => {
    await api.attach(sessionName, cwd)
    setUnmanaged(prev => prev.filter(s => s.sessionName !== sessionName))
    if (unmanaged.length <= 1) setShowScan(false)
  }

  return (
    <header className="header">
      <div className="header-left">
        <button className="btn btn-icon" onClick={onToggleSidebar} title="Toggle sidebar (Ctrl+B)">
          ☰
        </button>
        <span id="status-dot" className="status-dot" />
        <span className="logo">AgentBoard</span>
      </div>
      <div className="header-center">
        {counts.working > 0 && <span className="badge badge-working">● {counts.working} Thinking</span>}
        {counts.waiting > 0 && <span className="badge badge-waiting">◆ {counts.waiting} Asking</span>}
        {counts.idle > 0 && <span className="badge badge-idle">○ {counts.idle} Idle</span>}
      </div>
      {activeDisplay && (
        <div className={`header-active-state ${activeDisplay.cls}`}>
          <span>{activeDisplay.icon}</span> {activeDisplay.label}
        </div>
      )}
      <div className="header-right">
        <button className="btn" onClick={handleScan} title="Detect tmux sessions">Scan</button>
        <button className="btn btn-primary" onClick={handleSpawn}>+ New</button>
      </div>

      <SpawnModal open={showSpawn} onClose={() => setShowSpawn(false)} />

      {showScan && (
        <div className="scan-popup">
          <div className="scan-header">
            <span>Unmanaged tmux sessions</span>
            <button className="btn btn-xs" onClick={() => setShowScan(false)}>&times;</button>
          </div>
          {unmanaged.length === 0 ? (
            <div className="scan-empty">No unmanaged sessions found</div>
          ) : (
            unmanaged.map(s => (
              <div key={s.sessionName} className="scan-item">
                <span className="scan-name">{s.sessionName}</span>
                <span className="scan-cwd">{s.cwd}</span>
                <button className="btn btn-xs btn-primary" onClick={() => handleAttach(s.sessionName, s.cwd)}>Attach</button>
              </div>
            ))
          )}
        </div>
      )}
    </header>
  )
}
