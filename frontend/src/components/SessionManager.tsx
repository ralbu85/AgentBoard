import {useEffect, useState} from 'react'
import {api} from '../api'
import {completionKey, sessionLabel, useStore} from '../store'
import {useToasts} from '../toasts'

const labels: Record<string,string> = {working:'작업 중',waiting:'입력 대기',idle:'대기',running:'상태 확인 중',completed:'완료',stopped:'종료',disconnected:'연결 끊김'}
type Unmanaged = {sessionName:string;cwd:string;createdAt?:number|string}
export function SessionManager({onClose}:{onClose:()=>void}) {
  const state = useStore()
  const [filter,setFilter] = useState('all')
  const [query,setQuery] = useState('')
  const [unmanaged,setUnmanaged] = useState<Unmanaged[]>([])
  const [loading,setLoading] = useState(false)
  const [error,setError] = useState('')
  const [busy,setBusy] = useState<string|null>(null)
  const refresh = async () => {
    setLoading(true);setError('')
    try {
      const list = await api.scan()
      setUnmanaged(Array.isArray(list) ? list : [])
    } catch { setError('미연결 세션을 불러오지 못했습니다. 새로고침해 주세요.') }
    finally {setLoading(false)}
  }
  useEffect(()=>{void refresh()},[])
  useEffect(()=>{const key=(e:KeyboardEvent)=>{if(e.key==='Escape')onClose()};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key)},[onClose])
  const sessions=Object.values(state.sessions)
  const hidden=(id:string)=>state.hiddenSessions.includes(completionKey(state.sessions[id]))
  const matches=(text:string)=>text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  const selected=sessions.filter(s=>filter==='hidden'?hidden(s.id):filter==='all'||(!hidden(s.id)&&(filter==='running'?s.status==='running':s.status!=='running')))
    .filter(s=>matches(`${sessionLabel(s,state.titles)} ${s.cwd} ${s.host} ${s.sessionName} ${s.process} ${s.cmd}`))
    .sort((a,b)=>(b.lastActivityAt||b.createdAt)-(a.lastActivityAt||a.createdAt))
  const run=async(id:string,action:()=>Promise<unknown>)=>{if(busy)return;setBusy(id);try{await action()}catch{useToasts.getState().push('처리하지 못했습니다. 연결 상태를 확인해 주세요.')}finally{setBusy(null)}}
  return <div className="session-manager-backdrop" onClick={e=>{if(e.target===e.currentTarget)onClose()}}>
    <section className="session-manager" role="dialog" aria-modal="true" aria-label="세션 관리">
      <div className="session-manager-head"><strong>세션 관리 · {sessions.length}개</strong><button className="btn" disabled={loading} onClick={refresh}>미연결 목록 새로고침</button><button className="btn" onClick={onClose} aria-label="세션 관리 닫기">×</button></div>
      <p>숨김은 이 브라우저의 목록·탭에서만 감춥니다. 종료하면 실행 중인 작업이 중단됩니다.</p>
      {state.connection!=='online'&&<p role="status">서버 연결이 끊겼습니다. 표시된 상태는 마지막 수신 정보입니다.</p>}
      <input type="search" aria-label="세션 검색" placeholder="작업 이름·폴더·머신 검색" value={query} onChange={e=>setQuery(e.target.value)} />
      <div className="session-manager-filters">{[['all','전체'],['running','실행 중'],['ended','종료됨'],['hidden','숨김'],['unmanaged','미연결']].map(([key,label])=><button className="btn" aria-pressed={filter===key} key={key} onClick={()=>setFilter(key)}>{label}</button>)}</div>
      <div className="session-manager-list">
      {filter!=='unmanaged'&&selected.map(s=>{
        const status=state.effectiveState(s.id)||'running', name=sessionLabel(s,state.titles), offline=status==='disconnected'
        return <article className="session-manager-row" key={s.id}>
          <div className="session-manager-detail"><strong>{name}</strong><span>{s.hostLabel||s.host} · {s.sessionName}</span><span className="session-manager-path">{s.cwd}</span><small>{s.process||s.cmd||'프로세스 확인 중'} · {labels[status]||status}{hidden(s.id)?' · 숨김':''}</small><small>마지막 출력 변화: {s.lastActivityAt?new Date(s.lastActivityAt*1000).toLocaleString('ko-KR'):'아직 관측 없음'}</small></div>
          <div className="session-manager-actions">
            <button className="btn" onClick={()=>{state.setActive(s.id);state.acknowledgeCompletion(s.id);onClose()}}>열기</button>
            <button className="btn" onClick={()=>state.setSessionHidden(s.id,!hidden(s.id))}>{hidden(s.id)?'숨김 해제':'숨김'}</button>
            <button className="btn" disabled={!!busy||offline} onClick={()=>{
              const live=s.status==='running'
              if(!window.confirm(live?`“${name}” 세션을 종료할까요?\n${s.host}: ${s.cwd}\n실행 중인 작업이 중단됩니다.`:`“${name}”의 종료 기록을 제거할까요?\n${s.host}: ${s.cwd}\n파일은 유지됩니다.`))return
              void run(s.id,async()=>{
                const result=live?await api.kill(s.id):await api.remove(s.id)
                if(result.ok===false)return
                // Remote actions are acknowledged by the host over WebSocket.
                if(s.host==='local') {
                  if(live)useStore.getState().handleMessage({type:'status',id:s.id,status:'stopped'})
                  else useStore.getState().removeSession(s.id)
                }
              })
            }}>{busy===s.id?'처리 중…':s.status==='running'?'종료':'기록 제거'}</button>
          </div>
        </article>
      })}
      {filter!=='unmanaged'&&!selected.length&&<p>해당 세션이 없습니다.</p>}
      {filter==='unmanaged'&&<>
        <p>이 컴퓨터의 tmux 세션 중 앱에 연결되지 않은 항목입니다.</p>
        {loading&&<p>불러오는 중…</p>}{error&&<p role="alert">{error}</p>}
        {unmanaged.filter(s=>matches(`${s.sessionName} ${s.cwd}`)).map(s=><article className="session-manager-row" key={s.sessionName}><div className="session-manager-detail"><strong>{s.sessionName}</strong><span className="session-manager-path">{s.cwd}</span></div><button className="btn" disabled={!!busy||state.connection!=='online'} onClick={()=>void run(s.sessionName,async()=>{const result=await api.attach(s.sessionName,s.cwd);if(result.ok!==false){await refresh();setFilter('all')}})}>연결</button></article>)}
        {!loading&&!error&&!unmanaged.length&&<p>미연결 세션이 없습니다.</p>}
      </>}
      </div>
    </section>
  </div>
}
