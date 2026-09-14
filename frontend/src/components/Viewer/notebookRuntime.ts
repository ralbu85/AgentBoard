import {create} from 'zustand'

export type NotebookState={id:string;path:string;content:string;version:string;revision:number;dirty:boolean;state:string;cell:number|null;error:string;kernel:boolean;python:string}
type RecordState={server:NotebookState;content:string;error:string;pending:boolean;conflict?:boolean}
export const useNotebooks=create<{records:Record<string,RecordState>}>(()=>({records:{}}))
const openings=new Map<string,Promise<void>>()
const queues=new Map<string,Promise<unknown>>()
const timers=new Map<string,ReturnType<typeof setTimeout>>()
export const notebookBusy=(state?:string)=>['starting','running','interrupting','stopping'].includes(state||'')
const current=(path:string)=>useNotebooks.getState().records[path]
function patch(path:string,changes:Partial<RecordState>){useNotebooks.setState(s=>({records:{...s.records,[path]:{...s.records[path],...changes}}}))}
async function request(url:string,body?:object,method='POST'){
  const response=await fetch('/api/notebooks'+url,body?{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined)
  const data=await response.json()
  if(!response.ok)throw Object.assign(Error(typeof data.detail==='string'?data.detail:`노트북 요청 실패 (${response.status})`),{status:response.status})
  return data
}
function accept(path:string,server:NotebookState,submitted?:string){
  const record=current(path)
  const replace=!record||record.content===record.server.content||record.content===submitted
  if(!replace&&server.content!==record.server.content&&!submitted){
    patch(path,{conflict:true,error:'다른 화면에서 내용이 변경되었습니다. 현재 초안을 다운로드한 뒤 서버 상태를 불러오세요.'})
    return
  }
  patch(path,{server,content:replace?server.content:record.content,error:'',conflict:false})
}
export async function openNotebook(path:string,content:string,dirty:boolean){
  if(current(path))return
  if(openings.has(path))return openings.get(path)
  const opening=(async()=>{
    const server=await request('/open',{path})
    accept(path,server)
    if(dirty&&content!==server.content)editNotebook(path,content)
  })().finally(()=>openings.delete(path))
  openings.set(path,opening)
  return opening
}
function queue<T>(path:string,action:()=>Promise<T>):Promise<T>{
  const next=(queues.get(path)||Promise.resolve()).catch(()=>{}).then(async()=>{
    patch(path,{pending:true})
    try{return await action()}catch(error){patch(path,{error:error instanceof Error?error.message:'연결 실패'});throw error}
    finally{patch(path,{pending:false})}
  })
  queues.set(path,next)
  // Attach a handler immediately, including for delayed autosync failures.
  void next.catch(()=>{})
  return next
}
async function flush(path:string){
  const record=current(path)
  if(record.conflict)throw Error(record.error||'서버 상태를 먼저 확인하세요.')
  if(record.content===record.server.content)return
  const submitted=record.content
  const server=await request('/'+record.server.id,{revision:record.server.revision,content:submitted},'PUT')
  accept(path,server,submitted)
}
export function editNotebook(path:string,content:string){
  patch(path,{content,...(!current(path).conflict?{error:''}:{})})
  clearTimeout(timers.get(path))
  timers.set(path,setTimeout(()=>{timers.delete(path);void queue(path,()=>flush(path)).catch(()=>{})},500))
}
export async function refreshNotebook(path:string){
  const record=current(path)
  if(!record||record.pending||record.conflict)return
  const before=record.server.revision
  try{
    const server=await request(`/${record.server.id}?since=${before}`)
    if(!server.unchanged&&current(path)?.server.revision===before&&!current(path)?.pending)accept(path,server)
  }catch(error){
    if((error as {status?:number}).status===404){
      try{const server=await request('/open',{path});if(!current(path)?.pending)accept(path,server)}
      catch(e){patch(path,{error:e instanceof Error?e.message:'연결 실패'})}
    }else patch(path,{error:error instanceof Error?error.message:'연결 실패'})
  }
}
export function notebookAction(path:string,action:string,cell?:number){
  clearTimeout(timers.get(path));timers.delete(path)
  return queue(path,async()=>{
    if(!['interrupt','shutdown','reload'].includes(action)){
      do{await flush(path)}while(current(path).content!==current(path).server.content)
    }
    const record=current(path)
    const server=await request('/'+record.server.id+'/action',{action,revision:record.server.revision,cell})
    accept(path,server,action==='reload'?record.content:undefined)
    return server as NotebookState
  })
}
export async function loadServerNotebook(path:string){
  clearTimeout(timers.get(path));timers.delete(path)
  return queue(path,async()=>{
    const record=current(path)
    const server=await request('/open',{path})
    accept(path,server,record.content)
  })
}
export const listNotebookKernels=()=>request('')
export async function stopNotebookKernel(id:string){
  const server=await request('/'+id+'/action',{action:'shutdown',revision:0})
  if(current(server.path))accept(server.path,server)
}
