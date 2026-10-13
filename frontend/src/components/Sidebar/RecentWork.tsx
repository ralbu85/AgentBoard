import {useEffect,useState} from 'react'
import {api} from '../../api'
import {useStore,completionKey,workspaceId} from '../../store'
import type {RecentWork as Work,Session} from '../../types'
import {AgentIcon} from '../AgentIcon'

const labels:Record<Work['status'],string>={submitted:'요청됨',working:'작업 중',waiting:'입력 대기',completed:'완료',stopped:'종료',idle:'최근 활동',previous:'이전 요청'}
const preference='agentboard.recentWork.collapsed'
function timeLabel(at:number,now:number){
  const minutes=Math.max(0,Math.floor((now-at*1000)/60000))
  if(minutes<1)return '방금'
  if(minutes<60)return `${minutes}분 전`
  if(minutes<1440)return `${Math.floor(minutes/60)}시간 전`
  if(minutes<10080)return `${Math.floor(minutes/1440)}일 전`
  return new Date(at*1000).toLocaleDateString('ko-KR',{month:'numeric',day:'numeric'})
}
function sameSession(item:Work,session:Session){
  return (session.host||'local')===item.host&&session.sessionName===item.sessionName&&session.createdAt===item.createdAt
}

export function RecentWork({onSelect}:{onSelect?:()=>void}){
  const state=useStore(),items=state.recentWork
  const [collapsed,setCollapsed]=useState(()=>{try{return localStorage.getItem(preference)==='true'}catch{return false}})
  const [now,setNow]=useState(Date.now)
  const [editing,setEditing]=useState<string|null>(null)
  const [draft,setDraft]=useState('')
  const [saving,setSaving]=useState(false)
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),30000);return()=>clearInterval(timer)},[])
  const toggle=()=>setCollapsed(value=>{try{localStorage.setItem(preference,String(!value))}catch{}return !value})
  const save=async()=>{
    if(!editing||saving||!draft.trim())return
    setSaving(true)
    try{
      const result=await api.renameRecentWork(editing,draft.trim())
      if(result.ok!==false){state.applySessionState(result);setEditing(null)}
    }finally{setSaving(false)}
  }
  const open=(item:Work,session:Session|undefined)=>{
    const hidden=session&&state.hiddenSessions.includes(completionKey(session))
    if(session&&item.event===session.completionEvent)void state.acknowledgeCompletion(session.id)
    if(session&&session.status==='running'&&!hidden){
      state.setActive(session.id)
    }else{
      // A history entry is not an instruction to resurrect a dismissed tab or
      // launch a new process. Its workspace/files are still available.
      if(item.host==='local')state.addWorkspaceFolder(item.cwd)
      state.restoreWorkspace(workspaceId(item.cwd,item.host))
      state.setWorkspace(item.cwd,item.host)
      useStore.setState({activeId:null})
    }
    onSelect?.()
  }
  return <section className="recent-work" aria-label="최근 작업 5건">
    <button className="recent-work-heading" aria-expanded={!collapsed} onClick={toggle} title="확인한 작업도 최근 5건에 남습니다">
      <span>최근 작업 <b>{items.length}</b></span><span aria-hidden="true">{collapsed?'▸':'▾'}</span>
    </button>
    {!collapsed&&<>
      {state.recentWorkError&&<p className="recent-work-error" role="status">{state.recentWorkError}</p>}
      {!items.length&&<p className="recent-work-empty">{state._recentWorkRevision<0?'최근 작업을 불러오는 중…':'작업을 요청하면 최근 5건이 여기에 남습니다.'}</p>}
      <ol className="recent-work-list">{items.map(item=>{
        const session=Object.values(state.sessions).find(session=>sameSession(item,session))
        const hidden=session&&state.hiddenSessions.includes(completionKey(session))
        const available=session?.status==='running'&&!hidden
        const name=item.cwd.split('/').filter(Boolean).pop()||item.cwd
        const offline=available&&(state.connection!=='online'||session?.online===false)
        const closed=hidden&&session?.status==='running'?'탭 닫힘':'종료'
        const status=offline?'연결 끊김':!available?(item.status==='completed'?`완료 · ${closed}`:closed):labels[item.status]||'최근 활동'
        return <li key={item.id} className="recent-work-item" data-unread={item.unread||undefined} data-work-status={item.status}>
          {editing===item.id?<form className="recent-work-edit" onSubmit={e=>{e.preventDefault();void save()}}>
            <input aria-label="최근 작업 이름" autoFocus maxLength={120} value={draft} disabled={saving} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();setEditing(null)}}}/>
            <button type="submit" disabled={saving||!draft.trim()}>저장</button><button type="button" disabled={saving} onClick={()=>setEditing(null)}>취소</button>
          </form>:<>
            <button className="recent-work-open" onClick={()=>open(item,session)} aria-label={`${name} · ${item.title} · ${status}${item.unread?' · 미확인':''}`}
              title={`${item.host} · ${item.cwd}\n${item.title}\n${new Date(item.at*1000).toLocaleString('ko-KR')}\n${available?'해당 세션 열기':'워크스페이스 열기'}`}>
              <span className="recent-work-context"><AgentIcon session={{cmd:item.command,process:session?.process}}/><strong>{name}</strong>{item.host!=='local'&&<small>{item.host}</small>}<time dateTime={new Date(item.at*1000).toISOString()}>{timeLabel(item.at,now)}</time></span>
              <span className="recent-work-detail"><span className="recent-work-title">{item.title}</span><span className={`recent-work-status ${available?item.status:'closed'}`}>{item.unread&&<i aria-label="미확인"/>}{status}</span></span>
            </button>
            <button className="recent-work-rename" title="작업 이름 수정" aria-label={`${item.title} 이름 수정`} onClick={()=>{setEditing(item.id);setDraft(item.title)}}>✎</button>
          </>}
        </li>
      })}</ol>
    </>}
  </section>
}
