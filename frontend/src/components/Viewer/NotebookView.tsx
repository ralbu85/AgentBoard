import { useState, useEffect, useMemo } from 'react'
import { renderMarkdown } from '../../markdown'
import { sanitize } from '../../sanitize'
import { getHljs } from './FileContent'
import {useStore, type ViewerTab} from '../../store'
import {uiId} from '../../uiId'
import {NotebookEnvironment} from './NotebookEnvironment'
import {CodeEditor} from './CodeEditor'
import {NotebookKernels,kernelStateLabel} from './NotebookKernels'
import {useNotebooks, openNotebook, editNotebook, refreshNotebook, notebookAction, notebookBusy, loadServerNotebook} from './notebookRuntime'

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
  const [kernels,setKernels]=useState(false)
  const [environmentOpen,setEnvironmentOpen]=useState(false)
  const [now,setNow]=useState(Date.now())
  useEffect(()=>{if(!record?.operation&&!notebookBusy(record?.server.state))return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer)},[record?.operation,record?.server.state])
  const local=JSON.parse(ownerKey)[0]==='local'
  const supported=useMemo(()=>{try{const nb=JSON.parse(tab.content);return nb.nbformat===4&&Array.isArray(nb.cells)}catch{return false}},[tab.content])
  useEffect(()=>{
    if(!local||!supported)return
    let alive=true
    void openNotebook(tab.path,tab.content,!!tab.dirty).then(()=>refreshNotebook(tab.path)).catch(e=>{if(alive)setError(e.message)})
    const timer=setInterval(()=>void refreshNotebook(tab.path),700)
    return()=>{alive=false;clearInterval(timer)}
  },[tab.path,local,supported])
  useEffect(()=>{
    if(!record||!local)return
    const store=useStore.getState()
    const current=store._viewerState[ownerKey]?.tabs.find(t=>t.id===tab.id)
    if(!current)return
    if(current.content!==record.content)store.updateTab(tab.id,record.content,ownerKey)
    if(!record.server.dirty&&record.content===record.server.content)store.markTabSaved(tab.id,record.content,record.server.version,ownerKey)
  },[record?.content,record?.server.dirty,record?.server.version,tab.id,ownerKey,local])
  const run=async(action:string,cell?:number)=>{setError('');try{await notebookAction(tab.path,action,cell)}catch(e){setError(e instanceof Error?e.message:'실패')}}
  const download=()=>{
    const blob=new Blob([record?.content||tab.content],{type:'application/x-ipynb+json'})
    const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=tab.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
  }
  if(!local||!supported)return <><div className="nb-runtime-bar">{!local?'원격 머신의 노트북은 현재 읽기만 지원합니다.':'실행·편집은 nbformat 4 노트북에서 지원합니다.'}</div><NotebookPreview content={tab.content}/></>
  if(!record)return <div className="nb-runtime-bar" role="status">{error||'노트북 연결 중…'}</div>
  const state=record.observed||record.server
  const busy=notebookBusy(state.state), disabled=busy||record.pending||!!record.operation
  const operation=record.operation
  const actionText=operation?({'connect-environment':'선택한 환경에 연결 중…','select-environment':'실행 환경 선택 중…',connect:'커널 연결 중…',execute:`셀 ${(operation.cell??0)+1} 실행 준비 중…`,'run-all':'전체 실행 준비 중…',interrupt:'실행 중단 요청 중…',restart:'커널 재시작 중…',shutdown:'커널 종료 중…',save:'결과 저장 중…',reload:'원본 불러오는 중…'} as Record<string,string>)[operation.action]:''
  const statusText=actionText||(busy?`${kernelStateLabel(state.state)}${state.cell!==null?` · 셀 ${state.cell+1}`:''}`:record.pending?'편집 동기화 중…':record.notice||kernelStateLabel(state.state))
  const notebook=JSON.parse(record.content)
  const change=(index:number,source:string)=>{const nb=JSON.parse(record.content);nb.cells[index].source=source;editNotebook(tab.path,JSON.stringify(nb,null,1)+'\n')}
  const add=(kind:string)=>{
    const nb=JSON.parse(record.content);nb.cells.push({id:uiId(),cell_type:kind,metadata:{},source:'',...(kind==='code'?{execution_count:null,outputs:[]}:{} )});editNotebook(tab.path,JSON.stringify(nb,null,1)+'\n')
  }
  const dirty=record.server.dirty||record.content!==record.server.content
  return <div className="nb-interactive">
    <div className="nb-runtime-bar">
      <div className="nb-live-status" role="status" aria-live="polite" aria-busy={busy||!!operation}>
        {(busy||operation||record.pending)&&<span className="nb-spinner" aria-hidden="true"/>}
        <strong title={record.server.python}>{state.kernelName||'Python'} · {statusText}</strong>
        {operation&&<span>{Math.max(0,Math.floor((now-operation.started)/1000))}초</span>}
        {operation&&state.state==='starting'&&<span>Python 커널을 시작하고 있습니다.</span>}
        {(error||record.error||record.server.error)&&<span className="nb-status-error">{error||record.error||record.server.error}</span>}
      </div>
{record.server.environment!==undefined&&<button title={record.server.python} onClick={()=>setEnvironmentOpen(true)}>환경: {record.server.kernelName||'Python · 서버 기본'} ▾</button>}
      <button disabled={disabled||record.server.kernel} onClick={()=>void run('connect')}>{operation?.action==='connect'?'연결 중…':'커널 연결'}</button>
      <button disabled={disabled} onClick={()=>void run('run-all')}>{operation?.action==='run-all'?'실행 준비 중…':'전체 실행'}</button>
      <button disabled={!!operation||!['running','interrupting'].includes(state.state)} onClick={()=>void run('interrupt')}>■ 중단</button>
      <button disabled={disabled||!record.server.kernel} onClick={()=>{if(confirm('커널을 재시작할까요? 메모리의 변수는 초기화되고 셀과 출력은 유지됩니다.'))void run('restart')}}>재시작</button>
      <button disabled={record.pending||!record.server.kernel} onClick={()=>{if(confirm('이 노트북의 커널을 종료할까요? 실행 중인 작업과 변수는 종료됩니다.'))void run('shutdown')}}>커널 종료</button>
      <button disabled={disabled||!dirty} onClick={()=>void run('save')}>{dirty?'저장 · 변경 있음':'저장됨'}</button>
      <button onClick={download}>다운로드</button>
      <button onClick={()=>setKernels(true)}>커널 목록</button>
      <button disabled={disabled} onClick={()=>{if(confirm('저장하지 않은 편집·출력을 버리고 디스크 원본을 다시 열까요? 커널 변수도 초기화됩니다.'))void run('reload')}}>원본 다시 열기</button>
    </div>
    {(error||record.error||record.server.error)&&<div className="nb-runtime-error" role="alert">{error||record.error||record.server.error}<button disabled={record.pending} onClick={()=>{if(confirm('이 화면의 편집 초안을 서버 상태로 바꿀까요? 필요한 내용은 먼저 다운로드하세요.'))void loadServerNotebook(tab.path).then(()=>setError('')).catch(e=>setError(e.message))}}>서버 상태 불러오기</button></div>}
    {environmentOpen&&<NotebookEnvironment path={tab.path} onClose={()=>setEnvironmentOpen(false)}/>}
    {kernels&&<NotebookKernels onClose={()=>setKernels(false)}/>}
    <div className="nb-wrap">
      {notebook.cells.map((cell:NbCell,index:number)=><section className={`nb-edit-cell ${record.server.cell===index?'nb-cell-running':''}`} key={(cell as NbCell&{id?:string}).id||index}>
        <div className="nb-cell-actions"><span>{cell.cell_type==='code'?`In [${record.server.cell===index?'*':cell.execution_count??' '}]`:'Markdown'} · 셀 {index+1}</span>
          {cell.cell_type==='code'&&<button disabled={disabled} onClick={()=>void run('execute',index)}>{operation?.action==='execute'&&operation.cell===index?'실행 준비 중…':state.cell===index&&busy?'실행 중…':'▶ 셀 실행'}</button>}
          <button disabled={disabled} onClick={()=>{if(!confirm(`셀 ${index+1}을 삭제할까요?`))return;const nb=JSON.parse(record.content);nb.cells.splice(index,1);editNotebook(tab.path,JSON.stringify(nb,null,1)+'\n')}}>삭제</button>
        </div>
        <CodeEditor compact ariaLabel={`셀 ${index+1} 코드`} content={joinSrc(cell.source)} lang={cell.cell_type==='code'?'python':cell.cell_type==='markdown'?'markdown':''} readOnly={busy||!!operation} onChange={source=>change(index,source)} onSave={()=>{if(!disabled)void run('save')}} onRun={cell.cell_type==='code'?()=>{if(!disabled)void run('execute',index)}:undefined}/>

        {cell.cell_type==='markdown'&&<TextCell cell={cell}/>}
        {(cell.outputs||[]).map((output,i)=><Output key={i} out={output}/>)}
      </section>)}
      <div className="nb-cell-actions"><button disabled={disabled} onClick={()=>add('code')}>＋ 코드 셀</button><button disabled={disabled} onClick={()=>add('markdown')}>＋ Markdown 셀</button></div>
    </div>
  </div>
}

export function NotebookPreview({ content }: { content: string }) {
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
          : <TextCell key={i} cell={cell} />
      )}
    </div>
  )
}

/** markdown / raw cells */
function TextCell({ cell }: { cell: NbCell }) {
  const src = joinSrc(cell.source ?? cell.input)
  const html = useMemo(
    () => cell.cell_type === 'markdown' ? renderMarkdown(src) : '',
    [src, cell.cell_type],
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
