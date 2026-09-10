import { useState } from 'react'
import { useStore, completionKey, sessionLabel, workspaceEntries, type WorkspaceEntry } from '../../store'

interface Props { onSelect?: () => void }

export function FolderList({ onSelect }: Props) {
  const state = useStore()
  const [filter, setFilter] = useState('')
  const [dragged, setDragged] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [showRemoved, setShowRemoved] = useState(false)
  const entries = workspaceEntries(state)
  const q = filter.trim().toLowerCase()
  const visible = entries.filter(e => `${e.cwd} ${e.host}`.toLowerCase().includes(q))
  const removed = workspaceEntries(state, true).filter(e => state.hiddenWorkspaces.includes(e.key))

  const select = (entry: WorkspaceEntry) => {
    state.restoreWorkspace(entry.key)
    state.setWorkspace(entry.cwd, entry.host)
    const id = entry.ids.includes(state.activeId || '') ? state.activeId
      : entry.ids.find(id => state.sessions[id].status === 'running') || entry.ids[0] || null
    const existing = state._viewerState[entry.key]
    if (existing?.tabs.length || localStorage.getItem(`agentboard.viewer.${entry.key}`)) useStore.setState({activeId: id})
    else state.setActive(id)
    onSelect?.()
  }
  const remove = (entry: WorkspaceEntry) => {
    const dirty = state._viewerState[entry.key]?.tabs.some(t => t.dirty)
    if (!window.confirm(`워크스페이스를 목록에서 제거할까요?\n${entry.host}: ${entry.cwd}\n\n실제 폴더와 파일, 세션 ${entry.ids.length}개는 그대로 유지됩니다.${dirty ? '\n저장하지 않은 편집 내용은 이 창에 유지됩니다.' : ''}\n제거한 항목 목록에서 다시 열 수 있습니다.`)) return
    state.removeWorkspaceFolder(entry.cwd, entry.host)
  }
  const move = (entry: WorkspaceEntry, delta: number) => {
    const index = entries.findIndex(e => e.key === entry.key)
    const neighbor = entries[index + delta]
    if (!neighbor) return
    if (delta < 0) state.reorderWorkspace(entry.key, neighbor.key)
    else state.reorderWorkspace(neighbor.key, entry.key)
  }

  return <div className="folder-list workspace-picker-list">
    <div className="folder-list-head">
      <span className="fl-title">워크스페이스 · {entries.length}</span>
      <button className="fl-add" title="워크스페이스 폴더 열기" onClick={state.openWorkspaceModal}>＋</button>
    </div>
    <div className="folder-filter-wrap">
      <input className="folder-filter" type="search" placeholder="이름·경로·머신 검색…" aria-label="워크스페이스 검색"
        value={filter} onChange={e => setFilter(e.target.value)} />
    </div>
    <div className="workspace-picker-hint">⠿ 드래그하여 순서 변경</div>
    <div className="workspace-status-legend"><span className="fs-working">● 작업</span><span className="fs-waiting">● 입력 대기</span></div>
    {visible.map(entry => {
      const name = entry.cwd.split('/').filter(Boolean).pop() || entry.cwd
      const active = state.workspaceCwd === entry.cwd && state.workspaceHost === entry.host
      const unread = entry.ids.filter(id => state.unreadCompletions.includes(completionKey(state.sessions[id]))).length
      const counts = { working: 0, waiting: 0, idle: 0 }
      for (const id of entry.ids) {
        const status = state.effectiveState(id)
        if (status === 'working' || status === 'waiting' || status === 'idle') counts[status]++
      }
      return <div key={entry.key} className={`workspace-session-group ${active ? 'active-workspace' : ''}`}><div className={`workspace-picker-row ${active ? 'active' : ''} ${unread ? 'has-unread' : ''} ${dropTarget === entry.key ? 'drop-target' : ''}`}
        onDragOver={e => { if (dragged && dragged !== entry.key) { e.preventDefault(); setDropTarget(entry.key) } }}
        onDrop={e => { e.preventDefault(); if (dragged) { const rect = e.currentTarget.getBoundingClientRect(); const after = e.clientY > rect.top + rect.height / 2; state.reorderWorkspace(dragged, entry.key, after) }; setDragged(null); setDropTarget(null) }}>
        <span className="workspace-drag" draggable tabIndex={0} role="button" aria-label={`${name} 순서 변경`} title="드래그하여 순서 변경 (키보드: Alt+↑↓)"
          onKeyDown={e => { if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); move(entry, e.key === 'ArrowUp' ? -1 : 1) } }}
          onDragStart={e => { e.dataTransfer.setData('text/plain', entry.key); e.dataTransfer.effectAllowed = 'move'; setDragged(entry.key) }}
          onDragEnd={() => { setDragged(null); setDropTarget(null) }}>⠿</span>
        <button className="workspace-picker-select" onClick={() => select(entry)} title={`${entry.host}: ${entry.cwd}`} aria-current={active ? 'page' : undefined}>
          <span className="workspace-picker-name">{name}</span>
          <span className="workspace-picker-path">{entry.host === 'local' ? entry.cwd : `${entry.host} · ${entry.cwd}`}</span>
          <span className="folder-states">{Object.entries(counts).map(([status, count]) => count > 0 &&
            <span key={status} className={`fstate fs-${status}`} title={`${({working: '작업 중', waiting: '입력 대기', idle: '대기'} as Record<string, string>)[status]}: ${count}`}><i className="fs-dot" />{count}</span>)}{unread > 0 && <span className="unread-chip" title="클릭하여 미확인 표시 해제" onClick={e => { e.stopPropagation(); entry.ids.forEach(id => state.acknowledgeCompletion(id)) }}>✓ {unread}</span>}</span>
        </button>
        <div className="workspace-picker-actions">
          <button title={`${name} 목록에서 제거`} onClick={() => remove(entry)}>×</button>
        </div>
      </div>
      <div className="workspace-sessions">{entry.ids.map(id => {
        const session = state.sessions[id]
        const status = state.effectiveState(id) || 'idle'
        const pending = state.unreadCompletions.includes(completionKey(session))
        return <button key={id} className={`workspace-session ${state.activeId === id && active ? 'selected' : ''} ${pending ? 'has-unread' : ''}`}
          title={`${sessionLabel(session, state.titles)} · #${id}`} onClick={() => { state.setActive(id); state.acknowledgeCompletion(id); onSelect?.() }}>
          <span className={`session-dot dot-${status}`} />
          <span className="workspace-session-name">{sessionLabel(session, state.titles)}</span>
          <span className="workspace-session-status">{pending ? '✓ 미확인' : ({working:'작업 중',waiting:'입력 대기',idle:'대기',completed:'완료',stopped:'종료'} as Record<string,string>)[status] || status}</span>
        </button>
      })}</div></div>
    })}
    {!visible.length && <div className="folder-empty">{q ? '검색 결과가 없습니다.' : '워크스페이스를 추가해 주세요.'}</div>}
    {removed.length > 0 && <div className="workspace-removed">
      <button className="btn btn-xs" onClick={() => setShowRemoved(v => !v)} aria-expanded={showRemoved}>제거한 항목 ({removed.length}) {showRemoved ? '▴' : '▾'}</button>
      {showRemoved && removed.map(entry => <button key={entry.key} className="workspace-restore" onClick={() => select(entry)} title={`${entry.host}: ${entry.cwd}`}>
        <span>{entry.cwd.split('/').filter(Boolean).pop() || entry.cwd} · {entry.host}</span><span>다시 열기</span>
      </button>)}
    </div>}
  </div>
}
