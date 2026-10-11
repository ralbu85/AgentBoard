import {afterEach,expect,it,vi} from 'vitest'
import {MobileTerminalView} from './MobileTerminalView'
import {NativeTerminalSelection} from './nativeSelection'
import {reflowFrame} from './reflow'
import {plainText,textWidth} from './terminalText'

const roots:HTMLElement[]=[],views:MobileTerminalView[]=[]
function view(){
  const root=document.createElement('div');document.body.append(root);roots.push(root)
  Object.defineProperty(root,'clientHeight',{value:400,configurable:true})
  Object.defineProperty(root,'scrollHeight',{value:1200,configurable:true})
  const view=new MobileTerminalView(root);views.push(view)
  return {root,view}
}
afterEach(()=>{views.splice(0).forEach(v=>v.dispose());roots.splice(0).forEach(r=>r.remove());window.getSelection()?.removeAllRanges();vi.restoreAllMocks();vi.useRealTimers()})

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

it('anchors mixed-font table borders to measured terminal columns without breaking graphemes',()=>{
  const {view:v}=view()
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({width:618.75} as DOMRect)
  expect(v.measure(12,1).width).toBe(6.1875)
  const values=[['이름','결과'],['\x1b[1;32m한글\x1b[0m','🙂 완료'],['e\u0301','👩🏽‍💻'],['가','✓ → ·']]
  const rule=(left:string,middle:string,right:string)=>left+'─'.repeat(12)+middle+'─'.repeat(18)+right
  const lines=[rule('┌','┬','┐'),...values.map(row=>'│'+row.map((cell,i)=>' '+cell+' '.repeat([10,16][i]-textWidth(cell))+' │').join('')),rule('└','┴','┘')]
  const frame=reflowFrame(lines.join('\r\n'),48,lines.length)
  v.render(frame.lines,undefined,false,frame.copyRows)
  expect(v.content.style.getPropertyValue('--mobile-cell-width')).toBe('6.1875px')
  const grids=[...v.content.querySelectorAll<HTMLElement>('.mobile-terminal-grid')]
  expect(grids).toHaveLength(lines.length)
  for(const grid of grids){
    expect(grid.style.gridTemplateColumns).toBe('repeat(33, var(--mobile-cell-width, .5em))')
    const borders=[...grid.querySelectorAll<HTMLElement>('.mobile-terminal-grid-run > span')].filter(cell=>/^[│┌┬┐└┴┘]$/.test(cell.textContent!))
    // Column starts are fixed even across ANSI runs, wide glyphs and fallback
    // emoji fonts. Nested tracks align to the same absolute row coordinates.
    expect(borders.map(cell=>parseInt(cell.parentElement!.style.gridColumn)+parseInt(cell.style.gridColumn)-2)).toEqual([0,13,32])
  }
  const cells=[...v.content.querySelectorAll('.mobile-terminal-grid-run > span')].map(cell=>cell.textContent)
  expect(cells).toContain('e\u0301');expect(cells).toContain('👩🏽‍💻');expect(cells).toContain('가')
  expect(v.content.textContent).toBe(lines.map(plainText).join('\n')+'\n')
  const first=grids[0]
  v.render(frame.lines,undefined,false,frame.copyRows)
  expect(v.content.querySelector('.mobile-terminal-grid')).toBe(first)
})

it('leaves prose on the native text path and updates grid widths when fonts load',()=>{
  const {view:v}=view()
  v.measure(12,1);v.render(['text 🙂 remains ordinary','│ a │ 한글 │'],undefined,false)
  expect(v.content.querySelectorAll('.mobile-terminal-grid')).toHaveLength(1)
  const original=v.content.querySelector('.mobile-terminal-grid')
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({width:650} as DOMRect)
  v.invalidateMeasure();v.measure(13,1)
  expect(v.content.style.getPropertyValue('--mobile-cell-width')).toBe('6.5px')
  expect(v.content.querySelector('.mobile-terminal-grid')).toBe(original)
})
