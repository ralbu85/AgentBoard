import {afterEach,expect,it,vi} from 'vitest'
import {MobileTerminalView} from './MobileTerminalView'
import {reflowFrame} from './reflow'
import {textLinks} from './mobileCopy'

const views:MobileTerminalView[]=[]
afterEach(()=>{for(const v of views.splice(0)){v.dispose();v.root.remove()}window.getSelection()?.removeAllRanges()})
function render(text:string,cols=16,wrappedRows:number[]=[]){
  const root=document.createElement('div');document.body.append(root)
  const view=new MobileTerminalView(root);views.push(view)
  const frame=reflowFrame(text,cols,text.split('\r\n').length,wrappedRows)
  view.render(frame.lines,frame.cursor,false,frame.copyRows)
  return view
}
function copy(range:Range){
  const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range)
  const setData=vi.fn(),event=new Event('copy',{bubbles:true,cancelable:true})
  Object.defineProperty(event,'clipboardData',{value:{setData}})
  document.body.dispatchEvent(event)
  return {text:setData.mock.calls[0]?.[1],prevented:event.defaultPrevented}
}
function all(view:MobileTerminalView){const r=document.createRange();r.selectNodeContents(view.content);return copy(r).text}
function offset(row:Element,n:number):[Node,number]{
  const walk=document.createTreeWalker(row,NodeFilter.SHOW_TEXT);let node:Node|null
  while((node=walk.nextNode())){if(n<=(node.textContent?.length||0))return [node,n];n-=node.textContent?.length||0}
  throw Error('offset outside row')
}
it('copies long commands, Unicode and whitespace without visual wrap newlines',()=>{
  const text='curl --header    "한글 🙂 test" https://example.org/very/long/resource\r\n    print("다음 줄")\r\n\r\nend'
  for(const width of [10,23,48])expect(all(render(text,width))).toBe(text.replace(/\r/g,'')+'\n')
})
it('maps partial forward or backward selections across display rows to exact source text',()=>{
  const text='abcdefghijklmnopqrstuvwxyz0123456789',view=render(text,10)
  const rows=view.content.querySelectorAll('.mobile-terminal-line'),range=document.createRange()
  range.setStart(...offset(rows[0],3));range.setEnd(...offset(rows[2],5))
  expect(copy(range).text).toBe(text.slice(3,25))
})
it('joins only verified source soft wraps and retains intentional hard newlines',()=>{
  expect(all(render('firstpart\r\nsecondpart\r\nnew paragraph',7,[0]))).toBe('firstpartsecondpart\nnew paragraph\n')
})
it('creates full links across visual wraps and ANSI style changes without HTML injection',()=>{
  const view=render('https://exam\x1b[32mple.org/long/path\x1b[0m <script>bad</script>',8)
  const anchors=[...view.content.querySelectorAll('a')]
  expect(anchors.length).toBeGreaterThan(1)
  expect(anchors.every(a=>a.href==='https://example.org/long/path'&&a.rel==='noopener noreferrer')).toBe(true)
  expect(view.content.querySelector('script')).toBeNull()
  expect(all(view)).toBe('https://example.org/long/path <script>bad</script>\n')
})
it('keeps credentials and unsafe schemes unlinked and excludes sentence punctuation',()=>{
  expect(textLinks('javascript:alert(1) file:///root/secret https://u:p@example.org')).toEqual([])
  expect(textLinks('(https://example.org/a(b)).')[0].url).toBe('https://example.org/a(b)')
})
it('does not intercept copying outside the terminal or after disposal',()=>{
  const view=render('text');view.dispose()
  const range=document.createRange();range.selectNodeContents(view.content)
  expect(copy(range)).toEqual({text:undefined,prevented:false})
})
