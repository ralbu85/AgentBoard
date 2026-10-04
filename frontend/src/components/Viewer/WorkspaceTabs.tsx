import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useStore, sessionLabel, type ViewerTab } from '../../store'
import { AgentIcon } from '../AgentIcon'

const isFile = (tab: ViewerTab) => tab.type !== 'terminal' && tab.type !== 'browser'
const kinds: Record<ViewerTab['type'], string> = {terminal:'터미널',browser:'웹',pdf:'PDF',notebook:'노트북',markdown:'문서',code:'코드',latex:'LaTeX',image:'이미지',diff:'변경사항'}

interface Props {
  tabs: ViewerTab[]
  paneIds: string[]
  activeId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onDrop: (id: string, target: string, after: boolean) => void
  actions: ReactNode
}

export function WorkspaceTabs({tabs, paneIds, activeId, onSelect, onClose, onDrop, actions}: Props) {
  const sessions = useStore(s => s.sessions)
  const titles = useStore(s => s.titles)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [dragTarget, setDragTarget] = useState<string|null>(null)
  const [overflow, setOverflow] = useState({left:false,right:false})
  const [position, setPosition] = useState({top:0,left:0,width:360})
  const strip = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const paneTabs = paneIds.map(id => tabs.find(t => t.id === id)).filter((t):t is ViewerTab => !!t)
  const title = (tab: ViewerTab) => tab.type === 'terminal' && tab.sessionId && sessions[tab.sessionId] ? sessionLabel(sessions[tab.sessionId], titles) : tab.name
  const detail = (tab: ViewerTab) => tab.type === 'terminal' && tab.sessionId ? sessions[tab.sessionId]?.sessionName || '터미널 세션' : tab.path
  const icon = (tab: ViewerTab) => tab.type === 'terminal'
    ? <><AgentIcon session={sessions[tab.sessionId || '']}/><span className="tab-terminal-fallback" aria-hidden="true">›_</span></>
    : <span className={`tab-kind tab-kind-${tab.type}`} aria-hidden="true">{tab.type === 'browser' ? '◎' : tab.type === 'pdf' ? 'PDF' : tab.type === 'notebook' ? 'NB' : tab.type === 'markdown' ? 'MD' : '▤'}</span>
  const closeMenu = () => { setOpen(false); trigger.current?.focus() }
  const measure = () => {
    const el=strip.current
    if(el)setOverflow({left:el.scrollLeft>2,right:el.scrollWidth-el.clientWidth-el.scrollLeft>2})
  }
  const reveal = (id: string) => {
    const el=strip.current, item=el && Array.from(el.children).find(child=>(child as HTMLElement).dataset.tabId===id) as HTMLElement|undefined
    if(!el||!item)return
    const a=el.getBoundingClientRect(), b=item.getBoundingClientRect()
    if(b.left<a.left)el.scrollLeft-=a.left-b.left
    else if(b.right>a.right)el.scrollLeft+=b.right-a.right
    measure()
  }
  useLayoutEffect(() => { if(activeId)reveal(activeId); measure() },[activeId,paneIds.join('\0')])
  useEffect(() => {
    const el=strip.current
    if(!el)return
    const observer=new ResizeObserver(()=>{if(activeId)reveal(activeId);measure()})
    observer.observe(el)
    return()=>observer.disconnect()
  },[activeId])
  useEffect(() => {
    if(!open)return
    setQuery('');setFilter('all')
    const place=()=>{
      const rect=trigger.current?.getBoundingClientRect()
      if(!rect)return
      const width=Math.min(400,window.innerWidth-16)
      setPosition({top:rect.bottom+6,left:Math.max(8,Math.min(rect.right-width,window.innerWidth-width-8)),width})
    }
    place();input.current?.focus()
    const outside=(event:PointerEvent)=>{if(!popup.current?.contains(event.target as Node)&&!trigger.current?.contains(event.target as Node))setOpen(false)}
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeMenu()}}
    document.addEventListener('pointerdown',outside)
    document.addEventListener('keydown',escape,true)
    window.addEventListener('resize',place)
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape,true);window.removeEventListener('resize',place)}
  },[open])
  const filtered=tabs.filter(t=>(filter==='all'||filter==='terminal'&&t.type==='terminal'||filter==='file'&&isFile(t)||filter==='browser'&&t.type==='browser')&&`${title(t)} ${detail(t)}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  const savedFiles=tabs.filter(t=>isFile(t)&&!t.dirty&&t.id!==activeId)

  return <div className="vtab-bar">
    <div className={`vtab-scroll-region ${overflow.left?'has-left':''} ${overflow.right?'has-right':''}`}>
      <div ref={strip} className="vtab-scroll" role="tablist" aria-label="작업 탭" onScroll={measure}
        onWheel={e=>{const el=strip.current;if(el&&el.scrollWidth>el.clientWidth&&Math.abs(e.deltaY)>Math.abs(e.deltaX)){el.scrollLeft+=e.deltaY}}}>
        {paneTabs.map(t=><div key={t.id} data-tab-id={t.id} className={`vtab ${t.id===activeId?'active':''} ${dragTarget===t.id?'tab-drop-target':''}`}
          role="tab" aria-selected={t.id===activeId} aria-label={`${title(t)}${t.dirty?' · 수정 중':''}`} tabIndex={t.id===activeId?0:-1} draggable
          title={`${title(t)}\n${detail(t)}`} onClick={()=>onSelect(t.id)}
          onKeyDown={e=>{
            if((e.target as HTMLElement).closest('button'))return
            if(e.key==='Enter'||e.key===' '){e.preventDefault();onSelect(t.id)}
            const index=paneTabs.findIndex(tab=>tab.id===t.id)
            const next=e.key==='ArrowRight'?(index+1)%paneTabs.length:e.key==='ArrowLeft'?(index+paneTabs.length-1)%paneTabs.length:e.key==='Home'?0:e.key==='End'?paneTabs.length-1:-1
            if(next>=0){e.preventDefault();onSelect(paneTabs[next].id);(strip.current?.children[next] as HTMLElement)?.focus()}
          }}
          onDragStart={e=>{document.body.classList.add('dragging-viewer-tab');e.dataTransfer.setData('application/agentboard-tab',t.id);e.dataTransfer.effectAllowed='move'}}
          onDragOver={e=>{if(e.dataTransfer.types.includes('application/agentboard-tab')){e.preventDefault();setDragTarget(t.id)}}}
          onDragLeave={()=>setDragTarget(null)}
          onDragEnd={()=>{document.body.classList.remove('dragging-viewer-tab');setDragTarget(null)}}
          onDrop={e=>{document.body.classList.remove('dragging-viewer-tab');e.preventDefault();e.stopPropagation();const id=e.dataTransfer.getData('application/agentboard-tab');const rect=e.currentTarget.getBoundingClientRect();if(id)onDrop(id,t.id,e.clientX>rect.left+rect.width/2);setDragTarget(null)}}>
          {icon(t)}<span className="vtab-name">{title(t)}</span>
          {t.dirty&&<span className="vtab-dirty" title="저장하지 않은 변경" aria-label="수정 중">●</span>}
          <button type="button" className="vtab-close vtab-x" aria-label={`${title(t)} 탭 닫기`} title={t.type==='terminal'?'탭과 왼쪽 목록에서 숨기기 (실행 유지)':'탭 닫기'} onClick={e=>{e.stopPropagation();onClose(t.id)}}>×</button>
        </div>)}
      </div>
    </div>
    <button ref={trigger} className={`workspace-tabs-toggle ${open?'active':''}`} onClick={()=>setOpen(!open)} aria-expanded={open} aria-haspopup="dialog" title="전체 탭 검색 및 관리" aria-label={`전체 탭 목록 ${tabs.length}개`}>☷ <span>{tabs.length}</span></button>
    {actions}
    {open&&createPortal(<div ref={popup} className="workspace-tabs-popup" role="dialog" aria-label="워크스페이스 탭 관리" style={{...position,maxHeight:`calc(100dvh - ${position.top+12}px)`}}>
      <div className="workspace-tabs-heading"><strong>열린 탭 <span>{tabs.length}</span></strong><button onClick={closeMenu} aria-label="탭 목록 닫기">×</button></div>
      <input ref={input} className="workspace-tabs-search" aria-label="탭 검색" placeholder="탭 이름 또는 경로 검색" value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&filtered.length){onSelect(filtered[0].id);setOpen(false)}}}/>
      <div className="workspace-tabs-filters" aria-label="탭 종류">
        {[['all','전체'],['terminal','터미널'],['file','파일'],['browser','웹']].map(([id,label])=><button key={id} aria-pressed={filter===id} onClick={()=>setFilter(id)}>{label} <span>{tabs.filter(t=>id==='all'||id==='terminal'&&t.type==='terminal'||id==='file'&&isFile(t)||id==='browser'&&t.type==='browser').length}</span></button>)}
      </div>
      <div className="workspace-tabs-list">
        {filtered.map(t=><div key={t.id} className={`workspace-tab-row ${t.id===activeId?'selected':''}`}>
          <button className="workspace-tab-select" title={detail(t)} onClick={()=>{onSelect(t.id);setOpen(false)}} aria-current={t.id===activeId?'true':undefined}>
            {icon(t)}<span className="workspace-tab-label"><span>{title(t)}{t.dirty&&<span className="vtab-dirty"> ● 수정 중</span>}</span><small>{kinds[t.type]} · {detail(t)}</small></span>
            {t.id===activeId&&<span aria-label="현재 탭">✓</span>}
          </button>
          <button className="workspace-tab-dismiss" onClick={()=>onClose(t.id)} aria-label={`${title(t)} 탭 닫기`} title={t.type==='terminal'?'탭과 왼쪽 목록에서 숨기기 (실행 유지)':'탭 닫기'}>×</button>
        </div>)}
        {!filtered.length&&<p className="workspace-tabs-empty">일치하는 탭이 없습니다.</p>}
      </div>
      <div className="workspace-tabs-footer">
        <button disabled={!savedFiles.length} onClick={()=>savedFiles.forEach(t=>onClose(t.id))}>다른 저장된 파일 탭 닫기 <span>{savedFiles.length}</span></button>
        <small>현재 탭·수정 중인 파일·터미널·웹은 유지됩니다.</small>
      </div>
    </div>,document.body)}
  </div>
}
