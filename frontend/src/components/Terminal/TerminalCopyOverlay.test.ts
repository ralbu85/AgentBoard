import {act,createElement} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {TerminalCopyOverlay} from './TerminalCopyOverlay'
import {writeClipboard} from './clipboard'

vi.mock('./clipboard',()=>({writeClipboard:vi.fn(async()=>{})}))
let host:HTMLDivElement,root:Root
const source='첫 번째 🙂\n    code = "한글"\n\n마지막 줄'
const close=vi.fn()
beforeEach(()=>{
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
  vi.clearAllMocks();window.getSelection()?.removeAllRanges()
  host=document.createElement('div');document.body.append(host);root=createRoot(host)
  act(()=>root.render(createElement(TerminalCopyOverlay,{snapshot:{text:source,firstVisibleLine:0},onClose:close})))
})
afterEach(()=>{act(()=>root.unmount());host.remove()})
const button=(label:string)=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent===label)!
const click=async(el:HTMLElement)=>{await act(async()=>el.click())}
const line=(n:number)=>host.querySelector<HTMLButtonElement>(`button[data-copy-line="${n}"]`)!

it('copies only the native range, including a partial line and Unicode characters',async()=>{
  expect(button('선택 복사').disabled).toBe(true)
  const pre=host.querySelector('pre')!
  expect(pre.textContent).toBe(source)
  const range=document.createRange()
  range.setStart(pre.children[0].firstChild!,2)
  range.setEnd(pre.children[1].firstChild!,8)
  const expected=range.toString()
  act(()=>{const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new Event('selectionchange'))})
  expect(button('선택 복사').disabled).toBe(false)
  await click(button('선택 복사'))
  expect(writeClipboard).toHaveBeenCalledWith(expected)
  expect(host.querySelector('[role=status]')?.textContent).toBe('선택한 내용을 복사했습니다.')
  expect(close).not.toHaveBeenCalled()
})

it('copies inclusive reversed line ranges without line numbers and preserves indentation/blank lines',async()=>{
  await click(button('줄 범위'))
  await click(line(3));await click(line(1))
  expect(host.querySelectorAll('.tso-line[aria-pressed=true]')).toHaveLength(3)
  expect(host.querySelector('[role=status]')?.textContent).toContain('2–4줄')
  await click(button('선택 복사'))
  expect(writeClipboard).toHaveBeenCalledWith('    code = "한글"\n\n마지막 줄')
  await click(line(0));await click(button('선택 복사'))
  expect(writeClipboard).toHaveBeenLastCalledWith('첫 번째 🙂')
})

it('does not copy a stale native selection after it is cleared or after switching modes',async()=>{
  const range=document.createRange();range.selectNodeContents(host.querySelector('pre')!)
  act(()=>{window.getSelection()!.removeAllRanges();window.getSelection()!.addRange(range);document.dispatchEvent(new Event('selectionchange'))})
  expect(button('선택 복사').disabled).toBe(false)
  act(()=>{window.getSelection()!.removeAllRanges();document.dispatchEvent(new Event('selectionchange'))})
  expect(button('선택 복사').disabled).toBe(true)
  await click(button('줄 범위'));await click(line(0));await click(button('텍스트'))
  expect(button('선택 복사').disabled).toBe(true)
  expect(writeClipboard).not.toHaveBeenCalled()
})

it('retains the chosen native range when tapping the copy control collapses browser selection',async()=>{
  const range=document.createRange();range.selectNodeContents(host.querySelector('pre')!)
  act(()=>{window.getSelection()!.removeAllRanges();window.getSelection()!.addRange(range);document.dispatchEvent(new Event('selectionchange'))})
  act(()=>{
    button('선택 복사').dispatchEvent(new Event('pointerdown',{bubbles:true,cancelable:true}))
    window.getSelection()!.removeAllRanges();document.dispatchEvent(new Event('selectionchange'))
  })
  await click(button('선택 복사'))
  expect(writeClipboard).toHaveBeenCalledWith(source)
})

it('reports denied copying without claiming success or closing the selection',async()=>{
  vi.mocked(writeClipboard).mockRejectedValueOnce(new Error('denied'))
  await click(button('줄 범위'));await click(line(1));await click(button('선택 복사'))
  expect(host.querySelector('[role=status]')?.textContent).toContain('복사하지 못했습니다.')
  expect(host.querySelectorAll('.tso-line[aria-pressed=true]')).toHaveLength(1)
  expect(close).not.toHaveBeenCalled()
})

it('handles keyboard copying in the overlay without forwarding an interrupt',async()=>{
  await click(button('줄 범위'));await click(line(0))
  const event=new KeyboardEvent('keydown',{key:'c',code:'KeyC',ctrlKey:true,bubbles:true,cancelable:true})
  await act(async()=>host.querySelector('[role=dialog]')!.dispatchEvent(event))
  expect(event.defaultPrevented).toBe(true)
  expect(writeClipboard).toHaveBeenCalledWith('첫 번째 🙂')
  act(()=>host.querySelector('[role=dialog]')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
  expect(close).toHaveBeenCalledOnce()
})
