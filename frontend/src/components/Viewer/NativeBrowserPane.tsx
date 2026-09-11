import {useEffect, useRef, useState} from 'react'
import {useStore, type ViewerTab} from '../../store'
import {useToasts} from '../../toasts'
import {browserUrl} from './browserUrl'

type NativeState={id:string;workspace:string;url:string;title:string;back:boolean;forward:boolean;loading:boolean;error?:string}
type DesktopEvent=Partial<NativeState>&{type:string;enabled?:boolean;connected?:boolean;desktopId?:string;name?:string;state?:string}
type RelayState={enabled:boolean;connected:boolean;desktopId:string}
type DesktopBridge={invoke:(data:Record<string,unknown>)=>Promise<any>;subscribe:(callback:(data:DesktopEvent)=>void)=>()=>void}
declare global { interface Window { agentboardDesktop?:DesktopBridge } }

export function NativeBrowserPane({tab,ownerKey}:{tab:ViewerTab;ownerKey:string}) {
  const bridge=window.agentboardDesktop!
  const slot=useRef<HTMLDivElement>(null)
  const initial=useRef(tab.browser?.history[tab.browser.index]||'')
  const editing=useRef(false)
  const pageUrl=useRef('')
  const [address,setAddress]=useState(initial.current)
  const [state,setState]=useState<NativeState|null>(null)
  const [error,setError]=useState('')
  const [relay,setRelay]=useState<RelayState>({enabled:true,connected:false,desktopId:''})
  const [retry,setRetry]=useState(0)
  const command=async(action:string,extra:Record<string,unknown>={})=>{
    try{setError('');return await bridge.invoke({action,id:tab.id,...extra})}
    catch(e){setError(e instanceof Error?e.message:'브라우저 작업에 실패했습니다.')}
  }
  useEffect(()=>{
    let disposed=false,ready=false,frame=0,last=''
    const update=()=>{
      frame=0
      if(!ready||disposed||!slot.current)return
      const r=slot.current.getBoundingClientRect()
      const hidden=document.visibilityState==='hidden'||document.body.classList.contains('dragging-viewer-tab')||!!document.querySelector('.spawn-backdrop,.session-manager-backdrop,[aria-modal="true"]')
      const data={action:'bounds',id:tab.id,bounds:{x:r.x,y:r.y,width:r.width,height:r.height},visible:!hidden&&!!pageUrl.current}
      const encoded=JSON.stringify(data)
      if(encoded!==last){last=encoded;void bridge.invoke(data).catch(()=>{})}
    }
    const schedule=()=>{if(!frame)frame=requestAnimationFrame(update)}
    const unsubscribe=bridge.subscribe(data=>{
      if(data.type==='resize')schedule()
      if(data.type==='relay')setRelay(data as RelayState)
      if(data.id===tab.id&&data.type==='state'){
        pageUrl.current=data.url||''
        setState(data as NativeState)
        if(data.url&&!editing.current)setAddress(data.url)
        schedule()
      }
    })
    const observer=new ResizeObserver(schedule);if(slot.current)observer.observe(slot.current)
    // Native views sit above DOM: hide them for app dialogs and tab dragging.
    const mutations=new MutationObserver(schedule)
    mutations.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class','style','aria-modal']})
    window.addEventListener('resize',schedule);window.addEventListener('scroll',schedule,true)
    document.addEventListener('visibilitychange',schedule)
    void bridge.invoke({action:'open',id:tab.id,workspace:ownerKey,url:initial.current}).then(result=>{
      if(disposed)return
      ready=true;pageUrl.current=result.url;setState(result);if(result.url)setAddress(result.url);schedule()
    }).catch(e=>{if(!disposed)setError(String(e.message))})
    void bridge.invoke({action:'relay'}).then(result=>{if(!disposed)setRelay(result)}).catch(()=>{})
    return()=>{disposed=true;unsubscribe();observer.disconnect();mutations.disconnect();cancelAnimationFrame(frame);window.removeEventListener('resize',schedule);window.removeEventListener('scroll',schedule,true);document.removeEventListener('visibilitychange',schedule);void bridge.invoke({action:'hide',id:tab.id}).catch(()=>{})}
  },[tab.id,ownerKey,retry])
  return <div className="browser-pane native-browser-pane">
    <form className="browser-toolbar" onSubmit={e=>{e.preventDefault();const url=browserUrl(address);if(!url){setError('HTTP 또는 HTTPS 주소를 입력해 주세요.');return}editing.current=false;setAddress(url);void command('navigate',{url})}}>
      <button type="button" title="이전 페이지" disabled={!state?.back} onClick={()=>void command('back')}>←</button>
      <button type="button" title="다음 페이지" disabled={!state?.forward} onClick={()=>void command('forward')}>→</button>
      <button type="button" title={state?.loading?'로딩 중지':'새로고침'} onClick={()=>void command(state?.loading?'stop':'reload')}>{state?.loading?'×':'↻'}</button>
      <input aria-label="웹 주소" value={address} onFocus={()=>{editing.current=true}} onBlur={()=>{editing.current=false}} onChange={e=>setAddress(e.target.value)} placeholder="https://… 또는 localhost:3000" autoCorrect="off" autoCapitalize="none" spellCheck={false}/>
      <button type="submit">이동</button>
      <button type="button" title="개발자 도구" onClick={()=>void command('devtools')}>개발</button>
      <button type="button" title="외부 브라우저에서 열기" disabled={!state?.url} onClick={()=>void command('external',{url:state?.url})}>↗</button>
    </form>
    <div className="browser-help native-browser-status">
      <span>이 PC의 Chromium</span>
      <label title={relay.desktopId?`데스크톱 ID: ${relay.desktopId}`:''}><input type="checkbox" checked={relay.enabled} onChange={e=>{const previous=relay;setRelay({...relay,enabled:e.target.checked});void command('relay',{enabled:e.target.checked}).then(result=>setRelay(result||previous))}}/>에이전트 연결 {relay.enabled?(relay.connected?'켜짐':'연결 중'):'꺼짐'}</label>
    </div>
    {(error||state?.error)&&<div role="alert" className="browser-error">{error||state?.error}<button onClick={()=>{setError('');setRetry(n=>n+1)}}>다시 연결</button></div>}
    <div className="native-browser-slot" ref={slot} aria-label="이 PC에서 실행하는 웹 페이지">{!state?.url&&<span>주소를 입력해 웹 페이지를 여세요.</span>}</div>
  </div>
}

export function NativeBrowserEvents(){
  useEffect(()=>{
    const bridge=window.agentboardDesktop!
    const unsubscribe=bridge.subscribe(data=>{
      const store=useStore.getState()
      if(data.type==='state'&&data.id&&data.url&&data.workspace)store.syncBrowserLocation(data.id,data.url,data.title||'',data.workspace)
      if(data.type==='popup'&&data.url&&data.workspace)store.openBrowser(data.url,data.workspace)
      if(data.type==='opened'&&data.id&&data.workspace){
        const [host,cwd]=JSON.parse(data.workspace);store.setWorkspace(cwd,host)
        store.openTab({id:data.id,path:data.id,type:'browser',name:data.title||'웹',lang:'',content:'',browser:{history:data.url?[data.url]:[],index:data.url?0:-1}},data.workspace)
      }
      if(data.type==='focus'&&data.id)store.setActiveTab(data.id)
      if(data.type==='closed'&&data.id&&data.workspace)store.closeTab(data.id,data.workspace)
      if(data.type==='download')useToasts.getState().push(data.state==='completed'?`다운로드 완료: ${data.name}`:`다운로드 ${data.state}: ${data.name}`)
    })
    return()=>{unsubscribe();void bridge.invoke({action:'hideAll'}).catch(()=>{})}
  },[])
  return null
}
