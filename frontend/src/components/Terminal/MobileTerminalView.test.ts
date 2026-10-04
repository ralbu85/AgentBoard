import {afterEach,expect,it,vi} from 'vitest'
import {MobileTerminalView} from './MobileTerminalView'
import {NativeTerminalSelection} from './nativeSelection'
import {reflowFrame} from './reflow'

const roots:HTMLElement[]=[]
function view(){
  const root=document.createElement('div');document.body.append(root);roots.push(root)
  Object.defineProperty(root,'clientHeight',{value:400,configurable:true})
  Object.defineProperty(root,'scrollHeight',{value:1200,configurable:true})
  return {root,view:new MobileTerminalView(root)}
}
afterEach(()=>{roots.splice(0).forEach(r=>r.remove());window.getSelection()?.removeAllRanges();vi.useRealTimers()})

it('uses native text and one scroll surface without injecting HTML or input controls',()=>{
  const {root,view:v}=view()
  const text='한글 <img src=x onerror=alert(1)>\r\n    code_line()\r\n\r\nEND'
  const frame=reflowFrame(text,80,4)
  v.measure(12,1);v.render(frame.lines,frame.cursor,true)
  expect(v.content.textContent).toBe(text.replace(/\r/g,'')+'\n')
  expect(root.querySelector('img,script,textarea,.xterm-viewport')).toBeNull()
  expect(v.content.style.fontSize).toBe('12px')
  expect(root.scrollTop).toBe(1200)
})

it('retains earlier row nodes and reading offset when only the status row changes',()=>{
  const {root,view:v}=view()
  v.render(['history','\x1b[32mworking'],undefined,true)
  const history=v.content.querySelector('.mobile-terminal-line')
  root.scrollTop=150
  v.render(['history','\x1b[33mdone'],undefined,false)
  expect(v.content.querySelector('.mobile-terminal-line')).toBe(history)
  expect(root.scrollTop).toBe(150)
  expect(v.content.textContent).toBe('history\ndone\n')
  expect(v.content.querySelectorAll('.mobile-terminal-line span')[1].getAttribute('style')).toContain('color')
  expect(v.scrolledUp).toBe(true)
})

it('keeps native range copy and default scrolling available in the same terminal',()=>{
  const {root,view:v}=view();v.render(['first','second'],undefined,false)
  const controller=new NativeTerminalSelection(root,vi.fn())
  try{
    const range=document.createRange();range.selectNodeContents(v.content)
    window.getSelection()!.addRange(range)
    expect(controller.selected).toBe(true)
    expect(window.getSelection()!.toString()).toBe('first\nsecond\n')
    const event=new Event('touchmove',{bubbles:true,cancelable:true});v.content.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    const copy=new Event('copy',{bubbles:true,cancelable:true});v.content.dispatchEvent(copy)
    expect(copy.defaultPrevented).toBe(false)
  }finally{controller.dispose()}
})

it('does not copy the caret or reveal concealed terminal characters visually',()=>{
  const {view:v}=view();v.render(['prompt> \x1b[8mconcealed\x1b[0m'],{row:0,col:8,visible:true},false)
  expect(v.content.querySelector('.mobile-terminal-caret')!.textContent).toBe('')
  expect((v.content.querySelector('.mobile-terminal-caret') as HTMLElement).style.left).toBe('8ch')
  expect(v.content.querySelectorAll('.mobile-terminal-line span')[1].getAttribute('style')).toContain('visibility: hidden')
})

it('searches the native document and removes stale rows after a smaller frame',()=>{
  const {view:v}=view();v.render(['alpha','찾을 문장','stale row'],undefined,false)
  v.search('찾을');expect(window.getSelection()!.toString()).toBe('찾을')
  window.getSelection()!.removeAllRanges()
  v.render(['latest'],undefined,false)
  expect(v.content.textContent).toBe('latest\n')
})

it('keeps the same reading line when a geometry snapshot shifts earlier history',()=>{
  const {root,view:v}=view()
  v.render(['first','second','READ HERE','fourth'],undefined,false)
  root.scrollTop=25
  v.render(['new earlier row','first','second','READ HERE','fourth'],undefined,false)
  expect(root.scrollTop).toBe(37)
})
