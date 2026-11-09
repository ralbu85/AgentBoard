import {type ReactNode,useEffect,useRef,useState} from 'react'
import type {MarkdownAttachments} from '../../markdown'
import {CodeEditor} from './CodeEditor'
import type {DocEdit} from './DocSurface'
import {MOD} from './docSync'
import {MarkdownPreview} from './MarkdownPreview'

/** A markdown cell, edited like a Markdown file: with ✎ 텍스트 편집 on, a click
 *  on a paragraph, heading or list item edits its text where it is rendered
 *  (other blocks open their own markdown). 원문 opens the whole cell's markdown,
 *  and so does a click on an empty cell. Edits are live (the notebook saves
 *  itself), so every way out — Esc, Ctrl+Enter, clicking elsewhere — keeps them. */
export function NotebookMarkdownCell({content,filePath,attachments,index,doc,raw=false,onChange,onSave,onDelete,insertControl}:{
  insertControl?:ReactNode;content:string;filePath?:string;attachments?:MarkdownAttachments;index:number;doc:DocEdit;onChange:(value:string)=>void;onSave:()=>void;onDelete:()=>void
  raw?:boolean   // the notebook's 소스 view: every cell shows its markdown
}){
  const [opened,setSource]=useState(false)
  const source=raw||opened
  const root=useRef<HTMLElement>(null)
  const disabled=!doc.writable
  useEffect(()=>{
    if(!opened)return
    const frame=requestAnimationFrame(()=>root.current?.querySelector<HTMLElement>('.cm-content')?.focus())
    const outside=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setSource(false)}
    document.addEventListener('pointerdown',outside,true)
    return()=>{cancelAnimationFrame(frame);document.removeEventListener('pointerdown',outside,true)}
  },[opened])
  const openSource=()=>{if(!disabled)setSource(true)}
  const empty=!content.trim()
  return <section ref={root} className={`nb-markdown-cell ${source?'editing':''} ${empty&&!source&&!disabled?'nb-markdown-editable':''}`} onKeyDown={event=>{
    if(opened&&event.key==='Escape'&&!(event.target as HTMLElement).closest('.cm-search')){event.preventDefault();event.stopPropagation();setSource(false)}
  }}>
    <div className="nb-cell-actions"><span>마크다운 · 셀 {index+1}</span>
      {!source&&<button disabled={disabled} onClick={openSource} title="셀 전체를 마크다운 원문으로 고칩니다">원문</button>}
      <button disabled={disabled} onClick={onDelete}>셀 삭제</button>{insertControl}</div>
    {source?<>
      <CodeEditor compact ariaLabel={`셀 ${index+1} 마크다운`} content={content} lang="markdown" readOnly={disabled} onChange={onChange} onSave={onSave} onRun={()=>setSource(false)}/>
      {!raw&&<div className="md-block-editor-bar"><button className="primary" onClick={()=>setSource(false)}>닫기</button><span className="md-block-editor-hint">자동 저장 · {MOD}+Enter 또는 Esc로 닫기</span></div>}
    </>:empty
      // An empty cell has nothing to click on in place: it opens as markdown.
      ?<div className="nb-markdown-preview" tabIndex={0} aria-label={`셀 ${index+1}, 비어 있음`} onClick={openSource} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();openSource()}}}>
        <span className="nb-markdown-empty">{disabled?'빈 마크다운 셀':'클릭해서 내용 입력'}</span>
      </div>
      :<div className="nb-markdown-preview"><MarkdownPreview content={content} filePath={filePath} attachments={attachments} doc={doc} zoomable={false}/></div>}
  </section>
}
