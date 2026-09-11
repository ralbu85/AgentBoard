import {useEffect, useRef, useState} from 'react'
import {useStore, type ViewerTab} from '../../store'
import {useDrafts} from '../Terminal/drafts'
import {browserUrl} from './browserUrl'
import {useToasts} from '../../toasts'
import {NativeBrowserPane,NativeBrowserEvents} from './NativeBrowserPane'

type RemoteState={url:string;title:string;back:boolean;forward:boolean;width:number;height:number;error?:string;fileChooser?:boolean;dialog?:{type:string;message:string}|null;downloads?:{id:string;name:string;size:number}[]}
type RunningTab={id:string;workspace:string;url:string;title:string;viewers:number}
const endpoint=(id:string)=>`/api/browser/tabs/${encodeURIComponent(id)}`
async function stopTab(id:string){const r=await fetch(endpoint(id),{method:'DELETE'});if(!r.ok)throw new Error('종료하지 못했습니다.')}

export function BrowserPane({tab,ownerKey}:{tab:ViewerTab;ownerKey:string}) {
  return window.agentboardDesktop ? <NativeBrowserPane tab={tab} ownerKey={ownerKey}/> : <RemoteBrowserPane tab={tab} ownerKey={ownerKey}/>
}

function RemoteBrowserPane({tab,ownerKey}:{tab:ViewerTab;ownerKey:string}) {
  const initialUrl=tab.browser?.history[tab.browser.index]||''
  const restoreUrl=useRef(initialUrl);restoreUrl.current=initialUrl
  const [address,setAddress]=useState(initialUrl)
  const [remote,setRemote]=useState<RemoteState|null>(null)
  const [error,setError]=useState('')
  const [notice,setNotice]=useState('')
  const [connection,setConnection]=useState('idle')
  const [retry,setRetry]=useState(0)
  const [running,setRunning]=useState<{limit:number;memoryMB?:number;tabs:RunningTab[]}|null>(null)
  const [showRunning,setShowRunning]=useState(false)
  const [clipboard,setClipboard]=useState<string|null>(null)
  const [sending,setSending]=useState(false)
  const [prompt,setPrompt]=useState('')
  const draftKey=`browser-input:${tab.id}`
  const text=useDrafts(s=>s.drafts[draftKey]||'')
  const socket=useRef<WebSocket|null>(null)
  const image=useRef<HTMLImageElement>(null)
  const viewport=useRef<HTMLDivElement>(null)
  const file=useRef<HTMLInputElement>(null)
  const latest=useRef(remote);latest.current=remote
  const pendingText=useRef<string|null>(null)
  const coords=(clientX:number,clientY:number)=>{const r=viewport.current!.getBoundingClientRect();return {x:(clientX-r.left)*(latest.current?.width||r.width)/r.width,y:(clientY-r.top)*(latest.current?.height||r.height)/r.height}}
  const send=(data:object)=>{if(socket.current?.readyState!==WebSocket.OPEN){setError('브라우저 연결을 먼저 확인해 주세요.');return false}socket.current.send(JSON.stringify(data));return true}
  const list=async()=>{try{const r=await fetch('/api/browser/tabs');if(!r.ok)throw Error();setRunning(await r.json())}catch{setError('실행 목록을 불러오지 못했습니다.')}}

  useEffect(()=>{
    if(!initialUrl)return
    let disposed=false, objectUrl='', reconnect:number|undefined, delay=1000, terminalClose=false
    const connect=()=>{
      if(disposed||document.visibilityState==='hidden'||(socket.current&&socket.current.readyState<WebSocket.CLOSING))return
      setConnection('connecting')
      const ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/api/browser/ws`)
      socket.current=ws;ws.binaryType='blob'
      ws.onopen=()=>{if(disposed||socket.current!==ws){ws.close();return}ws.send(JSON.stringify({id:tab.id,workspace:ownerKey,url:restoreUrl.current}))}
      ws.onmessage=e=>{
        if(disposed||socket.current!==ws)return
        if(e.data instanceof Blob){
          const next=URL.createObjectURL(e.data)
          if(image.current)image.current.src=next
          if(objectUrl)URL.revokeObjectURL(objectUrl)
          objectUrl=next;return
        }
        const data=JSON.parse(e.data)
        if(data.type==='state'){
          delay=1000;setRemote(data);setConnection('online')
          if(data.url&&browserUrl(data.url)){
            setAddress(previous=>previous===latest.current?.url||previous===initialUrl?data.url:previous)
            useStore.getState().syncBrowserLocation(tab.id,data.url,data.title,ownerKey)
          }
        } else if(data.type==='error'){setError(data.message);setSending(false);pendingText.current=null;if(!latest.current){terminalClose=true;setConnection('error')}}
        else if(data.type==='closed'){terminalClose=true;setConnection('closed')}
        else if(data.type==='clipboard'){setClipboard(data.text||'선택한 텍스트가 없습니다.')}
        else if(data.type==='ack'&&data.action==='text'&&pendingText.current!==null){
          const sent=pendingText.current;useDrafts.getState().write(draftKey,current=>current===sent?'':current);pendingText.current=null;setSending(false)
        }
      }
      ws.onclose=e=>{
        if(disposed||socket.current!==ws)return
        if(e.code===4401||e.code===4403){terminalClose=true;setConnection('error');setError('로그인 또는 접속 주소를 확인하고 앱을 새로고침해 주세요.')}
        setSending(false);pendingText.current=null
        if(!terminalClose){setConnection('connecting');if(document.visibilityState!=='hidden')reconnect=window.setTimeout(connect,delay);delay=Math.min(10000,delay*2)}
      }
    }
    const visibility=()=>{clearTimeout(reconnect);if(document.visibilityState==='hidden')socket.current?.close();else if(!socket.current||socket.current.readyState>=WebSocket.CLOSING)connect()}
    document.addEventListener('visibilitychange',visibility)
    connect()
    return()=>{disposed=true;document.removeEventListener('visibilitychange',visibility);clearTimeout(reconnect);socket.current?.close();socket.current=null;if(objectUrl)URL.revokeObjectURL(objectUrl)}
  },[tab.id,ownerKey,!!initialUrl,retry])

  useEffect(()=>{
    const el=viewport.current;if(!el||connection!=='online')return
    let timer:number|undefined
    const resize=()=>{clearTimeout(timer);timer=window.setTimeout(()=>{const r=el.getBoundingClientRect();if(r.width>0&&r.height>0)send({action:'resize',width:Math.round(r.width),height:Math.round(r.height)})},150)}
    const observer=new ResizeObserver(resize);observer.observe(el);resize()
    return()=>{clearTimeout(timer);observer.disconnect()}
  },[connection])
  useEffect(()=>{if(showRunning)void list()},[showRunning,connection])

  const pointer=useRef<{x:number;y:number;lastX:number;lastY:number;touch:boolean;moved:boolean}|null>(null)
  const navigate=(event:React.FormEvent)=>{
    event.preventDefault();const url=browserUrl(address)
    if(!url){setError('HTTP 또는 HTTPS 주소를 입력해 주세요.');return}
    setError('');setNotice('');setAddress(url)
    if(connection==='online')send({action:'navigate',url})
    else {useStore.getState().navigateBrowser(tab.id,url,ownerKey);setRemote(null);setRetry(n=>n+1)}
  }
  const release=async(id:string)=>{
    if(!window.confirm('이 Chromium 탭을 종료할까요? 페이지의 입력 내용과 저장하지 않은 다운로드는 사라집니다.'))return
    try{await stopTab(id);if(id===tab.id)setConnection('closed');await list()}catch{setError('탭을 종료하지 못했습니다.')}
  }
  return <div className="browser-pane chromium-pane">
    <form className="browser-toolbar" onSubmit={navigate}>
      <button type="button" title="이전 페이지" disabled={!remote?.back||connection!=='online'} onClick={()=>send({action:'back'})}>←</button>
      <button type="button" title="다음 페이지" disabled={!remote?.forward||connection!=='online'} onClick={()=>send({action:'forward'})}>→</button>
      <button type="button" title="웹 페이지 새로고침" disabled={connection!=='online'} onClick={()=>send({action:'reload'})}>↻</button>
      <input aria-label="웹 주소" placeholder="https://… 또는 localhost:3000" value={address} onChange={e=>setAddress(e.target.value)} autoCorrect="off" autoCapitalize="none" spellCheck={false}/>
      <button type="submit">이동</button>
      {remote?.url&&<a href={remote.url} target="_blank" rel="noopener noreferrer" title="외부 브라우저에서 열기">↗</a>}
    </form>
    <div className="browser-help chromium-status"><span>서버 Chromium · {({idle:'주소 입력',connecting:'연결 중',online:'연결됨',closed:'종료됨',error:'실행 불가'} as Record<string,string>)[connection]}</span><button onClick={()=>setShowRunning(v=>!v)}>실행 목록</button>{initialUrl&&connection!=='online'&&<button onClick={()=>{setError('');setRemote(null);setRetry(n=>n+1)}}>다시 연결</button>}{connection==='online'&&<button onClick={()=>void release(tab.id)}>종료</button>}</div>
    {(error||remote?.error)&&<div className="browser-error" role="alert">{error||remote?.error}<button onClick={()=>setError('')}>×</button></div>}
    {notice&&<div className="browser-help" role="status">{notice}<button onClick={()=>setNotice('')}>×</button></div>}
    {showRunning&&<div className="chromium-running"><strong>실행 중 {running?.tabs.length||0} / {running?.limit||3}{running?.memoryMB?` · 메모리 약 ${running.memoryMB}MB`: ''}</strong><button onClick={()=>void list()}>새로고침</button>{running?.tabs.map(t=><div key={t.id}><span title={t.url}>{t.title||t.url}<small>{t.workspace}</small></span><button onClick={()=>{
      const [host,cwd]=JSON.parse(t.workspace);useStore.getState().setWorkspace(cwd,host)
      useStore.getState().openTab({id:t.id,path:t.id,type:'browser',name:t.title||'웹',lang:'',content:'',browser:{history:[t.url],index:0}},t.workspace)
      setShowRunning(false)
    }}>이어 열기</button><button onClick={()=>void release(t.id)}>종료</button></div>)}</div>}
    {remote?.dialog&&<div className="chromium-dialog" role="alertdialog"><p>{remote.dialog.message}</p>{remote.dialog.type==='prompt'&&<input value={prompt} onChange={e=>setPrompt(e.target.value)} aria-label="웹 페이지 질문 응답"/>}<button onClick={()=>send({action:'dialog',accept:true,text:prompt})}>확인</button><button onClick={()=>send({action:'dialog',accept:false})}>취소</button></div>}
    <div className="chromium-viewport" ref={viewport} tabIndex={0} aria-label="Chromium 웹 페이지"
      onPointerDown={e=>{if(connection!=='online')return;e.preventDefault();e.currentTarget.focus({preventScroll:true});e.currentTarget.setPointerCapture(e.pointerId);pointer.current={x:e.clientX,y:e.clientY,lastX:e.clientX,lastY:e.clientY,touch:e.pointerType==='touch',moved:false};if(e.pointerType!=='touch')send({action:'pointer',kind:'down',...coords(e.clientX,e.clientY)})}}
      onPointerMove={e=>{const p=pointer.current;if(!p)return;const dx=p.lastX-e.clientX,dy=p.lastY-e.clientY;p.moved ||= Math.hypot(e.clientX-p.x,e.clientY-p.y)>8;if(p.touch&&p.moved)send({action:'wheel',dx,dy,...coords(e.clientX,e.clientY)});else if(!p.touch)send({action:'pointer',kind:'move',...coords(e.clientX,e.clientY)});p.lastX=e.clientX;p.lastY=e.clientY}}
      onPointerUp={e=>{const p=pointer.current;pointer.current=null;if(!p)return;if(p.touch&&!p.moved)send({action:'click',...coords(e.clientX,e.clientY)});else if(!p.touch)send({action:'pointer',kind:'up',...coords(e.clientX,e.clientY)})}}
      onPointerCancel={e=>{if(pointer.current&&!pointer.current.touch)send({action:'pointer',kind:'up',...coords(e.clientX,e.clientY)});pointer.current=null}}
      onDoubleClick={e=>send({action:'click',double:true,...coords(e.clientX,e.clientY)})}
      onWheel={e=>{if(connection==='online')send({action:'wheel',dx:e.deltaX,dy:e.deltaY,...coords(e.clientX,e.clientY)})}}
      onPaste={e=>{e.preventDefault();send({action:'text',text:e.clipboardData.getData('text/plain')})}}
      onKeyDown={e=>{
        if(e.nativeEvent.isComposing)return
        if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='c'){e.preventDefault();send({action:'copy'});return}
        if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='v')return
        if(e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey){e.preventDefault();send({action:'text',text:e.key});return}
        if(/^(Enter|Tab|Backspace|Delete|Escape|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown)$/.test(e.key)||((e.ctrlKey||e.metaKey)&&/^[a-zA-Z]$/.test(e.key))){e.preventDefault();send({action:'key',key:`${e.ctrlKey||e.metaKey?'Control+':''}${e.altKey?'Alt+':''}${e.shiftKey?'Shift+':''}${e.key}`})}
      }}>
      <img ref={image} alt="원격 Chromium 화면" draggable={false} style={{visibility:remote?'visible':'hidden'}}/>
      {!remote&&<div className="chromium-placeholder">{initialUrl?'Chromium 화면을 연결하고 있습니다.':'주소를 입력해 웹 페이지를 여세요.'}</div>}
    </div>
    {remote?.fileChooser&&<div className="chromium-transfer"><span>웹 페이지에 올릴 파일 선택 (합계 25MB)</span><input ref={file} type="file" multiple aria-label="웹 페이지에 업로드할 파일" onChange={async e=>{
      const files=e.target.files;if(!files?.length)return
      const body=new FormData();for(const f of Array.from(files))body.append('files',f)
      try{const r=await fetch(`${endpoint(tab.id)}/upload`,{method:'POST',body});if(!r.ok)throw Error();setError('')}catch{setError('파일을 올리지 못했습니다. 용량과 페이지 상태를 확인해 주세요.')}
    }}/></div>}
    {!!remote?.downloads?.length&&<details className="chromium-transfer"><summary>다운로드 {remote.downloads.length}개</summary>{remote.downloads.map(d=><div key={d.id}><span>{d.name}</span><a href={`${endpoint(tab.id)}/downloads/${d.id}`} download={d.name}>기기에 저장</a><button onClick={async()=>{try{const r=await fetch(`${endpoint(tab.id)}/downloads/${d.id}/save`,{method:'POST'});const result=await r.json();if(!r.ok)throw Error(result.detail);setNotice(`저장 완료: ${result.path}`);setError('')}catch(e){setError(e instanceof Error?e.message:'저장 실패')}}}>워크스페이스에 저장</button></div>)}</details>}
    {clipboard!==null&&<div className="chromium-transfer"><textarea aria-label="복사할 웹 페이지 텍스트" readOnly value={clipboard} onFocus={e=>e.currentTarget.select()}/><button onClick={()=>setClipboard(null)}>닫기</button></div>}
    <form className="chromium-input" onSubmit={e=>{e.preventDefault();if(!text||sending)return;pendingText.current=text;if(send({action:'text',text,ack:true})){setSending(true)}else pendingText.current=null}}>
      <textarea aria-label="웹 페이지에 입력할 텍스트" placeholder="페이지의 입력칸을 선택한 뒤 여기에 입력" value={text} onChange={e=>useDrafts.getState().write(draftKey,e.target.value)} rows={1} autoCorrect="off" autoCapitalize="none" spellCheck={false}/>
      <button disabled={connection!=='online'||sending||!text}>입력</button><button type="button" title="웹 페이지에서 Enter" disabled={connection!=='online'} onClick={()=>send({action:'key',key:'Enter'})}>↵</button><button type="button" title="선택한 웹 페이지 텍스트 복사" disabled={connection!=='online'} onClick={()=>send({action:'copy'})}>복사</button>
    </form>
  </div>
}

// Closing a workbench tab releases its server page. Merely switching tabs,
// workspaces, or devices leaves it alive and only disconnects the frame stream.
export function BrowserSurfaces(){
  const ids=useStore(s=>Object.values(s._viewerState).flatMap(v=>v.tabs).filter(t=>t.type==='browser').map(t=>t.id).sort().join('\0'))
  const previous=useRef<string[]>([])
  useEffect(()=>{const next=ids?ids.split('\0'):[];for(const id of previous.current)if(!next.includes(id)){
    const close=window.agentboardDesktop?window.agentboardDesktop.invoke({action:'close',id}):stopTab(id)
    void close.catch(()=>useToasts.getState().push('웹 탭을 종료하지 못했습니다.'))
  }previous.current=next},[ids])
  return window.agentboardDesktop?<NativeBrowserEvents/>:null
}
