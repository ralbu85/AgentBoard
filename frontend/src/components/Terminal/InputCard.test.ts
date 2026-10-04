import {act,createElement} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {beforeEach,afterEach,expect,it,vi} from 'vitest'
import {InputCard} from './InputCard'
import {api} from '../../api'
import {useDrafts} from './drafts'
import {useStore} from '../../store'
const device=vi.hoisted(()=>({mobile:true}))
vi.mock('./TerminalManager',()=>({get isMobileViewport(){return device.mobile},pageView:vi.fn()}))
vi.mock('../../api',()=>({api:{input:vi.fn(async()=>({ok:true})),paste:vi.fn(async()=>({ok:true})),key:vi.fn()}}))
let host:HTMLDivElement,root:Root
const key=JSON.stringify(['local','input-test','/test'])
beforeEach(()=>{
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
  device.mobile=true;vi.clearAllMocks()
  useStore.setState({sessions:{'input-test':{id:'input-test',host:'local',cwd:'/test'}}} as never)
  useDrafts.setState({drafts:{[key]:'first line'}})
  host=document.createElement('div');document.body.append(host);root=createRoot(host)
  act(()=>root.render(createElement(InputCard,{sessionId:'input-test'})))
})
afterEach(()=>{act(()=>root.unmount());host.remove();useDrafts.setState({drafts:{}})})
const enter=async(options:KeyboardEventInit={})=>{
  const textarea=host.querySelector('textarea')!;textarea.focus()
  const event=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,...options})
  await act(async()=>{textarea.dispatchEvent(event)})
  return event
}

it('mobile Enter leaves native newline insertion enabled and never submits',async()=>{
  const event=await enter()
  expect(event.defaultPrevented).toBe(false)
  expect(api.input).not.toHaveBeenCalled();expect(api.paste).not.toHaveBeenCalled();expect(api.key).not.toHaveBeenCalled()
  expect(host.querySelector('textarea')!.getAttribute('enterkeyhint')).toBe('enter')
  expect([...host.querySelectorAll('.quick-key')].some(b=>b.textContent==='⏎')).toBe(false)
})

it('mobile Send transmits a multiline draft exactly once and clears it only on success',async()=>{
  act(()=>useDrafts.getState().write(key,'첫째\n둘째'))
  const button=host.querySelector<HTMLButtonElement>('.send-btn')!
  await act(async()=>button.click())
  expect(api.paste).toHaveBeenCalledExactlyOnceWith('input-test','첫째\n둘째')
  expect(api.input).not.toHaveBeenCalled()
  expect(useDrafts.getState().drafts[key]).toBeUndefined()
})

it('desktop Enter still submits while Shift+Enter and IME composition do not',async()=>{
  device.mobile=false
  act(()=>root.render(createElement(InputCard,{sessionId:'input-test'})))
  expect((await enter({shiftKey:true})).defaultPrevented).toBe(false)
  expect((await enter({isComposing:true})).defaultPrevented).toBe(false)
  expect(api.input).not.toHaveBeenCalled()
  expect((await enter()).defaultPrevented).toBe(true)
  expect(api.input).toHaveBeenCalledExactlyOnceWith('input-test','first line')
})
