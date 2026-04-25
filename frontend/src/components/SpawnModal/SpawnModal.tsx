import { useState, useEffect } from 'react'
import { api } from '../../api'
import { useStore } from '../../store'
import { notifyActive, send } from '../../ws'

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

  useEffect(() => {
    if (open) { setError(''); setSubmitting(false); setShowCmd(false) }
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
      const res = await api.spawn('~', lines[0])
      if (res.ok && lines.length > 1) {
        setTimeout(async () => {
          for (let i = 1; i < lines.length; i++) await api.input(res.id, lines[i])
        }, 1000)
      }
      if (res.ok) {
        const newId = String(res.id)
        onClose()
        const poll = setInterval(() => {
          if (useStore.getState().sessions[newId]) {
            clearInterval(poll)
            useStore.getState().setActive(newId)
            notifyActive(newId)
          }
        }, 100)
        setTimeout(() => clearInterval(poll), 5000)
      } else {
        setError(res.error || 'Failed')
      }
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
