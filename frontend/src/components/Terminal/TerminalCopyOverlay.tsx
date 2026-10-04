import {useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties} from 'react'
import {writeClipboard} from './clipboard'

export interface CopySnapshot {text:string; firstVisibleLine:number; fontSize?:number}

export function TerminalCopyOverlay({snapshot,onClose}:{snapshot:CopySnapshot;onClose:()=>void}) {
  const titleId=useId()
  const rootRef=useRef<HTMLDivElement>(null),contentRef=useRef<HTMLDivElement>(null),textRef=useRef<HTMLPreElement>(null)
  const preserveSelection=useRef(false),position=useRef(snapshot.firstVisibleLine)
  const lines=useMemo(()=>snapshot.text.split('\n'),[snapshot.text])
  const [mode,setMode]=useState<'text'|'lines'>('text')
  const [nativeText,setNativeText]=useState('')
  const [anchor,setAnchor]=useState<number|null>(null),[end,setEnd]=useState<number|null>(null)
  const [status,setStatus]=useState(''),[copying,setCopying]=useState(false)
  const first=anchor===null?-1:Math.min(anchor,end??anchor),last=anchor===null?-1:Math.max(anchor,end??anchor)
  const selected=mode==='text'?nativeText:first<0?'':lines.slice(first,last+1).join('\n')

  useEffect(()=>{rootRef.current?.focus({preventScroll:true})},[])
  useLayoutEffect(()=>{
    const content=contentRef.current,target=content?.querySelector<HTMLElement>(`[data-copy-line="${position.current}"]`)
    if(content&&target)content.scrollTop+=target.getBoundingClientRect().top-content.getBoundingClientRect().top
  },[mode])

  useEffect(()=>{
    if(mode!=='text')return
    const changed=()=>{
      const selection=window.getSelection(),pre=textRef.current
      const inside=pre&&selection&&pre.contains(selection.anchorNode)&&pre.contains(selection.focusNode)
      if(inside&&!selection.isCollapsed){setNativeText(selection.toString());setStatus('')}
      else if(!preserveSelection.current)setNativeText('')
    }
    document.addEventListener('selectionchange',changed)
    return()=>document.removeEventListener('selectionchange',changed)
  },[mode])

  const changeMode=(next:typeof mode)=>{
    if(next===mode)return
    // Keep the same passage in view when switching selection methods.
    const content=contentRef.current,nodes=content?.querySelectorAll<HTMLElement>('[data-copy-line]')
    if(content&&nodes?.length){
      const top=content.getBoundingClientRect().top
      let lo=0,hi=nodes.length-1
      while(lo<hi){const mid=(lo+hi)>>1;if(nodes[mid].getBoundingClientRect().bottom<=top)lo=mid+1;else hi=mid}
      position.current=lo
    }
    const selection=window.getSelection()
    if(textRef.current?.contains(selection?.anchorNode??null))selection?.removeAllRanges()
    setNativeText('');setAnchor(null);setEnd(null);setStatus('');setMode(next)
  }
  const chooseLine=(line:number)=>{
    if(anchor===null||end!==null){setAnchor(line);setEnd(null)}else setEnd(line)
    setStatus('')
  }
  const copy=async()=>{
    if(!selected||copying){preserveSelection.current=false;return}
    setCopying(true)
    try{await writeClipboard(selected);setStatus('선택한 내용을 복사했습니다.')}
    catch{setStatus('복사하지 못했습니다. 텍스트 모드에서 길게 눌러 기기의 복사 메뉴를 이용하세요.')}
    finally{preserveSelection.current=false;setCopying(false)}
  }
  const hint=mode==='text'?'길게 누른 뒤 선택 핸들로 범위를 조절하세요.':
    anchor===null?'복사를 시작할 줄을 누르세요.':end===null?'마지막 줄을 누르세요. 한 줄만 복사해도 됩니다.':'다시 줄을 누르면 새 범위를 선택합니다.'
  return <div className="term-select-overlay" ref={rootRef} role="dialog" aria-labelledby={titleId} tabIndex={-1}
    style={{'--copy-font-size':`${Math.max(14,snapshot.fontSize??14)}px`} as CSSProperties}
    onKeyDown={event=>{
      if(event.key==='Escape'){event.stopPropagation();onClose()}
      if((event.ctrlKey||event.metaKey)&&!event.altKey&&(event.key.toLowerCase()==='c'||event.code==='KeyC')){
        event.preventDefault();event.stopPropagation();void copy()
      }
    }}>
    <div className="tso-bar">
      <strong id={titleId}>범위 복사</strong>
      <button className="tso-close" onClick={onClose} aria-label="복사 화면 닫기">✕ 닫기</button>
    </div>
    <div className="tso-controls">
      <div className="tso-modes" role="group" aria-label="범위 선택 방식">
        <button aria-pressed={mode==='text'} onClick={()=>changeMode('text')}>텍스트</button>
        <button aria-pressed={mode==='lines'} onClick={()=>changeMode('lines')}>줄 범위</button>
      </div>
      <button className="tso-copy" disabled={!selected||copying}
        onPointerDown={event=>{preserveSelection.current=true;event.preventDefault()}}
        onPointerCancel={()=>{preserveSelection.current=false}}
        onMouseDown={event=>event.preventDefault()} onClick={()=>void copy()}>{copying?'복사 중…':'선택 복사'}</button>
    </div>
    <div className="tso-info">
      <span className="tso-hint">{hint}</span>
      <span className="tso-selection-status" role="status">{status||(mode==='lines'&&first>=0?`${first+1}–${last+1}줄 · ${last-first+1}줄 선택`:selected?`${Array.from(selected).length.toLocaleString()}자 선택`:'')}</span>
    </div>
    <div className="tso-content" ref={contentRef}>
      {mode==='text'?<pre className="tso-text" ref={textRef} aria-label="복사할 터미널 내용">{lines.map((line,index)=><span key={index} data-copy-line={index}>{line}{index<lines.length-1?'\n':''}</span>)}</pre>:
        <div className="tso-lines" aria-label="복사할 줄 선택">{lines.map((line,index)=><button key={index} type="button" className="tso-line" data-copy-line={index}
          aria-label={`${index+1}줄: ${line||'빈 줄'}`} aria-pressed={index>=first&&index<=last} onClick={()=>chooseLine(index)}>
          <span className="tso-line-number" aria-hidden="true">{index+1}</span><span className="tso-line-text">{line||'\u00a0'}</span>
        </button>)}</div>}
    </div>
  </div>
}
