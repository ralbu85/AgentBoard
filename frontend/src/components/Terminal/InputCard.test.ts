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
  expect(api.input).toHaveBeenCalledExactlyOnceWith('input-test','첫째\n둘째')
  expect(api.paste).not.toHaveBeenCalled()
  expect(useDrafts.getState().drafts[key]).toBeUndefined()
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

it('desktop Enter still submits while Shift+Enter and IME composition do not',async()=>{
  device.mobile=false
  act(()=>root.render(createElement(InputCard,{sessionId:'input-test'})))
  expect((await enter({shiftKey:true})).defaultPrevented).toBe(false)
  expect((await enter({isComposing:true})).defaultPrevented).toBe(false)
  expect(api.input).not.toHaveBeenCalled()
  expect((await enter()).defaultPrevented).toBe(true)
  expect(api.input).toHaveBeenCalledExactlyOnceWith('input-test','first line')
})

it.each([true,false])('Ctrl+Enter sends the full draft once with IME and repeat protection (mobile=%s)',async(mobile)=>{
  device.mobile=mobile
  const draft='첫째 줄\n\n  둘째 줄'
  act(()=>{useDrafts.getState().write(key,draft);root.render(createElement(InputCard,{sessionId:'input-test'}))})
  for(const options of [{isComposing:true},{keyCode:229},{shiftKey:true}]){
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
})
