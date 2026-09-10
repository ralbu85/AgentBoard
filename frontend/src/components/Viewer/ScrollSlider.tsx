import {useEffect, useRef, useState, type RefObject} from 'react'

export function ScrollSlider({container, identity}: {container:RefObject<HTMLDivElement|null>; identity:string}) {
  const [position,setPosition]=useState({percent:0,enabled:false})
  const target=useRef<HTMLElement|null>(null)
  useEffect(()=>{
    const root=container.current
    if(!root)return
    let frame=0
    const measure=()=>{
      frame=0
      const el=root.querySelector<HTMLElement>('.cm-scroller') || root
      target.current=el
      const max=el.scrollHeight-el.clientHeight
      const percent=max>0?Math.round(el.scrollTop/max*1000)/10:0
      setPosition(prev=>prev.percent===percent&&prev.enabled===(max>1)?prev:{percent,enabled:max>1})
    }
    const schedule=()=>{if(!frame)frame=requestAnimationFrame(measure)}
    root.addEventListener('scroll',schedule,true)
    const resize=new ResizeObserver(schedule);resize.observe(root)
    const changes=new MutationObserver(schedule);changes.observe(root,{childList:true,subtree:true,attributes:true})
    measure()
    return()=>{cancelAnimationFrame(frame);resize.disconnect();changes.disconnect();root.removeEventListener('scroll',schedule,true)}
  },[container,identity])
  return <div className="vertical-scroll-rail">
    <output>{Math.round(position.percent)}%</output>
    <input type="range" className="vertical-slider" aria-label="파일 세로 스크롤" aria-orientation="vertical" min={0} max={100} step={.1} value={position.percent} disabled={!position.enabled}
      onChange={e=>{const el=target.current;if(el)el.scrollTop=(el.scrollHeight-el.clientHeight)*Number(e.target.value)/100}} />
  </div>
}
