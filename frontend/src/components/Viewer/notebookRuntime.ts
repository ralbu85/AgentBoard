import {create} from 'zustand'

export type NotebookState={id:string;path:string;content:string;version:string;revision:number;dirty:boolean;state:string;cell:number|null;error:string;kernel:boolean;python:string;environment?:string;kernelName?:string}
type RecordState={server:NotebookState;content:string;error:string;pending:boolean;connectionError?:string;conflict?:boolean;operation?:{action:string;cell?:number;started:number};observed?:NotebookState;notice?:string}
export const useNotebooks=create<{records:Record<string,RecordState>}>(()=>({records:{}}))
const openings=new Map<string,Promise<void>>()
const queues=new Map<string,Promise<unknown>>()
const polling=new Set<string>()
const timers=new Map<string,ReturnType<typeof setTimeout>>()
export const notebookBusy=(state?:string)=>['starting','running','interrupting','stopping'].includes(state||'')
const current=(path:string)=>useNotebooks.getState().records[path]
function patch(path:string,changes:Partial<RecordState>){useNotebooks.setState(s=>({records:{...s.records,[path]:{...s.records[path],...changes}}}))}
async function request(url:string,body?:object,method='POST'){
  const controller=new AbortController()
  const timeout=setTimeout(()=>controller.abort(),35000)
  let response:Response, data:any
  try{
    response=await fetch('/api/notebooks'+url,{signal:controller.signal,...(body?{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})})
    data=await response.json()
  }catch(error){
    if(controller.signal.aborted)throw Error('서버 응답이 지연되고 있습니다. 요청한 작업은 서버에서 계속될 수 있습니다. 상태를 확인해 주세요.')
    throw error
  }finally{clearTimeout(timeout)}
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
  const finished=record?.server.state==='running'&&server.state==='idle'
  patch(path,{server,content:replace?server.content:record.content,error:'',connectionError:'',conflict:false,observed:undefined,...(finished?{notice:server.error?'실행 오류':'실행 완료'}:record?.server.state!==server.state?{notice:''}:{})})
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
  patch(path,{content,notice:'',...(!current(path).conflict?{error:''}:{})})
  clearTimeout(timers.get(path))
  timers.set(path,setTimeout(()=>{timers.delete(path);void queue(path,()=>flush(path)).catch(()=>{})},500))
}
export async function refreshNotebook(path:string){
  const record=current(path)
  if(!record||record.conflict||polling.has(path))return
  polling.add(path)
  const before=record.server.revision
  try{
    const server=await request(`/${record.server.id}?since=${before}`)
    patch(path,{connectionError:''})
    if(!server.unchanged&&current(path)?.server.revision===before){
      if(current(path)?.pending)patch(path,{observed:server})
      else accept(path,server)
    }
    const latest=current(path)
    if(!latest.pending&&!latest.operation&&!latest.conflict&&!notebookBusy(latest.server.state)&&latest.content!==latest.server.content){
      clearTimeout(timers.get(path));timers.delete(path)
      void queue(path,()=>flush(path)).catch(()=>{})
    }
  }catch(error){
    if((error as {status?:number}).status===404){
      try{const server=await request('/open',{path});if(!current(path)?.pending)accept(path,server)}
      catch(e){patch(path,{connectionError:e instanceof Error?e.message:'연결 실패'})}
    }else patch(path,{connectionError:error instanceof Error?error.message:'연결 실패'})
  }finally{polling.delete(path)}
}
export function notebookAction(path:string,action:string,cell?:number,environment?:string,replace=false){
  if(current(path).operation)return Promise.reject(Error('이전 요청을 처리 중입니다.'))
  patch(path,{operation:{action,cell,started:Date.now()},notice:'',error:'',observed:undefined})
  clearTimeout(timers.get(path));timers.delete(path)
  return queue(path,async()=>{
    if(!['interrupt','shutdown','reload'].includes(action)&&!(action==='connect-environment'&&notebookBusy(current(path).server.state))){
      do{await flush(path)}while(current(path).content!==current(path).server.content)
    }
    const record=current(path)
    const server=await request('/'+record.server.id+'/action',{action,revision:record.server.revision,cell,environment,replace})
    accept(path,server,action==='reload'?record.content:undefined)
    patch(path,{notice:({'connect-environment':'선택한 환경에 연결 완료','select-environment':'실행 환경 선택 완료',connect:'커널 연결 완료',save:'저장 완료',restart:'커널 재시작 완료',shutdown:'커널 종료 완료',interrupt:'중단 완료',reload:'원본 불러오기 완료'} as Record<string,string>)[action]||''})
    return server as NotebookState
  }).finally(()=>patch(path,{operation:undefined,observed:undefined}))
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

export const notebookEnvironments=(path:string)=>request(`/${current(path).server.id}/environments`)
