import {afterEach,expect,it,vi} from 'vitest'
vi.hoisted(()=>Object.defineProperty(window,'matchMedia',{configurable:true,value:()=>({matches:true})}))
import * as TM from './TerminalManager'
import {textWidth} from './terminalText'

const instances:ReturnType<typeof TM.create>[]=[]
function display(id:string,width=360){
  const inst=TM.create(id);instances.push(inst);inst.opened=true
  const container=document.createElement('div')
  Object.defineProperty(container,'clientWidth',{value:width,configurable:true})
  Object.defineProperty(container,'clientHeight',{value:500,configurable:true})
  ;(inst.term as any)._core._renderService={dimensions:{css:{cell:{width:6,height:12}}}}
  container.append(inst.el)
  return {inst,container}
}
const flush=(inst:ReturnType<typeof TM.create>)=>new Promise<void>(r=>inst.term.write('',r))
const source=(text:string)=>text+'\r\n'.repeat(39)+'\r\x1b[39A\x1b[?25h'
afterEach(()=>{for(const inst of instances.splice(0))TM.destroy(inst.id)})

it('keeps mobile font size and wraps a desktop frame at phone width without missing its right edge',async()=>{
  const {inst}=display('mobile-wrap')
  const content='LEFT '+ '가나다🙂'.repeat(15)+' RIGHT'
  TM.writeSnapshot(inst.id,source(content),160,40,true,1,true)
  await flush(inst)
  expect(inst.term.cols).toBe(60)
  expect(inst.el.dataset.scale).toBe('1')
  expect(inst.el.dataset.sourceCols).toBe('160')
  expect(TM.getBufferText(inst.id).replace(/\s/g,'')).toBe(content.replace(/\s/g,''))
})

it('updates screens with different wrapped heights while keeping only original history',async()=>{
  const {inst}=display('mobile-update')
  TM.writeSnapshot(inst.id,'HISTORY\r\n'+source('wide-'+'W'.repeat(150)),160,40,true,1,true)
  await flush(inst)
  for(const text of ['short','NEXT-'+'N'.repeat(149),'last']){
    TM.writeScreen(inst.id,source(text),160,40,true,1,true)
    await flush(inst)
    expect(TM.getBufferText(inst.id).split('\n').join('')).toBe('HISTORY'+text)
  }
})

it('rotation and font changes rebuild from original output and reject stale source frames',async()=>{
  const {inst,container}=display('mobile-rotate')
  const content='X'.repeat(150)+'END'
  TM.writeSnapshot(inst.id,source(content),160,40,true,10,true);await flush(inst)
  Object.defineProperty(container,'clientWidth',{value:720,configurable:true})
  TM.refit(inst.id);await flush(inst)
  expect(inst.term.cols).toBe(120)
  expect(TM.getBufferText(inst.id).replace(/\s/g,'')).toBe(content.replace(/\s/g,''))
  TM.writeSnapshot(inst.id,source('fresh'),180,40,true,11,true)
  TM.writeScreen(inst.id,source('stale'),160,40,true,10,true);await flush(inst)
  expect(TM.getBufferText(inst.id)).toBe('fresh')
  expect(inst.el.dataset.scale).toBe('1')
})

it('retains history when mobile wrapping exceeds the normal display-row capacity',async()=>{
  const {inst}=display('mobile-long-history',180)
  const history=Array.from({length:1500},(_,i)=>`HIST-${String(i).padStart(4,'0')}:`+'X'.repeat(230)).join('\r\n')
  TM.writeSnapshot(inst.id,history+'\r\n'+source('LATEST'),240,40,true,1,true)
  await flush(inst)
  const text=TM.getBufferText(inst.id)
  expect(inst.term.options.scrollback).toBeGreaterThan(10000)
  expect(text).toContain('HIST-0000:')
  expect(text).toContain('HIST-1499:')
  expect(text).toContain('LATEST')
})

it('keeps table columns consistent across the history/screen boundary and live updates',async()=>{
  const {inst,container}=display('mobile-table-boundary',300)
  const rule=(left:string,join:string,right:string)=>left+'─'.repeat(20)+join+'─'.repeat(80)+right
  const row=(a:string,b:string)=>'│ '+a.padEnd(18)+' │ '+b.padEnd(78)+' │'
  const header=[rule('┌','┬','┐'),row('NAME','DESCRIPTION'),rule('├','┼','┤')].join('\r\n')
  const screen=(value:string)=>row('A',value)+'\r\n'+rule('└','┴','┘')+'\r\nprompt>'+ '\r\n'.repeat(37)+'\r\x1b[37A\x1b[7C\x1b[?25h'
  TM.writeSnapshot(inst.id,header+'\r\n'+screen('ORIGINAL'),120,40,true,1,true)
  await flush(inst)
  TM.writeScreen(inst.id,screen('REPLACED-'+'Z'.repeat(65)),120,40,true,1,true)
  await flush(inst)
  const text=TM.getBufferText(inst.id),rows=text.split('\n').filter(line=>line.startsWith('│'))
  expect(text).not.toContain('ORIGINAL')
  expect(text).toContain('REPLACED-')
  expect(rows.every(line=>line.length===rows[0].length)).toBe(true)
  expect(rows.every(line=>line.indexOf('│',1)===rows[0].indexOf('│',1))).toBe(true)
  expect(text.match(/Z/g)).toHaveLength(65)
  expect(inst.term.buffer.active.cursorX).toBe(7)
  Object.defineProperty(container,'clientWidth',{value:240,configurable:true})
  TM.refit(inst.id);await flush(inst)
  const rotated=TM.getBufferText(inst.id)
  expect(rotated.split('\n').every(line=>textWidth(line)<=40)).toBe(true)
  expect(rotated.match(/Z/g)).toHaveLength(65)
  expect(rotated).toContain('DESCRIPTION')
  inst.term.scrollLines(-2)
  const position=inst.term.buffer.active.viewportY
  TM.writeScreen(inst.id,screen('AFTER-READING'),120,40,true,1,true)
  await flush(inst)
  expect(TM.getBufferText(inst.id)).toBe(rotated)
  expect(inst.term.buffer.active.viewportY).toBe(position)
  TM.scrollToBottom(inst.id);await flush(inst)
  expect(TM.getBufferText(inst.id)).toContain('AFTER-READING')
  expect(TM.getBufferText(inst.id)).not.toContain('REPLACED-')
})

it('keeps a soft-wrapped paragraph joined across history, live updates and reading pauses',async()=>{
  const {inst,container}=display('mobile-paragraph-boundary',180)
  const history='HISTORY\r\nalpha beta gamm\r\n'
  TM.writeSnapshot(inst.id,history+source('a delta original'),80,40,true,1,true,[1])
  await flush(inst)
  const words=()=>TM.getBufferText(inst.id).trim().split(/\s+/)
  expect(words()).toEqual('HISTORY alpha beta gamma delta original'.split(' '))
  TM.writeScreen(inst.id,source('a delta updated'),80,40,true,1,true,[])
  await flush(inst)
  expect(words()).toEqual('HISTORY alpha beta gamma delta updated'.split(' '))
  Object.defineProperty(container,'clientWidth',{value:240,configurable:true})
  TM.refit(inst.id);await flush(inst)
  expect(words()).toEqual('HISTORY alpha beta gamma delta updated'.split(' '))
  inst.term.scrollLines(-1)
  const reading=TM.getBufferText(inst.id),position=inst.term.buffer.active.viewportY
  TM.writeScreen(inst.id,source('a delta latest'),80,40,true,1,true,[])
  await flush(inst)
  expect(TM.getBufferText(inst.id)).toBe(reading)
  expect(inst.term.buffer.active.viewportY).toBe(position)
  TM.scrollToBottom(inst.id);await flush(inst)
  expect(words()).toEqual('HISTORY alpha beta gamma delta latest'.split(' '))
})

it('uses native scrolling in the actual mobile mount and keeps DOM stable during reading and copy',async()=>{
  const id='native-mobile-mount',inst=TM.create(id);instances.push(inst)
  const container=document.createElement('div');document.body.append(container)
  Object.defineProperty(container,'clientWidth',{value:360});Object.defineProperty(container,'clientHeight',{value:500})
  try{
    TM.open(id,container)
    Object.defineProperty(inst.el,'clientHeight',{value:500})
    Object.defineProperty(inst.el,'scrollHeight',{value:1600})
    inst.el.scrollTop=1100
    TM.writeSnapshot(id,'HISTORY\r\n'+source('ORIGINAL'),160,40,true,1,true);await flush(inst)
    expect(inst.el.querySelector('.xterm-viewport')).toBeNull()
    expect(inst.mobileView?.content.textContent).toBe('HISTORY\nORIGINAL\n')
    inst.el.scrollTop=200
    const node=inst.mobileView!.content.querySelector('.mobile-terminal-line')
    TM.writeScreen(id,source('NEW OUTPUT'),160,40,true,1,true);await flush(inst)
    expect(inst.mobileView!.content.textContent).toContain('ORIGINAL')
    expect(inst.el.scrollTop).toBe(200)
    expect(inst.mobileView!.content.querySelector('.mobile-terminal-line')).toBe(node)
    const touch=new Event('touchmove',{bubbles:true,cancelable:true})
    Object.defineProperty(touch,'touches',{value:[{clientX:10,clientY:50}]})
    inst.mobileView!.content.dispatchEvent(touch)
    expect(touch.defaultPrevented).toBe(false)
    TM.scrollToBottom(id);await flush(inst)
    expect(inst.mobileView!.content.textContent).toContain('NEW OUTPUT')
    const range=document.createRange();range.selectNodeContents(inst.mobileView!.content)
    window.getSelection()!.addRange(range)
    const selected=window.getSelection()!.toString()
    TM.writeSnapshot(id,source('AFTER COPY'),180,40,true,2,true)
    expect(window.getSelection()!.toString()).toBe(selected)
    expect(inst.mobileView!.content.textContent).not.toContain('AFTER COPY')
    TM.clearNativeSelection(id);await flush(inst)
    expect(inst.mobileView!.content.textContent).toContain('AFTER COPY')
  }finally{TM.destroy(id);container.remove()}
})

it('reopens mobile history at the latest output even when DOM reattachment resets the offset',async()=>{
  const id='native-return',inst=TM.create(id);instances.push(inst)
  const old=document.createElement('div'),next=document.createElement('div')
  for(const container of [old,next]){
    document.body.append(container)
    Object.defineProperty(container,'clientWidth',{value:360})
    Object.defineProperty(container,'clientHeight',{value:500})
  }
  try{
    TM.open(id,old)
    Object.defineProperty(inst.el,'clientHeight',{value:500})
    Object.defineProperty(inst.el,'scrollHeight',{value:1600})
    inst.el.scrollTop=1100
    TM.writeSnapshot(id,'HISTORY\r\n'+source('ORIGINAL'),160,40,true,1,true)
    inst.el.scrollTop=200
    TM.writeSnapshot(id,'GROWN HISTORY\r\n'+source('MISSED OUTPUT'),160,40,true,1,true)
    TM.unmountFrom(id,old)
    inst.el.scrollTop=0 // detached native elements can lose their old offset
    TM.mountInto(id,next);await flush(inst)
    expect(TM.getBufferText(id)).toContain('MISSED OUTPUT')
    expect(inst.mobileView?.scrolledUp).toBe(false)
    inst.el.scrollTop=0 // model a delayed mobile layout adjustment
    TM.writeSnapshot(id,'NEW HISTORY\r\n'+source('LATEST OUTPUT'),160,40,true,1,true)
    expect(TM.getBufferText(id)).toContain('LATEST OUTPUT')
    expect(inst.mobileView?.scrolledUp).toBe(false)
    // Once visible, an actual reading gesture still freezes content in place.
    inst.el.dispatchEvent(new Event('pointerdown'))
    inst.el.scrollTop=180
    TM.writeSnapshot(id,source('AFTER READING'),160,40,true,1,true)
    expect(inst.el.scrollTop).toBe(180)
    expect(TM.getBufferText(id)).toContain('LATEST OUTPUT')
    TM.scrollToBottom(id)
    expect(TM.getBufferText(id)).toContain('AFTER READING')
  }finally{TM.destroy(id);old.remove();next.remove()}
})

it('keeps only the selected terminal mounted when the mobile pane is reused',async()=>{
  const container=document.createElement('div');document.body.append(container)
  Object.defineProperty(container,'clientWidth',{value:360});Object.defineProperty(container,'clientHeight',{value:500})
  const first=TM.create('native-first'),second=TM.create('native-second');instances.push(first,second)
  try{
    TM.mountInto(first.id,container)
    TM.unmountFrom(first.id,container)
    TM.mountInto(second.id,container)
    await flush(second)
    expect(container.querySelectorAll('.xterm-wrap')).toHaveLength(1)
    expect(container.firstElementChild).toBe(second.el)
    expect(first.el.isConnected).toBe(false)
  }finally{TM.destroy(first.id);TM.destroy(second.id);container.remove()}
})
