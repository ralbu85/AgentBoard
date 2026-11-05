import {type ReactNode,useEffect, useMemo, useRef, useState} from 'react'
import {renderMarkdown,type MarkdownAttachments} from '../../markdown'
import {CodeEditor} from './CodeEditor'
import {MOD} from './docSync'

/** A markdown cell: rendered text that, with ✎ 텍스트 편집 on, opens its
 *  source on click like a Markdown/HTML block. Edits are live (the notebook
 *  saves itself), so every way out — Esc, Ctrl+Enter, clicking elsewhere — keeps them. */
export function NotebookMarkdownCell({content,filePath,attachments,index,disabled,editing:editable,onChange,onSave,onDelete,insertControl}:{
  insertControl?:ReactNode;content:string;filePath?:string;attachments?:MarkdownAttachments;index:number;disabled:boolean;editing:boolean;onChange:(value:string)=>void;onSave:()=>void;onDelete:()=>void
}){
  const [editing,setEditing]=useState(false)
  const root=useRef<HTMLElement>(null)
  const html=useMemo(()=>renderMarkdown(content,filePath,attachments),[content,filePath,attachments])
  useEffect(()=>{if(!editable)setEditing(false)},[editable])
  useEffect(()=>{
    if(!editing)return
    const frame=requestAnimationFrame(()=>root.current?.querySelector<HTMLElement>('.cm-content')?.focus())
    const outside=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setEditing(false)}
    document.addEventListener('pointerdown',outside,true)
    return()=>{cancelAnimationFrame(frame);document.removeEventListener('pointerdown',outside,true)}
  },[editing])
  // An empty cell has nothing to read: it opens on click either way.
  const open=!disabled&&(editable||!content.trim())
  return <section ref={root} className={`nb-markdown-cell ${editing?'editing':''} ${open&&!editing?'nb-markdown-editable':''}`} onKeyDown={event=>{
    if(editing&&event.key==='Escape'&&!(event.target as HTMLElement).closest('.cm-search')){event.preventDefault();event.stopPropagation();setEditing(false)}
  }}>
    <div className="nb-cell-actions"><span>마크다운 · 셀 {index+1}</span><button disabled={disabled} onClick={onDelete}>셀 삭제</button>{insertControl}</div>
    {editing?<>
      <CodeEditor compact ariaLabel={`셀 ${index+1} 마크다운`} content={content} lang="markdown" readOnly={disabled} onChange={onChange} onSave={onSave} onRun={()=>setEditing(false)}/>
      <div className="md-block-editor-bar"><button className="primary" onClick={()=>setEditing(false)}>닫기</button><span className="md-block-editor-hint">자동 저장 · {MOD}+Enter 또는 Esc로 닫기</span></div>
    </>:<div className="nb-markdown-preview md-rendered" tabIndex={0} aria-label={`셀 ${index+1} 텍스트${open?', 클릭 또는 Enter로 편집':''}`} title={open?'클릭해서 편집':'✎ 텍스트 편집을 켜면 클릭해서 고칠 수 있습니다'} onClick={event=>{
      if(open&&!(event.target as HTMLElement).closest('a')&&!window.getSelection()?.toString().trim())setEditing(true)
    }} onKeyDown={event=>{
      if(open&&event.target===event.currentTarget&&event.key==='Enter'){event.preventDefault();setEditing(true)}
    }}>
      {content.trim()?<div dangerouslySetInnerHTML={{__html:html}}/>:<span className="nb-markdown-empty">{open?'클릭해서 내용 입력':'빈 마크다운 셀'}</span>}
    </div>}
  </section>
}
