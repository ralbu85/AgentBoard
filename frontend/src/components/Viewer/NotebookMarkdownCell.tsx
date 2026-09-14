import {useEffect, useMemo, useRef, useState} from 'react'
import {renderMarkdown} from '../../markdown'
import {CodeEditor} from './CodeEditor'

export function NotebookMarkdownCell({content,index,disabled,onChange,onSave,onDelete}:{
  content:string;index:number;disabled:boolean;onChange:(value:string)=>void;onSave:()=>void;onDelete:()=>void
}){
  const [editing,setEditing]=useState(false)
  const root=useRef<HTMLElement>(null)
  const html=useMemo(()=>renderMarkdown(content),[content])
  useEffect(()=>{
    if(!editing)return
    const frame=requestAnimationFrame(()=>root.current?.querySelector<HTMLElement>('.cm-content')?.focus())
    const outside=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setEditing(false)}
    document.addEventListener('pointerdown',outside,true)
    return()=>{cancelAnimationFrame(frame);document.removeEventListener('pointerdown',outside,true)}
  },[editing])
  return <section ref={root} className={`nb-markdown-cell ${editing?'editing':''}`} onKeyDown={event=>{
    if(editing&&event.key==='Escape'&&!(event.target as HTMLElement).closest('.cm-search')){event.preventDefault();event.stopPropagation();setEditing(false)}
  }}>
    {editing?<>
      <div className="nb-cell-actions"><span>텍스트 편집 · Esc / Shift+Enter로 완료</span><button onClick={()=>setEditing(false)}>편집 완료</button><button disabled={disabled} onClick={onDelete}>삭제</button></div>
      <CodeEditor compact ariaLabel={`셀 ${index+1} 마크다운`} content={content} lang="markdown" readOnly={disabled} onChange={onChange} onSave={onSave} onRun={()=>setEditing(false)}/>
    </>:<div className="nb-markdown-preview md-rendered" tabIndex={0} aria-label={`셀 ${index+1} 텍스트, 더블클릭 또는 Enter로 편집`} title="더블클릭하여 편집" onDoubleClick={event=>{
      if(!disabled&&!(event.target as HTMLElement).closest('a'))setEditing(true)
    }} onKeyDown={event=>{
      if(event.target===event.currentTarget&&event.key==='Enter'&&!disabled){event.preventDefault();setEditing(true)}
    }}>
      {content.trim()?<div dangerouslySetInnerHTML={{__html:html}}/>:<span className="nb-markdown-empty">더블클릭하여 내용 입력</span>}
    </div>}
  </section>
}
