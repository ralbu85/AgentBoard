import { useState, useEffect } from 'react'
import { api } from '../../api'
import { useStore } from '../../store'
import type { HostInfo } from '../../types'

interface Props {
  open: boolean
  onClose: () => void
}

export function SpawnModal({ open, onClose }: Props) {
  // Sessions are AI CLI agents by default (Claude); "터미널" gives a bare shell.
  const [cmd, setCmd] = useState('claude')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [hosts, setHosts] = useState<HostInfo[]>([])
  const [host, setHost] = useState('local')
  const [cwd, setCwd] = useState('~')
  const [favorites, setFavorites] = useState<string[]>([])
  const preset0 = useStore((s) => s.spawnPreset)
  const sessions = useStore((s) => s.sessions)
  const profiles = useStore((s) => s.profiles)
  const openProfileEditor = useStore((s) => s.openProfileEditor)
  const closeSpawnAction = useStore((s) => s.closeSpawn)
  const defaultCmd = (profiles.find((p) => p.default) || profiles[0])?.command || 'claude'

  // Folders already in use by running sessions + configured favorites — quick picks.
  const folderChips = Array.from(
    new Set([
      ...(preset0.cwd ? [preset0.cwd] : []),
      ...Object.values(sessions).map((s) => s.cwd).filter(Boolean),
      ...favorites,
    ])
  ).slice(0, 12)

  useEffect(() => {
    if (open) {
      setError(''); setSubmitting(false); setCmd(defaultCmd)
      setCwd(preset0.cwd || '~')
      setHost(preset0.host || 'local')
      api.hosts().then((list: HostInfo[]) => setHosts(Array.isArray(list) ? list : []))
        .catch(() => setHosts([]))
      api.config().then((c) => setFavorites(Array.isArray(c?.favorites) ? c.favorites : []))
        .catch(() => setFavorites([]))
    }
  }, [open])

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
      const res = await api.spawn(cwd.trim() || '~', lines[0], host, reqId)
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
          useStore.getState().setActive(newId)  // effect notifies + snapshots
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
          <span>새 터미널</span>
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
          <label className="spawn-label">FOLDER</label>
          <input
            className="spawn-host-select"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="~ (home) or /path/to/project"
            spellCheck={false}
          />
          {folderChips.length > 0 && (
            <div className="spawn-folder-chips">
              {folderChips.map((f) => (
                <button
                  key={f}
                  className={`spawn-folder-chip ${cwd === f ? 'active' : ''}`}
                  title={f}
                  onClick={() => setCwd(f)}
                >
                  {f.split('/').pop() || f}
                </button>
              ))}
            </div>
          )}
          <div className="spawn-agent-head">
            <label className="spawn-label">에이전트 (프로필)</label>
            <button className="spawn-editprofiles" onClick={() => { closeSpawnAction(); openProfileEditor() }}>편집</button>
          </div>
          <div className="spawn-presets">
            {profiles.map((p) => (
              <button key={p.id} className={`spawn-preset ${cmd === p.command ? 'active' : ''}`}
                onClick={() => setCmd(p.command)} title={p.command}>
                <span className="spawn-preset-icon">{p.icon || '›'}</span>
                <span className="spawn-preset-label">{p.label}</span>
              </button>
            ))}
          </div>
          <label className="spawn-label">명령</label>
          <textarea className="spawn-cmd" value={cmd} onChange={e => setCmd(e.target.value)}
            placeholder="claude" rows={2} spellCheck={false} />

          {error && <div className="spawn-error">{error}</div>}
        </div>
        <div className="spawn-footer">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={submitting || !cmd.trim()}>
            {submitting ? '시작 중...' : '터미널 시작'}
          </button>
        </div>
      </div>
    </div>
  )
}
