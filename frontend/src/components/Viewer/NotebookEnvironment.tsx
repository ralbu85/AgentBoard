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
  useEffect(()=>{dialog.current?.showModal()},[])
  useEffect(()=>{
    let alive=true;setLoading(true);setError('')
    void notebookEnvironments(path).then(data=>{if(alive){setOptions(data.environments);setFolder(data.folder)}}).catch(e=>{if(alive)setError(e.message)}).finally(()=>{if(alive)setLoading(false)})
    return()=>{alive=false}
  },[path,retry])
  const choose=async(option:Environment)=>{
    setError('')
    try{await notebookAction(path,'select-environment',undefined,option.id);onClose()}catch(e){setError(e instanceof Error?e.message:'선택 실패')}
  }
  return createPortal(<dialog ref={dialog} className="nb-kernel-dialog" aria-label="노트북 실행 환경 선택" onCancel={onClose}>
    <header><strong>실행 환경 선택</strong><button onClick={onClose}>닫기</button></header>
    <p className="nb-environment-folder">탐지 기준: {folder||path}</p>
    <p>Python 환경에 ipykernel이 설치되어 있어야 실행할 수 있습니다.</p>
    {record.server.kernel&&<p>커널 종료 후 환경을 변경할 수 있습니다. 기존 변수는 종료되며 코드와 출력은 유지됩니다.</p>}
    {loading&&<p role="status">실행 폴더의 환경을 찾는 중…</p>}
    {error&&<p role="alert">{error}</p>}
    <button disabled={loading} onClick={()=>setRetry(v=>v+1)}>다시 탐지</button>
    {options.map(option=><section key={option.id}><div><strong>{option.name}{(record.server.environment||'default')===option.id?' · 선택됨':''}</strong><small>{option.source}</small><small>{option.python}</small></div><button disabled={!!record.operation||record.pending||record.server.kernel} onClick={()=>void choose(option)}>선택</button></section>)}
  </dialog>,document.body)
}
