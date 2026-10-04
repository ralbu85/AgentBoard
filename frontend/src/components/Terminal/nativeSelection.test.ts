import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {NativeTerminalSelection} from './nativeSelection'

let root:HTMLDivElement,rows:HTMLDivElement,controller:NativeTerminalSelection
const resume=vi.fn()
beforeEach(()=>{
  vi.useFakeTimers();resume.mockClear()
  root=document.createElement('div');rows=document.createElement('div');rows.className='xterm-rows'
  rows.innerHTML='<div><span>첫 번째 🙂</span></div><div><span>    second line</span></div>'
  root.append(rows);document.body.append(root)
  controller=new NativeTerminalSelection(root,resume)
})
afterEach(()=>{controller.dispose();root.remove();window.getSelection()?.removeAllRanges();vi.useRealTimers()})
const select=()=>{
  const range=document.createRange();range.selectNodeContents(rows)
  const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
}

it('preserves browser default selection and contextmenu without invoking xterm handlers',()=>{
  const xterm=vi.fn();rows.addEventListener('mousedown',xterm);rows.addEventListener('contextmenu',xterm)
  for(const type of ['mousedown','contextmenu']){
    const event=new MouseEvent(type,{bubbles:true,cancelable:true})
    rows.querySelector('span')!.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  }
  expect(xterm).not.toHaveBeenCalled()
})

it('holds output from first touch through native selection recognition and handle adjustment',()=>{
  controller.beginPress();expect(controller.locked).toBe(true)
  controller.endPress();vi.advanceTimersByTime(80);expect(controller.locked).toBe(true)
  select();vi.advanceTimersByTime(200);expect(controller.locked).toBe(true);expect(resume).not.toHaveBeenCalled()
  window.getSelection()!.removeAllRanges();document.dispatchEvent(new Event('selectionchange'))
  vi.advanceTimersByTime(60);select();vi.advanceTimersByTime(200)
  expect(controller.locked).toBe(true);expect(resume).not.toHaveBeenCalled()
  window.getSelection()!.removeAllRanges();document.dispatchEvent(new Event('selectionchange'))
  vi.advanceTimersByTime(130)
  expect(controller.locked).toBe(false);expect(resume).toHaveBeenCalledOnce()
})

it('does not intercept the system copy event or clear its chosen range',()=>{
  select();const value=window.getSelection()!.toString(),event=new Event('copy',{bubbles:true,cancelable:true})
  rows.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(false)
  expect(window.getSelection()!.toString()).toBe(value)
  expect(controller.locked).toBe(true)
})

it('clearing or disposing affects only this terminal selection',()=>{
  const other=document.createElement('pre');other.textContent='another pane';document.body.append(other)
  try{
    const range=document.createRange();range.selectNodeContents(other)
    window.getSelection()!.removeAllRanges();window.getSelection()!.addRange(range)
    controller.clear();expect(window.getSelection()!.toString()).toBe('another pane')
    select();controller.clear();expect(window.getSelection()!.isCollapsed).toBe(true)
    select();resume.mockClear();controller.dispose();vi.advanceTimersByTime(200)
    expect(window.getSelection()!.isCollapsed).toBe(true);expect(resume).not.toHaveBeenCalled()
  }finally{other.remove()}
})
