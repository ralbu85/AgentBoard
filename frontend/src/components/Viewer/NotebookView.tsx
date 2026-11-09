import {api} from '../../api'
import {useToasts} from '../../toasts'
import {NotebookCellInsert} from './NotebookCellInsert'
import { useState, useEffect, useMemo, useRef } from 'react'
import { renderMarkdown, type MarkdownAttachments } from '../../markdown'
import { sanitize } from '../../sanitize'
import { getHljs } from './FileContent'
import {useStore, type ViewerTab} from '../../store'
import {uiId} from '../../uiId'
import {NotebookEnvironment} from './NotebookEnvironment'
import {NotebookMarkdownCell} from './NotebookMarkdownCell'
import {CodeEditor} from './CodeEditor'
import {NotebookKernels,kernelStateLabel} from './NotebookKernels'
import {useNotebooks, openNotebook, editNotebook, refreshNotebook, notebookAction, notebookBusy, loadServerNotebook, checkNotebookFile, autosaveNotebook} from './notebookRuntime'
import {DocBanner, ModeSwitch, SaveBadge, useDocMode, type DocEdit} from './DocSurface'
import {MOD, SAVE_DELAY, type SaveState} from './docSync'
import {writeClipboard} from '../Terminal/clipboard'

// Read-only Jupyter notebook renderer (nbformat 4; minimal v3 fallback).
// Cells render defensively — a malformed cell degrades to plain text, never throws.

interface NbOutput {
  output_type: string
  name?: string                              // stream: stdout | stderr
  text?: string | string[]                   // stream
  data?: Record<string, unknown>             // execute_result / display_data
  execution_count?: number | null
  ename?: string; evalue?: string; traceback?: string[]  // error
}
interface NbCell {
  cell_type: string
  attachments?: MarkdownAttachments
  source?: string | string[]
  input?: string | string[]                  // nbformat 3
  outputs?: NbOutput[]
  execution_count?: number | null
  prompt_number?: number | null              // nbformat 3
}

const joinSrc = (s: unknown): string => Array.isArray(s) ? s.join('') : typeof s === 'string' ? s : ''
// Jupyter tracebacks/streams carry ANSI color codes — strip for plain rendering
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

function parseNotebook(content: string): { cells: NbCell[]; lang: string } | { error: string } {
  let nb: any
  try { nb = JSON.parse(content) } catch { return { error: 'JSON 파싱에 실패했습니다 — 손상된 .ipynb 파일입니다.' } }
  const cells = nb?.cells ?? nb?.worksheets?.[0]?.cells   // v4 / v3
  if (!Array.isArray(cells)) return { error: '지원하지 않는 notebook 형식입니다.' }
  const lang = nb?.metadata?.kernelspec?.language || nb?.metadata?.language_info?.name || 'python'
  return { cells, lang }
}

export function NotebookView({tab,ownerKey}:{tab:ViewerTab;ownerKey:string}) {
  const record=useNotebooks(s=>s.records[tab.path])
  const [error,setError]=useState('')
  const [copying,setCopying]=useState(false)
  const [openRetry,setOpenRetry]=useState(0)
  const [kernels,setKernels]=useState(false)
  const [environmentOpen,setEnvironmentOpen]=useState(false)
  const [now,setNow]=useState(Date.now())
  // 보기 reads, 편집 edits markdown cells where they are rendered, 소스 shows every markdown cell's markdown.
  const [mode,setMode]=useDocMode('notebook',['view','edit','source'])
  const editing=mode==='edit', raw=mode==='source'
  useEffect(()=>{if(!record?.operation&&!notebookBusy(record?.server.state))return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer)},[record?.operation,record?.server.state])
  const local=JSON.parse(ownerKey)[0]==='local'
  const supported=useMemo(()=>{try{const nb=JSON.parse(tab.content);return nb.nbformat===4&&Array.isArray(nb.cells)}catch{return false}},[tab.content])
  // Parsed once per change, so a cell's attachments keep their identity between polls.
  const notebook=useMemo(()=>{try{return record?JSON.parse(record.content):null}catch{return null}},[record?.content])
  // An open markdown-cell editor holds disk loads and undo, as in a file tab.
  const holds=useRef(new Map<string,()=>boolean>())
  const held=()=>[...holds.current.values()].some(paused=>paused())
  const undoSteps=useRef<{id?:string;index:number;before:string;after:string}[]>([])
  const [undoCount,setUndoCount]=useState(0)
  useEffect(()=>{
    const duplicate=async()=>{
    if(copying||!record||record.operation||notebookBusy((record.observed||record.server).state))return
    const content=record.content
    setCopying(true);setError('')
    try{
      const dir=tab.path.slice(0,tab.path.lastIndexOf('/'))||'/'
      const stem=tab.name.replace(/\.ipynb$/i,'')
      const listing=await api.files(dir)
      const names=new Set((listing.entries||[]).map((entry:{name:string})=>entry.name))
      let suggested=`${stem}-copy.ipynb`,number=2
      while(names.has(suggested))suggested=`${stem}-copy-${number++}.ipynb`
      const answer=prompt('복사본 파일 이름 (현재 편집 내용과 출력 포함)',suggested)
      if(answer===null)return
      let name=answer.trim()
      if(!name||/[\/\\\x00]/.test(name)||name==='.'||name==='..')throw Error('폴더 경로 없이 파일 이름을 입력하세요.')
      if(!/\.ipynb$/i.test(name))name+='.ipynb'
      const result=await api.upload(dir,new File([content],name,{type:'application/x-ipynb+json'}))
      if(!result.ok||!result.path)throw Error(result.error||'복사본을 만들지 못했습니다.')
      useStore.getState().openTab({id:result.path,path:result.path,name,content,type:'notebook',lang:'json',dirty:false},ownerKey)
      useToasts.getState().push(`복사본 생성: ${name}`)
    }catch(e){setError(e instanceof Error?e.message:'복사 실패')}
    finally{setCopying(false)}
  }
  if(!local||!supported)return
    let alive=true
    void openNotebook(tab.path,tab.content,!!tab.dirty).then(()=>{if(alive)setError('');return refreshNotebook(tab.path)}).catch(e=>{if(alive)setError(e.message)})
    const timer=setInterval(()=>void refreshNotebook(tab.path),700)
    return()=>{alive=false;clearInterval(timer)}
  },[tab.path,local,supported,openRetry])
  useEffect(()=>{
    if(!record||!local)return
    const check=()=>{if(document.visibilityState!=='hidden')void checkNotebookFile(tab.path)}
    check();const timer=setInterval(check,1000)
    window.addEventListener('focus',check)
    return()=>{clearInterval(timer);window.removeEventListener('focus',check)}
  },[!!record,local,tab.path])
  useEffect(()=>{
    if(!record||!local)return
    const store=useStore.getState()
    const current=store._viewerState[ownerKey]?.tabs.find(t=>t.id===tab.id)
    if(!current)return
    if(current.content!==record.content)store.updateTab(tab.id,record.content,ownerKey)
    if(!record.server.dirty&&record.content===record.server.content)store.markTabSaved(tab.id,record.content,record.server.version,ownerKey)
  },[record?.content,record?.server.dirty,record?.server.version,tab.id,ownerKey,local])
  // Same policy as every file tab: edits (and a finished run's outputs) save
  // themselves once things settle; a disk change loads by itself unless it
  // would drop unsaved work or a connected kernel's variables.
  const unsaved=!!record&&(record.server.dirty||record.content!==record.server.content)
  const quiet=!!record&&!record.operation&&!record.pending&&!record.conflict&&!notebookBusy((record.observed||record.server).state)
  useEffect(()=>{
    if(!local||!unsaved||!quiet||record?.fileChanged)return
    const timer=setTimeout(()=>void autosaveNotebook(tab.path),SAVE_DELAY)
    return()=>clearTimeout(timer)
  },[local,unsaved,quiet,record?.fileChanged,record?.content,record?.server.revision,tab.path])
  useEffect(()=>{
    if(!local||!record?.fileChanged||unsaved||record.server.kernel||!quiet)return
    let timer=0
    const load=()=>{
      if(held()){timer=window.setTimeout(load,1000);return}
      void notebookAction(tab.path,'reload').then(()=>checkNotebookFile(tab.path,true)).catch(()=>{})
    }
    load()
    return()=>clearTimeout(timer)
  },[local,record?.fileChanged,unsaved,record?.server.kernel,quiet,tab.path])
  useEffect(()=>()=>{void autosaveNotebook(tab.path)},[tab.path])
  const run=async(action:string,cell?:number)=>{setError('');try{await notebookAction(tab.path,action,cell)}catch(e){setError(e instanceof Error?e.message:'실패')}}
  const download=()=>{
    const blob=new Blob([record?.content||tab.content],{type:'application/x-ipynb+json'})
    const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=tab.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
  }
  const duplicate=async()=>{
    if(copying||!record||record.operation||notebookBusy((record.observed||record.server).state))return
    const content=record.content
    setCopying(true);setError('')
    try{
      const dir=tab.path.slice(0,tab.path.lastIndexOf('/'))||'/'
      const stem=tab.name.replace(/\.ipynb$/i,'')
      const listing=await api.files(dir)
      const names=new Set((listing.entries||[]).map((entry:{name:string})=>entry.name))
      let suggested=`${stem}-copy.ipynb`,number=2
      while(names.has(suggested))suggested=`${stem}-copy-${number++}.ipynb`
      const answer=prompt('복사본 파일 이름 (현재 편집 내용과 출력 포함)',suggested)
      if(answer===null)return
      let name=answer.trim()
      if(!name||/[\/\\\x00]/.test(name)||name==='.'||name==='..')throw Error('폴더 경로 없이 파일 이름을 입력하세요.')
      if(!/\.ipynb$/i.test(name))name+='.ipynb'
      const result=await api.upload(dir,new File([content],name,{type:'application/x-ipynb+json'}))
      if(!result.ok||!result.path)throw Error(result.error||'복사본을 만들지 못했습니다.')
      useStore.getState().openTab({id:result.path,path:result.path,name,content,type:'notebook',lang:'json',dirty:false},ownerKey)
      useToasts.getState().push(`복사본 생성: ${name}`)
    }catch(e){setError(e instanceof Error?e.message:'복사 실패')}
    finally{setCopying(false)}
  }
  if(!local||!supported)return <><div className="nb-runtime-bar">{!local?'원격 머신의 노트북은 현재 읽기만 지원합니다.':'실행·편집은 nbformat 4 노트북에서 지원합니다.'}</div><NotebookPreview content={tab.content} filePath={local?tab.path:undefined}/></>
  if(!record)return <div className="nb-runtime-bar" role="status">{error||'노트북 연결 중…'}{error&&<button onClick={()=>{setError('');setOpenRetry(v=>v+1)}}>다시 연결</button>}</div>
  const state=record.observed||record.server
  const busy=notebookBusy(state.state), disabled=busy||!!record.operation||copying
  const operation=record.operation
  const actionText=operation?({'connect-environment':'선택한 환경에 연결 중…','select-environment':'실행 환경 선택 중…',connect:'커널 연결 중…',execute:`셀 ${(operation.cell??0)+1} 실행 준비 중…`,'run-all':'전체 실행 준비 중…','run-to-cell':`셀 ${(operation.cell??0)+1}까지 실행 준비 중…`,interrupt:'실행 중단 요청 중…',restart:'커널 재시작 중…',shutdown:'커널 종료 중…',reset:'노트북 초기화 중…',save:'결과 저장 중…',reload:'원본 불러오는 중…'} as Record<string,string>)[operation.action]:''
  const statusText=(copying?'복사본 만드는 중…':actionText)||(busy?`${kernelStateLabel(state.state)}${state.cell!==null?` · 셀 ${state.cell+1}`:''}`:record.notice||kernelStateLabel(state.state))
  if(!notebook)return <div className="nb-runtime-bar" role="alert">노트북 내용을 읽지 못했습니다.</div>
  const change=(index:number,source:string)=>{const nb=JSON.parse(record.content);nb.cells[index].source=source;editNotebook(tab.path,JSON.stringify(nb,null,1)+'\n')}
  const add=(kind:string,index=notebook.cells.length)=>{
    const nb=JSON.parse(record.content);nb.cells.splice(index,0,{id:uiId(),cell_type:kind,metadata:{},source:'',...(kind==='code'?{execution_count:null,outputs:[]}:{} )});editNotebook(tab.path,JSON.stringify(nb,null,1)+'\n')
  }
  // Edits made where a markdown cell is rendered: each is one undo step and saves at once.
  type Cell=NbCell&{id?:string}
  const latest=()=>JSON.parse(useNotebooks.getState().records[tab.path].content)
  const findCell=(nb:{cells:Cell[]},id:string|undefined,index:number)=>id?nb.cells.find(c=>c.id===id):nb.cells[index]
  const writeCell=(nb:{cells:Cell[]},cell:Cell,source:string)=>{cell.source=source;editNotebook(tab.path,JSON.stringify(nb,null,1)+'\n');void autosaveNotebook(tab.path)}
  const toast=(text:string)=>useToasts.getState().push(text)
  const editCell=(id:string|undefined,index:number,base:string,next:string)=>{
    // Only an editor left open as a run started gets here: keep its typing.
    if(disabled){void writeClipboard(next).catch(()=>{});toast('노트북이 작업 중이라 셀을 고치지 못했습니다. 입력한 내용은 클립보드에 복사했습니다.');return}
    const nb=latest(),cell=findCell(nb,id,index)
    if(!cell||joinSrc(cell.source)!==base)return
    undoSteps.current.push({id,index,before:base,after:next})
    if(undoSteps.current.length>50)undoSteps.current.shift()
    setUndoCount(undoSteps.current.length)
    writeCell(nb,cell,next)
  }
  const undo=()=>{
    if(disabled||held())return
    const step=undoSteps.current.pop()
    setUndoCount(undoSteps.current.length)
    if(!step)return
    const nb=latest(),cell=findCell(nb,step.id,step.index)
    if(!cell||joinSrc(cell.source)!==step.after){toast('그 뒤에 셀이 다시 바뀌어 되돌리지 않았습니다.');return}
    writeCell(nb,cell,step.before)
  }
  const cellDoc=(cell:Cell,index:number):DocEdit=>{
    const key=cell.id||String(index)
    return {
      writable:!disabled,editing:editing&&!disabled,
      current:()=>joinSrc(findCell(latest(),cell.id,index)?.source),
      apply:(base,next)=>editCell(cell.id,index,base,next),
      undo,
      setPaused:paused=>{if(paused)holds.current.set(key,paused);else holds.current.delete(key)},
      reread:()=>checkNotebookFile(tab.path,true),
    }
  }
  const dirty=record.server.dirty||record.content!==record.server.content
  const reloadFile=()=>{
    const consequences=[dirty?'저장하지 않은 편집·실행 결과는 원본 파일 내용으로 교체됩니다.':'',record.server.kernel?'연결된 커널이 종료되어 Python 변수는 초기화됩니다.':''].filter(Boolean)
    if(consequences.length&&!confirm(consequences.join('\n')+'\n계속 새로고침할까요? 필요한 내용은 먼저 다운로드하세요.'))return
    void run('reload').then(()=>checkNotebookFile(tab.path,true))
  }
  const saveState:SaveState=record.fileChanged&&dirty?'conflict':record.pending&&dirty?'saving':dirty?'pending':'saved'
  return <div className="nb-interactive" tabIndex={-1} onKeyDown={e=>{
    if(!editing||!(e.ctrlKey||e.metaKey)||e.shiftKey||e.key.toLowerCase()!=='z'||(e.target as HTMLElement).closest('textarea, input, .cm-editor, [contenteditable]'))return
    e.preventDefault();undo()
  }}>
    <div className="nb-head">
    <div className="doc-toolbar">
      <ModeSwitch modes={['view','edit','source']} mode={mode} onChange={setMode}
        titles={{view:'읽기만 합니다. 마크다운 셀을 클릭해도 고쳐지지 않습니다',source:'마크다운 셀을 모두 원문으로 봅니다'}}/>
      {editing&&<button className="doc-tool" disabled={!undoCount||disabled} onClick={undo} title={`마크다운 셀에서 한 수정 되돌리기 (${MOD}+Z)`}>↶ 되돌리기</button>}
      <div className="doc-extras">
        <div className="nb-live-status" role="status" aria-live="polite" aria-busy={busy||!!operation||copying}>
          <span className={`nb-spinner ${busy||operation||copying?'':'nb-spinner-idle'}`} aria-hidden="true"/>
          <strong title={record.server.python}>{state.kernelName||'Python'} · {statusText}</strong>
          {operation&&<span>{Math.max(0,Math.floor((now-operation.started)/1000))}초</span>}
          {operation&&state.state==='starting'&&<span>Python 커널을 시작하고 있습니다.</span>}
          {(error||record.error||record.connectionError||record.server.error)&&<span className="nb-status-error">{error||record.error||record.connectionError||record.server.error}</span>}
        </div>
      </div>
      <SaveBadge state={saveState}/>
    </div>
    <div className="nb-runtime-bar">
      <div className="nb-toolbar-actions">
        {record.server.environment!==undefined&&<button title={record.server.python} onClick={()=>setEnvironmentOpen(true)}>환경: {record.server.kernelName||'Python · 서버 기본'} ▾</button>}
        <button disabled={disabled||record.server.kernel} onClick={()=>void run('connect')}>{operation?.action==='connect'?'연결 중…':'커널 연결'}</button>
        <button disabled={disabled} onClick={()=>void run('run-all')}>{operation?.action==='run-all'?'실행 준비 중…':'전체 실행'}</button>
        <button disabled={!!operation||!['running','interrupting'].includes(state.state)} onClick={()=>void run('interrupt')}>■ 중단</button>
        <button disabled={disabled||!record.server.kernel} onClick={()=>{if(confirm('커널을 재시작할까요? 메모리의 변수는 초기화되고 셀과 출력은 유지됩니다.'))void run('restart')}}>재시작</button>
        <button disabled={disabled} title="코드와 마크다운은 유지하고 출력·실행 번호·커널 변수를 초기화합니다." onClick={()=>{if(confirm('노트북을 초기화할까요?\n코드와 마크다운은 유지합니다. 모든 출력·실행 번호와 커널 변수는 지워집니다.\n초기화한 결과는 자동으로 저장됩니다.'))void run('reset')}}>노트북 초기화</button>
        <button disabled={record.pending||!record.server.kernel} onClick={()=>{if(confirm('이 노트북의 커널을 종료할까요? 실행 중인 작업과 변수는 종료됩니다.'))void run('shutdown')}}>커널 종료</button>
        <button disabled={disabled} onClick={()=>void duplicate()}>복사본 만들기</button>
        <button onClick={download}>다운로드</button>
        <button onClick={()=>setKernels(true)}>커널 목록</button>
      </div>
    </div>
    {record.fileChanged&&<DocBanner>
      <span>{dirty?'이 탭의 수정과 디스크의 파일이 둘 다 바뀌어 자동 저장을 멈췄습니다. 필요한 내용은 다운로드한 뒤 불러오세요.':'디스크의 파일이 바뀌었습니다. 불러오면 연결된 커널이 종료되어 변수가 초기화됩니다.'}</span>
      <button className="doc-tool" disabled={disabled} onClick={reloadFile}>{operation?.action==='reload'?'불러오는 중…':'디스크 버전 불러오기'}</button>
      {dirty&&<button className="doc-tool" onClick={download}>이 탭 내용 다운로드</button>}
      {busy&&<small>실행을 중단하거나 완료한 뒤 불러올 수 있습니다.</small>}
    </DocBanner>}
    {record.fileCheckError&&<DocBanner><span>{record.fileCheckError}</span><button className="doc-tool" disabled={record.fileChecking} onClick={()=>void checkNotebookFile(tab.path,true)}>다시 확인</button></DocBanner>}
    </div>
    {(error||record.error||record.connectionError||record.server.error)&&<div className="nb-runtime-error" role="alert">{error||record.error||record.connectionError||record.server.error}<button disabled={record.pending} onClick={()=>{if(confirm('이 화면의 편집 초안을 서버 상태로 바꿀까요? 필요한 내용은 먼저 다운로드하세요.'))void loadServerNotebook(tab.path).then(()=>setError('')).catch(e=>setError(e.message))}}>서버 상태 불러오기</button></div>}
    {environmentOpen&&<NotebookEnvironment path={tab.path} onClose={()=>setEnvironmentOpen(false)}/>}
    {kernels&&<NotebookKernels onClose={()=>setKernels(false)}/>}
    <div className="nb-wrap">
      {notebook.cells.length===0&&<div className="nb-cell-actions"><button disabled={disabled} onClick={()=>add('code')}>＋ 코드</button><button disabled={disabled} onClick={()=>add('markdown')}>＋ 마크다운</button></div>}
      {notebook.cells.map((cell:NbCell,index:number)=>cell.cell_type==='markdown'?<NotebookMarkdownCell key={(cell as NbCell&{id?:string}).id||index} insertControl={<NotebookCellInsert index={index} disabled={disabled} onInsert={add}/>} content={joinSrc(cell.source)} filePath={tab.path} attachments={cell.attachments} index={index} doc={cellDoc(cell,index)} raw={raw} editable={editing} onChange={source=>change(index,source)} onSave={()=>void autosaveNotebook(tab.path)} onDelete={()=>{if(!confirm(`셀 ${index+1}을 삭제할까요?`))return;const nb=JSON.parse(record.content);nb.cells.splice(index,1);editNotebook(tab.path,JSON.stringify(nb,null,1)+'\n')}}/>:<section className={`nb-edit-cell ${record.server.cell===index?'nb-cell-running':''}`} key={(cell as NbCell&{id?:string}).id||index}>
        <div className="nb-cell-actions"><span>{cell.cell_type==='code'?`In [${record.server.cell===index?'*':cell.execution_count??' '}]`:'Markdown'} · 셀 {index+1}</span>
          {cell.cell_type==='code'&&<button disabled={disabled} title="셀 실행 (Ctrl+Enter / Shift+Enter)" onClick={()=>void run('execute',index)}>{operation?.action==='execute'&&operation.cell===index?'실행 준비 중…':state.cell===index&&busy?'실행 중…':'▶ 셀 실행'}</button>}
          {cell.cell_type==='code'&&<button disabled={disabled} title={`첫 코드 셀부터 셀 ${index+1}까지 순서대로 실행합니다. 이미 실행한 셀도 다시 실행합니다.`} onClick={()=>void run('run-to-cell',index)}>여기까지 실행</button>}
          <button disabled={disabled} onClick={()=>{if(!confirm(`셀 ${index+1}을 삭제할까요?`))return;const nb=JSON.parse(record.content);nb.cells.splice(index,1);editNotebook(tab.path,JSON.stringify(nb,null,1)+'\n')}}>셀 삭제</button>
          <NotebookCellInsert index={index} disabled={disabled} onInsert={add}/>
        </div>
        <CodeEditor compact ariaLabel={`셀 ${index+1} 코드`} content={joinSrc(cell.source)} lang={cell.cell_type==='code'?'python':cell.cell_type==='markdown'?'markdown':''} readOnly={disabled} onChange={source=>change(index,source)} onSave={()=>void autosaveNotebook(tab.path)} onRun={cell.cell_type==='code'?()=>{if(!disabled)void run('execute',index)}:undefined}/>

        {(cell.outputs||[]).map((output,i)=><Output key={i} out={output}/>)}
      </section>)}
    </div>
  </div>
}

export function NotebookPreview({ content, filePath }: { content: string; filePath?: string }) {
  const parsed = useMemo(() => parseNotebook(content), [content])
  const [hljs, setHljs] = useState<any>(null)
  useEffect(() => { getHljs().then(setHljs).catch(() => {}) }, [])

  if ('error' in parsed) {
    return <div className="viewer-empty">{parsed.error}</div>
  }
  return (
    <div className="nb-wrap">
      {parsed.cells.map((cell, i) =>
        cell.cell_type === 'code'
          ? <CodeCell key={i} cell={cell} lang={parsed.lang} hljs={hljs} />
          : <TextCell key={i} cell={cell} filePath={filePath} />
      )}
    </div>
  )
}

/** markdown / raw cells */
function TextCell({ cell, filePath }: { cell: NbCell; filePath?: string }) {
  const src = joinSrc(cell.source ?? cell.input)
  const html = useMemo(
    () => cell.cell_type === 'markdown' ? renderMarkdown(src, filePath, cell.attachments) : '',
    [src, cell.cell_type, filePath, cell.attachments],
  )
  return (
    <div className="nb-cell">
      <div className="nb-gutter" />
      {cell.cell_type === 'markdown'
        ? <div className="nb-main md-rendered" dangerouslySetInnerHTML={{ __html: html }} />
        : <pre className="nb-main nb-raw">{src}</pre>}
    </div>
  )
}

function CodeCell({ cell, lang, hljs }: { cell: NbCell; lang: string; hljs: any }) {
  const src = joinSrc(cell.source ?? cell.input)
  const n = cell.execution_count ?? cell.prompt_number
  const html = useMemo(() => {
    if (hljs) {
      try {
        const l = hljs.getLanguage(lang) ? lang : 'python'
        return sanitize(hljs.highlight(src, { language: l }).value)
      } catch { /* fall through to escaped */ }
    }
    return src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }, [src, lang, hljs])

  return (
    <div className="nb-cell">
      <div className="nb-gutter nb-in">In&nbsp;[{n ?? ' '}]</div>
      <div className="nb-main">
        <pre className="nb-code hljs"><code dangerouslySetInnerHTML={{ __html: html }} /></pre>
        {(cell.outputs || []).map((out, i) => <Output key={i} out={out} />)}
      </div>
    </div>
  )
}

function Output({ out }: { out: NbOutput }) {
  if (out.output_type === 'stream') {
    return <pre className={`nb-stream ${out.name === 'stderr' ? 'nb-stderr' : ''}`}>{stripAnsi(joinSrc(out.text))}</pre>
  }
  if (out.output_type === 'error') {
    const tb = (out.traceback || []).map(t => stripAnsi(joinSrc(t))).join('\n')
    return <pre className="nb-error">{tb || `${out.ename ?? 'Error'}: ${out.evalue ?? ''}`}</pre>
  }
  // execute_result / display_data — pick the richest mime we can render safely
  const data = out.data || {}
  for (const mime of ['image/png', 'image/jpeg', 'image/gif']) {
    if (data[mime]) {
      return <img className="nb-img" src={`data:${mime};base64,${joinSrc(data[mime]).replace(/\n/g, '')}`} alt="" />
    }
  }
  if (data['image/svg+xml']) {
    // via <img> data-URI, never inline — an <img>-loaded SVG can't run scripts
    return <img className="nb-img nb-img-svg" src={`data:image/svg+xml;utf8,${encodeURIComponent(joinSrc(data['image/svg+xml']))}`} alt="" />
  }
  if (data['text/html']) {
    return <div className="nb-html" dangerouslySetInnerHTML={{ __html: sanitize(joinSrc(data['text/html'])) }} />
  }
  for (const mime of ['text/markdown', 'text/latex']) {
    if (data[mime]) {
      return <div className="nb-main md-rendered" dangerouslySetInnerHTML={{ __html: renderMarkdown(joinSrc(data[mime])) }} />
    }
  }
  if (data['application/json'] !== undefined) {
    const v = data['application/json']
    return <pre className="nb-stream">{typeof v === 'string' ? v : JSON.stringify(v, null, 2)}</pre>
  }
  if (data['text/plain']) {
    return <pre className="nb-stream">{stripAnsi(joinSrc(data['text/plain']))}</pre>
  }
  return null
}
