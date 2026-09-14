import {useEffect, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import {listNotebookKernels, stopNotebookKernel, type NotebookState} from './notebookRuntime'

export const kernelStateLabel=(state:string)=>({stopped:'연결 안 됨',starting:'연결 중',idle:'대기',running:'실행 중',interrupting:'중단 중',stopping:'종료 중'} as Record<string,string>)[state]||state

export function NotebookKernels({onClose}:{onClose:()=>void}){
  const dialog=useRef<HTMLDialogElement>(null)
  const [data,setData]=useState<{limit:number;sessions:NotebookState[]}|null>(null)
  const [error,setError]=useState('')
  const [loading,setLoading]=useState(false)
  const [stopping,setStopping]=useState<string|null>(null)
  const [reload,setReload]=useState(0)
  useEffect(()=>{dialog.current?.showModal()},[])
  useEffect(()=>{
    let alive=true, fetching=false
    const load=async()=>{
      if(fetching)return
      fetching=true;setLoading(true)
      try{const result=await listNotebookKernels();if(alive){setData(result);setError('')}}
      catch(e){if(alive)setError(e instanceof Error?e.message:'커널 목록을 불러오지 못했습니다.')}
      finally{fetching=false;if(alive)setLoading(false)}
    }
    void load()
    const timer=setInterval(()=>void load(),3000)
    return()=>{alive=false;clearInterval(timer)}
  },[reload])
  const stop=async(id:string)=>{
    if(!confirm('이 커널의 작업과 변수를 종료할까요?'))return
    setStopping(id)
    try{await stopNotebookKernel(id);setReload(v=>v+1)}catch(e){setError(e instanceof Error?e.message:'커널 종료 실패')}
    finally{setStopping(null)}
  }
  const sessions=data?.sessions.filter(s=>s.kernel||s.state==='starting')||[]
  return createPortal(<dialog ref={dialog} className="nb-kernel-dialog" onCancel={onClose} aria-label="노트북 커널 목록">
    <header><strong>노트북 커널 목록{data?` · ${sessions.length} / ${data.limit}`:''}</strong><button onClick={onClose} aria-label="커널 목록 닫기">닫기</button></header>
    {loading&&!data&&<p role="status">커널 목록 불러오는 중…</p>}
    {error&&<p role="alert">{error}</p>}
    <button disabled={loading} onClick={()=>setReload(v=>v+1)}>{loading?'조회 중…':'새로고침'}</button>
    {data&&!sessions.length&&<p>연결된 커널이 없습니다. 노트북에서 커널 연결 또는 셀 실행을 눌러 시작하세요.</p>}
    {sessions.map(s=><section key={s.id}><div><strong>{s.path.split('/').pop()}</strong><small>{s.path}</small><small>{s.kernelName||'Python'} · {s.python}</small><span>{kernelStateLabel(s.state)}{s.cell!==null?` · 셀 ${s.cell+1}`:''}</span></div><button disabled={!!stopping} onClick={()=>void stop(s.id)}>{stopping===s.id?'종료 중…':'종료'}</button></section>)}
  </dialog>,document.body)
}
