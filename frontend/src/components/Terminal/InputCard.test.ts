import {act,createElement} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {beforeEach,afterEach,expect,it,vi} from 'vitest'
import {InputCard} from './InputCard'
import {api} from '../../api'
import {useDrafts} from './drafts'
import {useStore} from '../../store'
const device=vi.hoisted(()=>({mobile:true}))
// Reproduce the reported desktop: the renderer uses the coarse-pointer/mobile
// path, but desktop chat input must still expose its keyboard shortcut.
vi.mock('./TerminalManager',()=>({isMobileViewport:true,pageView:vi.fn()}))
vi.mock('../../api',()=>({api:{input:vi.fn(async()=>({ok:true})),paste:vi.fn(async()=>({ok:true})),key:vi.fn()}}))
let host:HTMLDivElement,root:Root
const key=JSON.stringify(['local','input-test','/test'])
beforeEach(()=>{
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
  device.mobile=true;vi.clearAllMocks()
  vi.spyOn(navigator,'userAgent','get').mockImplementation(()=>device.mobile?'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)':'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
  vi.spyOn(navigator,'platform','get').mockImplementation(()=>device.mobile?'iPhone':'Win32')
  useStore.setState({_sessionStateRevision:-1,sessions:{'input-test':{id:'input-test',host:'local',cwd:'/test'}}} as never)
  useDrafts.setState({drafts:{[key]:'first line'}})
  host=document.createElement('div');document.body.append(host);root=createRoot(host)
  act(()=>root.render(createElement(InputCard,{sessionId:'input-test'})))
})
afterEach(()=>{act(()=>root.unmount());host.remove();useDrafts.setState({drafts:{}});vi.restoreAllMocks()})
const enter=async(options:KeyboardEventInit={})=>{
  const textarea=host.querySelector('textarea')!;textarea.focus()
  const event=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,...options})
  await act(async()=>{textarea.dispatchEvent(event)})
  return event
}

it('mobile Enter leaves native newline insertion enabled and never submits',async()=>{
  const event=await enter()
  expect(event.defaultPrevented).toBe(false)
  expect((await enter({ctrlKey:true})).defaultPrevented).toBe(false)
  expect(api.input).not.toHaveBeenCalled();expect(api.paste).not.toHaveBeenCalled();expect(api.key).not.toHaveBeenCalled()
  expect(host.querySelector('textarea')!.getAttribute('enterkeyhint')).toBe('enter')
  expect([...host.querySelectorAll('.quick-key')].some(b=>b.textContent==='⏎')).toBe(false)
  expect(host.querySelector('.send-btn')!.hasAttribute('aria-keyshortcuts')).toBe(false)
})

it('mobile Send transmits a multiline draft exactly once and clears it only on success',async()=>{
  act(()=>useDrafts.getState().write(key,'첫째\n둘째'))
  const button=host.querySelector<HTMLButtonElement>('.send-btn')!
  await act(async()=>button.click())
  expect(api.input).toHaveBeenCalledExactlyOnceWith('input-test','첫째\n둘째')
  expect(api.paste).not.toHaveBeenCalled()
  expect(useDrafts.getState().drafts[key]).toBeUndefined()
})

it('applies the successful send response immediately when the websocket update is delayed',async()=>{
  const session={...useStore.getState().sessions['input-test'],requestTitle:'방금 보낸 작업'}
  vi.mocked(api.input).mockResolvedValueOnce({ok:true,sessionState:{type:'session-state',revision:10,sessions:[session],workspaceActivity:{'["local","/test"]':100}}})
  await act(async()=>host.querySelector<HTMLButtonElement>('.send-btn')!.click())
  expect(useStore.getState().sessions['input-test'].requestTitle).toBe('방금 보낸 작업')
  expect(useStore.getState().workspaceActivity['["local","/test"]']).toBe(100)
  act(()=>useStore.getState().applySessionState({type:'session-state',revision:9,sessions:[{...session,requestTitle:'이전 요청'}]}))
  expect(useStore.getState().sessions['input-test'].requestTitle).toBe('방금 보낸 작업')
})

it('keeps multiline drafts when the terminal rejects the send',async()=>{
  act(()=>useDrafts.getState().write(key,'첫째\n\n  둘째\n'))
  vi.mocked(api.input).mockResolvedValueOnce({ok:false})
  await act(async()=>host.querySelector<HTMLButtonElement>('.send-btn')!.click())
  expect(host.querySelector('textarea')!.value).toBe('첫째\n\n  둘째\n')
  expect(useDrafts.getState().drafts[key]).toBe('첫째\n\n  둘째\n')
})

it('sends a double tap only once and preserves edits made while the send is pending',async()=>{
  const sent='첫째\n둘째'
  act(()=>useDrafts.getState().write(key,sent))
  let finish!:(value:{ok:boolean})=>void
  vi.mocked(api.input).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}))
  const button=host.querySelector<HTMLButtonElement>('.send-btn')!
  await act(async()=>{button.click();button.click()})
  expect(api.input).toHaveBeenCalledExactlyOnceWith('input-test',sent)
  act(()=>useDrafts.getState().write(key,'전송 중 새로 작성한\n메시지'))
  await act(async()=>finish({ok:true}))
  expect(host.querySelector('textarea')!.value).toBe('전송 중 새로 작성한\n메시지')
})

it('desktop Enter and Shift+Enter leave native newline insertion enabled',async()=>{
  device.mobile=false
  act(()=>root.render(createElement(InputCard,{sessionId:'input-test'})))
  expect((await enter({shiftKey:true})).defaultPrevented).toBe(false)
  expect((await enter({isComposing:true})).defaultPrevented).toBe(false)
  expect((await enter()).defaultPrevented).toBe(false)
  expect(api.input).not.toHaveBeenCalled()
  expect(host.querySelector('textarea')!.getAttribute('enterkeyhint')).toBe('enter')
})

it('desktop Ctrl+Enter works even when the terminal renderer reports a coarse-pointer device',async()=>{
  device.mobile=false
  const draft='첫째 줄\n\n  둘째 줄'
  act(()=>{useDrafts.getState().write(key,draft);root.render(createElement(InputCard,{sessionId:'input-test'}))})
  for(const options of [{isComposing:true},{keyCode:229},{shiftKey:true},{altKey:true}]){
    expect((await enter({ctrlKey:true,...options})).defaultPrevented).toBe(false)
  }
  expect(api.input).not.toHaveBeenCalled()
  expect((await enter({ctrlKey:true})).defaultPrevented).toBe(true)
  expect(api.input).toHaveBeenCalledExactlyOnceWith('input-test',draft)
  expect(useDrafts.getState().drafts[key]).toBeUndefined()
  act(()=>useDrafts.getState().write(key,'새로 작성 중'))
  expect((await enter({ctrlKey:true,repeat:true})).defaultPrevented).toBe(true)
  expect(api.input).toHaveBeenCalledTimes(1)
  expect(host.querySelector('textarea')!.value).toBe('새로 작성 중')
  expect(api.key).not.toHaveBeenCalled()
  expect(host.querySelector('.send-btn')!.getAttribute('aria-keyshortcuts')).toBe('Control+Enter')
  expect(host.querySelector('textarea')!.placeholder).toBe('메시지 입력 · Ctrl+Enter 전송')
})
