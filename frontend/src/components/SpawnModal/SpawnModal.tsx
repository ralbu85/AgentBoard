import { useState, useEffect, useRef } from 'react'
import { api } from '../../api'
import { useStore } from '../../store'
import { CLEAN_TERMINAL, spawnAndFocus } from '../../spawn'
import type { HostInfo } from '../../types'

interface Props { open: boolean; onClose: () => void }

export function SpawnModal({ open, onClose }: Props) {
  const [cmd, setCmd] = useState(CLEAN_TERMINAL)
  const [submitting, setSubmitting] = useState(false)
  const busy = useRef(false)
  const [error, setError] = useState('')
  const [hosts, setHosts] = useState<HostInfo[]>([])
  const [host, setHost] = useState('local')
  const [cwd, setCwd] = useState('~')
  const [favorites, setFavorites] = useState<string[]>([])
  const [advanced, setAdvanced] = useState(false)
  const preset = useStore(s => s.spawnPreset)
  const sessions = useStore(s => s.sessions)
  const profiles = useStore(s => s.profiles)
  const folderChips = Array.from(new Set([
    ...Object.values(sessions).filter(s => (s.host || 'local') === host).map(s => s.cwd).filter(Boolean),
    ...(host === 'local' ? favorites : []),
  ])).slice(0, 8)

  useEffect(() => {
    if (!open) return
    let alive = true
    const state = useStore.getState()
    const selectedHost = preset.host || state.workspaceHost || 'local'
    setError(''); setCmd(CLEAN_TERMINAL); setAdvanced(false); setHost('local')
    setCwd(selectedHost === 'local' ? preset.cwd || state.workspaceCwd || '~' : '~')
    api.hosts().then(list => { if (alive) setHosts(Array.isArray(list) ? list : []) }).catch(() => {})
    api.config().then(c => { if (alive) setFavorites(Array.isArray(c?.favorites) ? c.favorites : []) }).catch(() => {})
    return () => { alive = false }
  }, [open])

  const close = () => { if (!busy.current) onClose() }
  const offline = host !== 'local' && !hosts.some(h => h.host === host && h.online)
  const submit = async () => {
    if (busy.current || offline || !cmd.trim()) return
    busy.current = true
    setSubmitting(true); setError('')
    try {
      if (await spawnAndFocus(cwd.trim() || '~', host, cmd.trim())) onClose()
      else setError('터미널을 열지 못했습니다. 폴더와 서버 연결을 확인하세요.')
    } finally { busy.current = false; setSubmitting(false) }
  }
  if (!open) return null
  return (
    <div className="spawn-backdrop" onClick={close}>
      <form className="spawn-modal terminal-launcher" role="dialog" aria-modal="true" aria-labelledby="spawn-title"
        onClick={e => e.stopPropagation()} onSubmit={e => { e.preventDefault(); void submit() }}
        onKeyDown={e => { if (e.key === 'Escape') close() }}>
        <div className="spawn-header">
          <span id="spawn-title">새 터미널</span>
          <button type="button" className="btn btn-xs" onClick={close} disabled={submitting} aria-label="닫기">×</button>
        </div>
        <div className="spawn-body">
          <div className="spawn-intro"><strong>›_ 터미널부터 시작</strong><p>빈 Bash 터미널을 엽니다. 필요한 에이전트나 환경은 터미널에서 직접 실행하세요.</p></div>
          <fieldset disabled={submitting}>
            <label className="spawn-label" htmlFor="spawn-cwd">작업 폴더</label>
            <input id="spawn-cwd" className="spawn-host-select" value={cwd} onChange={e => setCwd(e.target.value)}
              placeholder="~ 또는 /path/to/project" spellCheck={false} autoFocus />
            {folderChips.length > 0 && <div className="spawn-folder-chips">
              {folderChips.map(f => <button type="button" key={f} className={`spawn-folder-chip ${cwd === f ? 'active' : ''}`}
                title={f} onClick={() => setCwd(f)}>{f.split('/').pop() || f}</button>)}
            </div>}
            <button type="button" className="spawn-options-toggle" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
              {advanced ? '▾' : '▸'} 고급 옵션 · 서버 / 실행 명령
            </button>
            {advanced && <div className="spawn-options">
              <label className="spawn-label" htmlFor="spawn-host">실행 서버</label>
              <select id="spawn-host" className="spawn-host-select" value={host} onChange={e => { setHost(e.target.value); setCwd('~') }}>
                <option value="local">이 서버 · 기본</option>
                {hosts.filter(h => h.host !== 'local').map(h => <option key={h.host} value={h.host} disabled={!h.online}>{h.label}{h.online ? '' : ' · 연결 끊김'}</option>)}
              </select>
              <div className="spawn-agent-head"><label className="spawn-label">실행 프로필</label>
                <button type="button" className="spawn-editprofiles" onClick={() => { onClose(); useStore.getState().openProfileEditor() }}>관리</button>
              </div>
              <div className="spawn-presets">
                <button type="button" className={`spawn-preset ${cmd === CLEAN_TERMINAL ? 'active' : ''}`} onClick={() => setCmd(CLEAN_TERMINAL)}>›_ 깨끗한 터미널</button>
                {profiles.filter(p => !/[\r\n]/.test(p.command)).map(p => <button type="button" key={p.id} className={`spawn-preset ${cmd === p.command ? 'active' : ''}`} onClick={() => setCmd(p.command)} title={p.command}>{p.label}</button>)}
              </div>
              <label className="spawn-label" htmlFor="spawn-command">시작 명령</label>
              <input id="spawn-command" className="spawn-cmd" value={cmd} onChange={e => setCmd(e.target.value)} spellCheck={false} />
              <p className="spawn-help">기본 터미널은 셸 시작 설정을 건너뜁니다. 기존 셸 설정이 필요하면 명령을 bash로 바꾸세요.</p>
            </div>}
          </fieldset>
          {(advanced || host !== 'local' || cmd !== CLEAN_TERMINAL) && <div className="spawn-summary">{host === 'local' ? '이 서버' : host} · {cmd}</div>}
          {error && <div className="spawn-error" role="alert">{error}</div>}
          {submitting && <div className="spawn-progress" role="status">터미널을 생성하고 연결을 확인하고 있습니다…</div>}
        </div>
        <div className="spawn-footer">
          <button type="button" className="btn" onClick={close} disabled={submitting}>취소</button>
          <button type="submit" className="btn btn-primary" disabled={submitting || offline || !cmd.trim()}>{submitting ? '여는 중…' : '터미널 열기'}</button>
        </div>
      </form>
    </div>
  )
}
