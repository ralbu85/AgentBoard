import { useState } from 'react'
import { AgentIcon } from '../AgentIcon'
import { WorkbenchIcon } from '../WorkbenchIcon'
import { SessionStatusBadge } from '../SessionStatusBadge'
import { sessionStatus } from '../../sessionStatus'
import { useStore, completionKey, sessionLabel, workspaceEntries, type WorkspaceEntry } from '../../store'

interface Props { onSelect?: () => void }
type StatusFilter = 'all' | 'working' | 'waiting' | 'completed'

export function FolderList({ onSelect }: Props) {
  const state = useStore()
  const [filter, setFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [dragged, setDragged] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [showRemoved, setShowRemoved] = useState(false)
  const entries = workspaceEntries(state)
  const statuses = Object.fromEntries(entries.flatMap(e=>e.ids.map(id=>[id,state.effectiveState(id)||'running'])))
  const unreadKeys = new Set(state.unreadCompletions)
  const isUnread = (id:string) => unreadKeys.has(completionKey(state.sessions[id]))
  const counts = {all:entries.reduce((n,e)=>n+e.ids.length,0),working:0,waiting:0,completed:entries.reduce((n,e)=>n+e.ids.filter(isUnread).length,0)}
  for(const status of Object.values(statuses)) {
    if(status==='working')counts.working++
    if(status==='waiting')counts.waiting++
  }
  const matchesStatus = (id:string) => statusFilter==='all'||(statusFilter==='completed'?isUnread(id):statuses[id]===statusFilter)
  const q = filter.trim().toLowerCase()
  const visible = entries.filter(e => `${e.cwd} ${e.host} ${e.ids.map(id=>sessionLabel(state.sessions[id],state.titles)).join(' ')}`.toLowerCase().includes(q) && (statusFilter==='all'||e.ids.some(matchesStatus)))
  const names = entries.map(e=>e.cwd.split('/').filter(Boolean).pop()||e.cwd)
  const removed = workspaceEntries(state, true).filter(e => state.hiddenWorkspaces.includes(e.key))

  const select = (entry: WorkspaceEntry) => {
    state.restoreWorkspace(entry.key)
    state.setWorkspace(entry.cwd, entry.host)
    // A filtered workspace opens a matching session, acknowledging that one
    // result only. Merely opening a folder must not clear its other results.
    if(statusFilter!=='all'){
      const id=entry.ids.find(matchesStatus)
      if(id){state.setActive(id);state.acknowledgeCompletion(id);onSelect?.();return}
    }
    const id = entry.ids.includes(state.activeId || '') ? state.activeId
      : entry.ids.find(id => state.sessions[id].status === 'running') || entry.ids[0] || null
    const existing = state._viewerState[entry.key]
    if (existing?.tabs.length || localStorage.getItem(`agentboard.viewer.${entry.key}`)) {
      useStore.setState({activeId: id})
      const selected=existing?.tabs.find(tab=>tab.id===existing.activeTabId)
      if(selected?.type==='terminal'&&selected.sessionId&&entry.ids.includes(selected.sessionId))state.acknowledgeCompletion(selected.sessionId)
    }
    else {state.setActive(id);if(id)state.acknowledgeCompletion(id)}
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
    <div className="workspace-nav-toolbar">
      <div className="folder-list-head">
        <span className="fl-title">워크스페이스 <span className="workspace-total">{entries.length}</span></span>
        <span className="workspace-order-hint" title="요청을 보내거나 작업이 완료되면 맨 위로 이동합니다. 드래그한 순서는 다음 작업까지 유지됩니다.">최근 작업순</span>
        <button className="fl-add" title="워크스페이스 폴더 열기" aria-label="워크스페이스 폴더 열기" onClick={state.openWorkspaceModal}><WorkbenchIcon name="plus" /></button>
      </div>
      <div className="folder-filter-wrap">
        <WorkbenchIcon name="search" />
        <input className="folder-filter" type="search" placeholder="워크스페이스·세션 검색…" aria-label="워크스페이스 검색"
          value={filter} onChange={e => setFilter(e.target.value)} />
      </div>

      {state.activityError && <p className="workspace-activity-error" role="status">{state.activityError}</p>}
      <div className="workspace-state-filters" role="group" aria-label="세션 상태 필터">
        {([['all','전체'],['working','작업 중'],['waiting','입력 대기'],['completed','미확인']] as const).map(([value,label])=><button key={value}
          className={`workspace-state-filter filter-${value}`} aria-label={`${label} ${counts[value]}개${value==='completed'?' · 미확인 결과':''}`} title={value==='completed'?'아직 확인하지 않은 완료 결과':`${label} 세션`}
          aria-pressed={statusFilter===value} onClick={()=>setStatusFilter(value)}>
          <b>{counts[value]}</b><span>{label}</span>
        </button>)}
      </div>
      {statusFilter==='completed'&&<div className="workspace-completion-hint">미확인 결과 · 선택하면 모든 기기에서 확인 처리됩니다.</div>}
    </div>

    <div className="workspace-groups">
      {visible.map(entry => {
        const name = entry.cwd.split('/').filter(Boolean).pop() || entry.cwd
        const ambiguous = names.filter(n=>n===name).length>1
        const active = state.workspaceCwd === entry.cwd && state.workspaceHost === entry.host
        const working = entry.ids.filter(id=>statuses[id]==='working').length
        const waiting = entry.ids.filter(id=>statuses[id]==='waiting').length
        const unread = entry.ids.filter(isUnread).length
        return <div key={entry.key} className={`workspace-session-group ${active ? 'active-workspace' : ''}`}><div className={`workspace-picker-row ${active ? 'active' : ''} ${unread ? 'has-unread' : ''} ${dropTarget === entry.key ? 'drop-target' : ''}`}
          onDragOver={e => { if (dragged && dragged !== entry.key) { e.preventDefault(); setDropTarget(entry.key) } }}
          onDrop={e => { e.preventDefault(); if (dragged) { const rect = e.currentTarget.getBoundingClientRect(); const after = e.clientY > rect.top + rect.height / 2; state.reorderWorkspace(dragged, entry.key, after) }; setDragged(null); setDropTarget(null) }}>
          <span className="workspace-drag" draggable tabIndex={0} role="button" aria-label={`${name} 순서 변경`} title="드래그하여 순서 변경 (키보드: Alt+↑↓)"
            onKeyDown={e => { if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); move(entry, e.key === 'ArrowUp' ? -1 : 1) } }}
            onDragStart={e => { e.dataTransfer.setData('text/plain', entry.key); e.dataTransfer.effectAllowed = 'move'; setDragged(entry.key) }}
            onDragEnd={() => { setDragged(null); setDropTarget(null) }}><WorkbenchIcon name="grip" /></span>
          <button className="workspace-picker-select" onClick={() => select(entry)} title={`${entry.host}: ${entry.cwd}`} aria-current={active ? 'page' : undefined}>
            <span className="workspace-picker-title"><WorkbenchIcon name="folder" /><span className="workspace-picker-name">{name}</span></span>
            {(ambiguous||entry.host!=='local')&&<span className="workspace-picker-path">{entry.host === 'local' ? entry.cwd : `${entry.host} · ${entry.cwd}`}</span>}
            <span className="workspace-activity-summary">
              {working>0&&<span className="workspace-activity-working" title={`작업 중인 세션 ${working}개`} aria-label={`작업 중 ${working}개`}>● {working}</span>}
              {waiting>0&&<span className="workspace-activity-waiting" title={`입력을 기다리는 세션 ${waiting}개`} aria-label={`입력 대기 ${waiting}개`}>◆ {waiting}</span>}
              {unread>0&&<span className="workspace-activity-completed" title={`확인하지 않은 완료 결과 ${unread}개`} aria-label={`미확인 완료 ${unread}개`}>✓ {unread}</span>}
              <span className="workspace-session-count" title={`전체 세션 ${entry.ids.length}개`} aria-label={`전체 세션 ${entry.ids.length}개`}>{entry.ids.length}</span>
            </span>
          </button>
          <div className="workspace-picker-actions">
            <button title={`${name} 목록에서 제거`} aria-label={`${name} 목록에서 제거`} onClick={() => remove(entry)}><WorkbenchIcon name="close" /></button>
          </div>
        </div>
        <div className="workspace-sessions">{entry.ids.filter(matchesStatus).map(id => {
          const session = state.sessions[id]
          const status = statuses[id]
          const pending = isUnread(id)
          const display = sessionStatus(session, status)
          const completed = display.state==='completed'
          const selected = state.activeId === id && active
          return <button key={id} data-state={status} data-unread={pending||undefined} data-completed={completed||undefined} aria-current={state.activeId === id && active ? 'true' : undefined}
            aria-label={`${selected?'선택됨, ':''}${sessionLabel(session,state.titles)}, ${display.label}${pending?', 미확인 완료':''}`} className={`workspace-session ${selected ? 'selected' : ''} ${pending ? 'has-unread' : ''}`}
            title={`${sessionLabel(session, state.titles)}${pending?'\n확인하지 않은 완료 결과 · 선택하면 확인 처리':''}\n${session.cmd || session.process || '터미널'}${session.createdAt ? ' · '+new Date(session.createdAt*1000).toLocaleString('ko-KR') : ''}`} onClick={() => { state.setActive(id); state.acknowledgeCompletion(id); onSelect?.() }}>
            <span className="workspace-selection-mark" aria-hidden="true">{selected?'›':''}</span>
            <AgentIcon session={session} />
            <span className="tab-terminal-fallback" aria-hidden="true"><WorkbenchIcon name="terminal" /></span>
            <span className="workspace-session-details"><span className="workspace-session-name">{sessionLabel(session, state.titles)}</span></span>
            <SessionStatusBadge status={display} className="workspace-session-status" />
            {pending&&<span className="workspace-unread-dot" title="새 완료 결과 · 선택하면 확인됩니다" aria-label="미확인 완료" />}
          </button>
        })}</div></div>
      })}
      {!visible.length && <div className="folder-empty">{q ? '검색 결과가 없습니다.' : statusFilter==='working' ? '작업 중인 세션이 없습니다.' : statusFilter==='waiting' ? '입력 대기 중인 세션이 없습니다.' : statusFilter==='completed' ? '확인하지 않은 완료 결과가 없습니다.' : '워크스페이스를 추가해 주세요.'}</div>}
      {removed.length > 0 && <div className="workspace-removed">
        <button className="btn btn-xs" onClick={() => setShowRemoved(v => !v)} aria-expanded={showRemoved}>제거한 항목 ({removed.length}) {showRemoved ? '▴' : '▾'}</button>
        {showRemoved && removed.map(entry => <button key={entry.key} className="workspace-restore" onClick={() => select(entry)} title={`${entry.host}: ${entry.cwd}`}>
          <span>{entry.cwd.split('/').filter(Boolean).pop() || entry.cwd} · {entry.host}</span><span>다시 열기</span>
        </button>)}
      </div>}
    </div>
  </div>
}
