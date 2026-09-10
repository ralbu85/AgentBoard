import {useEffect, useLayoutEffect, useRef, useState} from 'react'
import {create} from 'zustand'
import {useStore, viewerKey, type ViewerTab} from '../../store'
import {browserUrl} from './browserUrl'

const useFrames=create<{slots:Record<string,HTMLElement>; reloads:Record<string,number>; mount:(id:string,el:HTMLElement|null)=>void; reload:(id:string)=>void}>(set=>({
  slots:{},reloads:{},
  mount:(id,el)=>set(state=>{const slots={...state.slots};if(el)slots[id]=el;else delete slots[id];return {slots}}),
  reload:id=>set(state=>({reloads:{...state.reloads,[id]:(state.reloads[id]||0)+1}})),
}))

export function BrowserPane({tab, ownerKey}:{tab:ViewerTab;ownerKey:string}) {
  const url=tab.browser?.history[tab.browser.index] || ''
  const [address,setAddress]=useState(url), [error,setError]=useState('')
  const slot=useRef<HTMLDivElement>(null)
  useEffect(()=>{setAddress(url);setError('')},[url])
  useLayoutEffect(()=>{useFrames.getState().mount(tab.id,slot.current);return()=>useFrames.getState().mount(tab.id,null)},[tab.id])
  return <div className="browser-pane">
    <form className="browser-toolbar" onSubmit={e=>{e.preventDefault();const value=browserUrl(address);if(!value){setError('HTTP 또는 HTTPS 주소를 입력해 주세요.');return}setError('');if(value===url)useFrames.getState().reload(tab.id);else useStore.getState().navigateBrowser(tab.id,value,ownerKey)}}>
      <button type="button" title="주소창 이전 방문 주소" disabled={!tab.browser||tab.browser.index<=0} onClick={()=>useStore.getState().stepBrowser(tab.id,-1,ownerKey)}>←</button>
      <button type="button" title="주소창 다음 방문 주소" disabled={!tab.browser||tab.browser.index>=tab.browser.history.length-1} onClick={()=>useStore.getState().stepBrowser(tab.id,1,ownerKey)}>→</button>
      <button type="button" title="웹 페이지 새로고침" disabled={!url} onClick={()=>useFrames.getState().reload(tab.id)}>↻</button>
      <input aria-label="웹 주소" placeholder="https://… 또는 localhost:3000" value={address} onChange={e=>setAddress(e.target.value)} spellCheck={false} autoCapitalize="none" />
      <button type="submit">이동</button>
      {url&&<a href={url} target="_blank" rel="noopener noreferrer" title="주소창의 URL을 외부 브라우저에서 열기">↗</a>}
    </form>
    {error&&<p className="browser-error" role="alert">{error}</p>}
    <div className="browser-help">페이지가 비어 있거나 로그인이 안 되면 ↗ 외부에서 여세요. 주소창 이력만 저장되며, 페이지 내부 이동은 주소창에 반영되지 않습니다.</div>
    <div className="browser-slot" ref={slot}>
      {!url&&<div className="viewer-empty">주소를 입력해 웹 페이지를 여세요.<br/>터미널·문서의 웹 링크도 이곳에서 열립니다.</div>}
    </div>
  </div>
}

// Keep frames in one stable DOM parent: moving an iframe to another pane would
// reload it. Visible slots determine geometry; hidden tabs retain their frame.
export function BrowserSurfaces() {
  const viewers=useStore(s=>s._viewerState)
  const tabs=Object.values(viewers).flatMap(view=>view.tabs).filter(tab=>tab.type==='browser')
  return <>{tabs.map(tab=><BrowserFrame key={tab.id} tab={tab}/>)}</>
}
function BrowserFrame({tab}:{tab:ViewerTab}) {
  const slot=useFrames(s=>s.slots[tab.id]), reload=useFrames(s=>s.reloads[tab.id]||0)
  const frame=useRef<HTMLIFrameElement>(null)
  const [activated,setActivated]=useState(false)
  const [rect,setRect]=useState({left:0,top:0,width:0,height:0})
  const url=tab.browser?.history[tab.browser.index] || ''
  useLayoutEffect(()=>{
    if(!slot)return
    setActivated(true)
    const measure=()=>{const r=slot.getBoundingClientRect();setRect(prev=>prev.left===r.left&&prev.top===r.top&&prev.width===r.width&&prev.height===r.height?prev:{left:r.left,top:r.top,width:r.width,height:r.height})}
    const observer=new ResizeObserver(measure);observer.observe(slot)
    window.addEventListener('resize',measure);window.addEventListener('scroll',measure,true)
    measure()
    return()=>{observer.disconnect();window.removeEventListener('resize',measure);window.removeEventListener('scroll',measure,true)}
  },[slot])
  useEffect(()=>{
    if(!slot)return
    let pending=0
    const focus=()=>{pending=requestAnimationFrame(()=>{
      const state=useStore.getState(), view=state._viewerState[viewerKey(state)]
      if(document.activeElement===frame.current&&view?.tabs.some(t=>t.id===tab.id)&&view.activeTabId!==tab.id)state.setActiveTab(tab.id)
    })}
    window.addEventListener('blur',focus)
    return()=>{cancelAnimationFrame(pending);window.removeEventListener('blur',focus)}
  },[slot,tab.id])
  if(!activated||!url)return null
  return <div className="browser-surface" data-browser-id={tab.id} style={{...rect,display:slot?'block':'none'}}>
    <iframe ref={frame} key={`${url}:${reload}`} src={url} title={`웹 페이지: ${url}`} referrerPolicy="no-referrer" sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads" />
  </div>
}
