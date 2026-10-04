import {act,createElement} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {ConversationView,conversationHtml} from './ConversationView'

let container:HTMLDivElement,root:Root
beforeEach(()=>{
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
  container=document.createElement('div');document.body.append(container);root=createRoot(container)
})
afterEach(()=>{act(()=>root.unmount());container.remove();vi.unstubAllGlobals();vi.useRealTimers()})
it('renders safe Markdown without automatic remote image requests or unsafe links',()=>{
  const html=conversationHtml('![tracking](https://tracker.example/image) [unsafe](file:///root/secret) [safe](https://example.org) <script>bad()</script> <div style="background:url(https://tracker.example)">text</div> <svg><image href="https://tracker.example" /></svg>')
  const el=document.createElement('div');el.innerHTML=html
  expect(el.querySelector('img,script,iframe,svg,[style],[src],[srcset]')).toBeNull()
  const link=el.querySelector('a[href]') as HTMLAnchorElement
  expect(link.href).toBe('https://example.org/');expect(link.rel).toBe('noopener noreferrer')
})
it('does not silently select the latest conversation when ownership is unknown',async()=>{
  const fetcher=vi.fn(async()=>({ok:true,json:async()=>({available:false,messages:[],before:null,choices:[{key:'codex:id',provider:'codex',timestamp:'2026-10-04',id:'id'}]})}))
  vi.stubGlobal('fetch',fetcher)
  await act(async()=>root.render(createElement(ConversationView,{sessionId:'1'})))
  expect(container.querySelector('select')!.value).toBe('')
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(container.querySelectorAll('article')).toHaveLength(0)
})
it('discards a stale response after switching terminal sessions',async()=>{
  let firstResolve:(v:unknown)=>void=()=>{}
  const first=new Promise(resolve=>{firstResolve=resolve})
  const page=(text:string)=>({ok:true,json:async()=>({available:true,source:text,provider:'codex',messages:[{id:'1',role:'assistant',text}],choices:[],before:null})})
  vi.stubGlobal('fetch',vi.fn().mockReturnValueOnce(first).mockResolvedValue(page('correct')))
  await act(async()=>root.render(createElement(ConversationView,{sessionId:'1'})))
  await act(async()=>root.render(createElement(ConversationView,{sessionId:'2'})))
  await act(async()=>firstResolve(page('wrong session')))
  expect(container.textContent).toContain('correct')
  expect(container.textContent).not.toContain('wrong session')
})
