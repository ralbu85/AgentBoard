import {useEffect,useMemo,useRef,useState} from 'react'
import {renderMarkdown} from '../../markdown'

interface Message {id:string;role:'user'|'assistant';text:string;timestamp:string}
interface Choice {key:string;provider:string;id:string;timestamp:string}
interface Page {available:boolean;source?:string;binding?:string;provider?:string;messages:Message[];choices:Choice[];before:number|null;reason?:string;limited?:boolean}

export function conversationHtml(text:string){
  const template=document.createElement('template');template.innerHTML=renderMarkdown(text)
  // Conversation logs may contain arbitrary remote Markdown. Reading a log
  // must not make tracking requests or open local/file/javascript resources.
  template.content.querySelectorAll('img,video,audio,iframe,source,svg,style,link,meta,object,embed').forEach(node=>node.replaceWith(document.createTextNode(node.getAttribute('alt')||'')))
  template.content.querySelectorAll('*').forEach(node=>{
    for(const attribute of ['style','src','srcset','poster','background','action','formaction','ping','xlink:href'])node.removeAttribute(attribute)
    if(node.tagName!=='A')node.removeAttribute('href')
  })
  template.content.querySelectorAll('a').forEach(anchor=>{
    try{
      const url=new URL(anchor.getAttribute('href')||'')
      if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error()
      anchor.href=url.href;anchor.target='_blank';anchor.rel='noopener noreferrer';anchor.referrerPolicy='no-referrer'
    }catch{anchor.removeAttribute('href')}
  })
  return template.innerHTML
}

function MessageBody({text}:{text:string}){
  const html=useMemo(()=>conversationHtml(text),[text])
  return <div className="conversation-message-body" dangerouslySetInnerHTML={{__html:html}} />
}

export function ConversationView({sessionId}:{sessionId:string}){
  const [page,setPage]=useState<Page>(),[error,setError]=useState(''),[loading,setLoading]=useState(true)
  const [pick,setPick]=useState(false),[revision,setRevision]=useState(0),[pending,setPending]=useState(false)
  const area=useRef<HTMLDivElement>(null),current=useRef<Page|undefined>(undefined),busy=useRef(false),alive=useRef(0)
  const atBottom=()=>!area.current||area.current.scrollHeight-area.current.clientHeight-area.current.scrollTop<24
  const paused=()=>{const selection=window.getSelection();return !atBottom()||!!(selection&&!selection.isCollapsed&&area.current?.contains(selection.anchorNode))}
  const apply=(next:Page,older=false)=>{
    const el=area.current,follow=atBottom(),oldHeight=el?.scrollHeight||0,oldTop=el?.scrollTop||0
    const existing=current.current
    if(existing&&existing.source===next.source&&next.available){
      const merged=new Map((older?[...next.messages,...existing.messages]:[...existing.messages,...next.messages]).map(m=>[m.id,m]))
      next={...next,messages:[...merged.values()].sort((a,b)=>Number(a.id)-Number(b.id)),before:older?next.before:existing.before}
    }
    current.current=next;setPage(next);setError('');setPending(false)
    requestAnimationFrame(()=>{if(!el||el!==area.current)return;if(older)el.scrollTop=oldTop+el.scrollHeight-oldHeight;else if(follow&&Math.abs(el.scrollTop-oldTop)<=1&&!window.getSelection()?.toString())el.scrollTop=el.scrollHeight})
  }
  useEffect(()=>{
    const generation=++alive.current,controller=new AbortController()
    current.current=undefined;setPage(undefined);setLoading(true);setError('');setPending(false);busy.current=false
    const read=async()=>{
      if(busy.current)return
      if(current.current&&paused()){setPending(true);return}
      busy.current=true
      try{
        const response=await fetch(`/api/conversations/${encodeURIComponent(sessionId)}`,{credentials:'include',signal:controller.signal,cache:'no-store'})
        const data=await response.json();if(!response.ok)throw Error(data.detail||'대화를 불러오지 못했습니다.')
        if(alive.current===generation){if(current.current&&paused())setPending(true);else apply(data)}
      }catch(e){if(!controller.signal.aborted&&alive.current===generation)setError(e instanceof Error?e.message:'연결 실패')}
      finally{if(alive.current===generation){setLoading(false);busy.current=false}}
    }
    void read();const timer=setInterval(()=>{if(!document.hidden)void read()},3000)
    return()=>{controller.abort();clearInterval(timer);alive.current++}
  },[sessionId,revision])
  const previous=async()=>{
    if(page?.before==null||busy.current)return
    const generation=alive.current;busy.current=true;setLoading(true)
    try{
      const response=await fetch(`/api/conversations/${encodeURIComponent(sessionId)}?before=${page.before}&source=${encodeURIComponent(page.source||'')}`,{credentials:'include',cache:'no-store'})
      const data=await response.json();if(!response.ok)throw Error(data.detail||'이전 대화를 불러오지 못했습니다.')
      if(alive.current===generation)apply(data,true)
    }catch(e){if(alive.current===generation)setError(e instanceof Error?e.message:'연결 실패')}
    finally{if(alive.current===generation){busy.current=false;setLoading(false)}}
  }
  const bind=async(source:string)=>{
    setLoading(true)
    try{
      const response=await fetch(`/api/conversations/${encodeURIComponent(sessionId)}`,{method:'PUT',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({source:source||null})})
      const data=await response.json();if(!response.ok)throw Error(data.detail||'대화를 연결하지 못했습니다.')
      setPick(false);setRevision(n=>n+1)
    }catch(e){setError(e instanceof Error?e.message:'연결 실패');setLoading(false)}
  }
  return <div className="conversation-view">
    <div className="conversation-controls">
      <span>{page?.available?`${page.provider} · ${page.binding==='manual'?'선택한 대화':'자동 연결'}`:'원본 대화'}</span>
      <button className="btn btn-xs" onClick={()=>setPick(v=>!v)}>대화 연결</button>
      <button className="btn btn-xs" disabled={loading} onClick={()=>setRevision(n=>n+1)}>새로고침</button>
    </div>
    {error&&<p role="alert" className="conversation-notice">{error}</p>}
    {page?.limited&&<p className="conversation-notice">큰 기록은 이 보기에서 생략될 수 있습니다. 터미널 또는 원본 기록을 확인해 주세요.</p>}
    {(pick||page&&!page.available)&&<div className="conversation-picker">
      <p>{page?.reason||'이 터미널에서 사용한 대화를 선택하세요.'}</p>
      <select aria-label="연결할 원본 대화" value={page?.source||''} disabled={loading} onChange={event=>void bind(event.target.value)}>
        <option value="">자동 연결</option>
        {page?.choices.map(choice=><option key={choice.key} value={choice.key}>{choice.provider} · {choice.timestamp.slice(0,16).replace('T',' ')} · {choice.id.slice(0,8)}</option>)}
      </select>
    </div>}
    {loading&&!page&&<p className="conversation-notice" role="status">대화를 불러오는 중…</p>}
    <div className="conversation-scroll" ref={area}>
      {page?.before!=null&&<button className="btn conversation-previous" disabled={loading} onClick={()=>void previous()}>이전 대화 불러오기</button>}
      {page?.available&&!page.messages.length&&<p className="conversation-notice">아직 표시할 메시지가 없습니다.</p>}
      {page?.messages.map(message=><article key={`${page.source}:${message.id}`} className={`conversation-message role-${message.role}`}>
        <div className="conversation-message-role">{message.role==='user'?'나':page.provider}</div>
        <MessageBody text={message.text}/>
      </article>)}
    </div>
    {pending&&<button className="btn conversation-latest" onClick={()=>{area.current?.scrollTo({top:area.current.scrollHeight});setPending(false)}}>최신 대화로</button>}
  </div>
}
