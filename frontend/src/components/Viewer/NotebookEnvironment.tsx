import {useEffect, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import {notebookAction, notebookEnvironments, useNotebooks} from './notebookRuntime'

type Environment={id:string;name:string;python:string;source:string}
export function NotebookEnvironment({path,onClose}:{path:string;onClose:()=>void}){
  const dialog=useRef<HTMLDialogElement>(null)
  const record=useNotebooks(s=>s.records[path])
  const [options,setOptions]=useState<Environment[]>([])
  const [folder,setFolder]=useState('')
  const [loading,setLoading]=useState(true)
  const [error,setError]=useState('')
  const [retry,setRetry]=useState(0)
  const [query,setQuery]=useState('')
  useEffect(()=>{dialog.current?.showModal()},[])
  useEffect(()=>{
    let alive=true;setLoading(true);setError('')
    void notebookEnvironments(path).then(data=>{if(alive){setOptions(data.environments);setFolder(data.folder)}}).catch(e=>{if(alive)setError(e.message)}).finally(()=>{if(alive)setLoading(false)})
    return()=>{alive=false}
  },[path,retry])
  const choose=async(option:Environment)=>{
    setError('')
    const replace=record.server.kernel&&(record.server.environment||'default')!==option.id
    if(replace&&!confirm(`‘${option.name}’ 환경으로 바꿀까요? 현재 커널의 작업과 변수는 종료되며 코드와 출력은 유지됩니다.`))return
    try{await notebookAction(path,'connect-environment',undefined,option.id,replace);onClose()}catch(e){setError(e instanceof Error?e.message:'선택 실패')}
  }
  const filtered=options.filter(option=>`${option.name} ${option.python} ${option.source}`.toLowerCase().includes(query.toLowerCase()))
  return createPortal(<dialog ref={dialog} className="nb-kernel-dialog" aria-label="노트북 실행 환경 선택" onCancel={onClose}>
    <header><strong>실행 환경 선택</strong><button onClick={onClose}>닫기</button></header>
    <p className="nb-environment-folder">탐지 기준: {folder||path}</p>
    <p>Python 환경에 ipykernel이 설치되어 있어야 실행할 수 있습니다.</p>
    <input className="nb-environment-search" aria-label="실행 환경 검색" placeholder="환경 이름 또는 Python 경로 검색" value={query} onChange={e=>setQuery(e.target.value)}/>
    {record.operation&&<p role="status">선택한 환경에 연결 중…</p>}
    {loading&&<p role="status">실행 폴더의 환경을 찾는 중…</p>}
    {error&&<p role="alert">{error}</p>}
    <button disabled={loading} onClick={()=>setRetry(v=>v+1)}>다시 탐지</button>
    {!loading&&!error&&filtered.length===0&&<p role="status">검색 조건에 맞는 환경이 없습니다.</p>}
    {filtered.map(option=><section key={option.id}><div><strong>{option.name}{(record.server.environment||'default')===option.id?(record.server.kernel?' · 연결됨':' · 선택됨'):''}</strong><small>{option.source}</small><small>{option.python}</small></div><button disabled={!!record.operation||record.pending} onClick={()=>void choose(option)}>{record.server.kernel&&record.server.environment===option.id?'연결됨':'선택 및 연결'}</button></section>)}
  </dialog>,document.body)
}
