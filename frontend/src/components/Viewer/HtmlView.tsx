import {useMemo,useState} from 'react'
import {CodeEditor} from './CodeEditor'

export function HtmlView({content,onChange,onSave}:{content:string;onChange?:(value:string)=>void;onSave?:()=>void}){
  const [source,setSource]=useState(false)
  const [generation,setGeneration]=useState(0)
  const document=useMemo(()=>{
    // Opaque sandbox origin + CSP: HTML cannot access the app, its API,
    // local files, or credentials. Only embedded resources run in this viewer.
    const policy="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
    return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${content}</body></html>`
  },[content])
  return <div className="html-view">
    <div className="html-view-toolbar">
      <button aria-pressed={!source} onClick={()=>setSource(false)}>미리보기</button>
      <button aria-pressed={source} onClick={()=>setSource(true)}>HTML 소스</button>
      {!source&&<button onClick={()=>setGeneration(n=>n+1)}>미리보기 새로고침</button>}
      <span>외부 리소스·서버 연결 제외</span>
    </div>
    {source?<CodeEditor content={content} lang="html" readOnly={!onChange} onChange={onChange||(()=>{})} onSave={onSave||(()=>{})}/>
      :<iframe key={generation} title="HTML 미리보기" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={document}/>}
  </div>
}
