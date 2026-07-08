import { useState, useEffect } from 'react'
import { api } from '../../api'
import { useStore } from '../../store'
import { notifyActive, send } from '../../ws'
import type { HostInfo } from '../../types'

const PRESETS = [
  { id: 'claude', label: 'Claude', icon: '🤖', cmd: 'claude' },
  { id: 'codex', label: 'Codex', icon: '🧠', cmd: 'codex' },
  { id: 'bash', label: 'Bash', icon: '>_', cmd: 'bash' },
  { id: 'custom', label: 'Custom', icon: '⚙', cmd: '' },
]

interface Props {
  open: boolean
  onClose: () => void
}

export function SpawnModal({ open, onClose }: Props) {
  const [preset, setPreset] = useState('claude')
  const [cmd, setCmd] = useState('claude')
  const [showCmd, setShowCmd] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [hosts, setHosts] = useState<HostInfo[]>([])
  const [host, setHost] = useState('local')

  useEffect(() => {
    if (open) {
      setError(''); setSubmitting(false); setShowCmd(false)
      api.hosts().then((list: HostInfo[]) => setHosts(Array.isArray(list) ? list : []))
        .catch(() => setHosts([]))
    }
  }, [open])

  const selectPreset = (id: string) => {
    const p = PRESETS.find(x => x.id === id)!
    setPreset(id)
    if (id === 'custom') { setShowCmd(true); setCmd('') }
    else { setCmd(p.cmd) }
  }

  const submit = async () => {
    if (!cmd.trim()) return
    setSubmitting(true)
    setError('')
    try {
      const lines = cmd.trim().split('\n')
      // Correlate this spawn with its resulting session via a reqId echoed back
      // on the `spawned` event — robust against concurrent spawns on one host
      // (remote sessions get their id from the agent, not the REST reply).
      const reqId = (crypto?.randomUUID?.() ?? `r${Date.now()}${Math.random()}`)
      const res = await api.spawn('~', lines[0], host, reqId)
      if (!res.ok) { setError(res.error || 'Failed'); setSubmitting(false); return }

      const findNew = (): string | null => {
        const matched = useStore.getState()._spawnReqs[reqId]
        if (matched && useStore.getState().sessions[matched]) return matched
        // Local spawns also return the id directly.
        if (host === 'local' && res.id != null && useStore.getState().sessions[String(res.id)]) {
          return String(res.id)
        }
        return null
      }

      const sendExtraLines = (id: string) => {
        if (lines.length > 1) {
          setTimeout(async () => {
            for (let i = 1; i < lines.length; i++) await api.input(id, lines[i])
          }, 1000)
        }
      }

      onClose()
      const poll = setInterval(() => {
        const newId = findNew()
        if (newId) {
          clearInterval(poll)
          useStore.getState().setActive(newId)
          notifyActive(newId)
          sendExtraLines(newId)
        }
      }, 100)
      setTimeout(() => clearInterval(poll), 8000)
    } catch (e) { setError(e instanceof Error ? e.message : 'Error') }
    setSubmitting(false)
  }

  if (!open) return null

  return (
    <div className="spawn-backdrop" onClick={onClose}>
      <div className="spawn-modal" onClick={e => e.stopPropagation()}>
        <div className="spawn-header">
          <span>New Session</span>
          <button className="btn btn-xs" onClick={onClose}>&times;</button>
        </div>
        <div className="spawn-body">
          {hosts.length > 1 && (
            <>
              <label className="spawn-label">MACHINE</label>
              <select className="spawn-host-select" value={host} onChange={e => setHost(e.target.value)}>
                {hosts.map(h => (
                  <option key={h.host} value={h.host}>
                    {h.host === 'local' ? 'This machine' : h.label}{h.online ? '' : ' (offline)'}
                  </option>
                ))}
              </select>
            </>
          )}
          <label className="spawn-label">AGENT</label>
          <div className="spawn-presets">
            {PRESETS.map(p => (
              <button key={p.id} className={`spawn-preset ${preset === p.id ? 'active' : ''}`}
                onClick={() => selectPreset(p.id)}>
                <span className="spawn-preset-icon">{p.icon}</span>
                <span className="spawn-preset-label">{p.label}</span>
              </button>
            ))}
          </div>

          {(showCmd || preset === 'custom') ? (
            <>
              <label className="spawn-label">COMMAND</label>
              <textarea className="spawn-cmd" value={cmd} onChange={e => setCmd(e.target.value)}
                placeholder="Enter command(s), one per line..." rows={3} />
            </>
          ) : (
            <div className="spawn-cmd-toggle" onClick={() => setShowCmd(true)}>
              Command: <code>{cmd}</code> <span className="spawn-edit-hint">edit</span>
            </div>
          )}

          {error && <div className="spawn-error">{error}</div>}
        </div>
        <div className="spawn-footer">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={submitting || !cmd.trim()}>
            {submitting ? 'Starting...' : 'Start Session'}
          </button>
        </div>
      </div>
    </div>
  )
}
