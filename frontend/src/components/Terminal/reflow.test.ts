import {expect,it} from 'vitest'
import {Terminal} from '@xterm/xterm'
import {Unicode11Addon} from '@xterm/addon-unicode11'
import {reflowFrame,replaceSourceScreen,replaceFrameScreen,mobileHistoryTail,fitHistoryTables} from './reflow'
import {plainText,textWidth,wrapText} from './terminalText'

async function render(data:string,cols:number,sourceRows:number){
  const frame=reflowFrame(data,cols,sourceRows)
  const term=new Terminal({cols,rows:frame.rows,allowProposedApi:true})
  term.loadAddon(new Unicode11Addon());term.unicode.activeVersion='11'
  await new Promise<void>(resolve=>term.write(frame.data,resolve))
  return {term,frame,text:()=>Array.from({length:term.buffer.active.length},(_,i)=>term.buffer.active.getLine(i)!.translateToString(true)).join('\n')}
}

it('wraps colored wide output without dropping Hangul, emoji, combining marks or the last column',async()=>{
  const original='LEFT 한글🙂e\u0301 '+'1234567890'.repeat(19)+' RIGHT'
  const {term,text,frame}=await render('\x1b[32m'+original+'\x1b[0m',51,1)
  try{
    expect(text().split('\n').join('')).toBe(original)
    expect(frame.rows).toBeGreaterThan(3)
    expect(term.buffer.active.getLine(0)!.getCell(0)!.getFgColor()).toBe(2)
  }finally{term.dispose()}
})

it('maps a cursor inside a wrapped source row after history and keeps empty prompt cells',async()=>{
  const source='history\r\n'+'a'.repeat(79)+'한글END\r\n'+'\r\n'.repeat(38)+'\r\x1b[39A\x1b[83C\x1b[?25h'
  const {term,text}=await render(source,50,40)
  try{
    expect(text()).toContain('한글END')
    expect(term.buffer.active.cursorY).toBe(1)
    expect(term.buffer.active.cursorX).toBe(33)
    expect(term.rows).toBe(2) // source padding doesn't add 39 blank rows
  }finally{term.dispose()}
})

it('keeps the empty cursor row while trimming unused source padding',async()=>{
  const {term}=await render('abc\r\n'+ '\r\n'.repeat(38)+'\r\x1b[38A\x1b[9C\x1b[?25h',50,40)
  try{expect(term.rows).toBe(2);expect(term.buffer.active.cursorY).toBe(1);expect(term.buffer.active.cursorX).toBe(9)}finally{term.dispose()}
})

it('replaces the source screen before reflow so updates never accumulate stale wrapped rows',async()=>{
  const first='history\r\n'+('W'.repeat(160)+'\r\n').repeat(2)+'old\r\x1b[?25h'
  const combined=replaceSourceScreen(first,'new\r\n\r\n\r\x1b[2A\x1b[3C\x1b[?25h',3)
  const {term,text}=await render(combined,50,3)
  try{expect(text()).toBe('history\nnew');expect(term.buffer.active.cursorX).toBe(3)}finally{term.dispose()}
})

it('changing device width reflows from source, not already-wrapped text',()=>{
  const data='0123456789'.repeat(24)+'\r\nEND'
  const narrow=reflowFrame(data,47,2),wide=reflowFrame(data,120,2)
  expect(plainText(narrow.data).split('\r\n').join('')).toBe(data.split('\r\n').join(''))
  expect(plainText(wide.data).split('\r\n').join('')).toBe(data.split('\r\n').join(''))
  expect(narrow.rows).toBe(7);expect(wide.rows).toBe(3)
})

it('keeps English words and Korean eojeol together without introducing leading fragments',()=>{
  const words='모바일에서도 자연스러운 줄바꿈으로 터미널 출력을 읽습니다. alpha beta gamma delta'
  const lines=wrapText(words,22).lines.map(plainText)
  expect(lines.every(line=>textWidth(line)<=22)).toBe(true)
  expect(lines.every(line=>line===line.trimStart())).toBe(true)
  expect(lines.join(' ').trim().split(/\s+/)).toEqual(words.split(' '))
  expect(wrapText('alpha beta gamma',10).lines.map(s=>plainText(s).trimEnd())).toEqual(['alpha beta','gamma'])
})

it('keeps combining marks, emoji sequences and flags on one display line',()=>{
  for(const cluster of ['e\u0301','👩‍🔬','🇰🇷','👍🏽']){
    const rows=wrapText('X'.repeat(11)+' '+cluster+' END',14).lines.map(plainText)
    expect(rows.some(row=>row.includes(cluster))).toBe(true)
    expect(rows.every(row=>textWidth(row)<=14)).toBe(true)
  }
})

it('joins verified source wraps once while preserving explicit newlines and code indentation',()=>{
  const data='alpha beta gamm\r\na delta epsilon\r\n    code_line()\r\nnext paragraph'
  const frame=reflowFrame(data,22,4,[0])
  const rows=plainText(frame.data).split('\r\n')
  expect(rows.map(s=>s.trimEnd())).toEqual(['alpha beta gamma delta','epsilon','    code_line()','next paragraph'])
  expect(plainText(reflowFrame(data,22,4,[]).data).split('\r\n')[0]).toBe('alpha beta gamm')
})

it('maps cursor and source-history seam through joined lines and fresh screen replacement',()=>{
  const snapshot={data:'history\r\nalpha beta gamm\r\na delta epsilon\r\nold\r\x1b[1A\x1b[7C\x1b[?25h',wrappedRows:[1]}
  const updated=replaceFrameScreen(snapshot,{data:'a delta epsilon\r\nprompt\r\x1b[1A\x1b[6C\x1b[?25h'},2)
  expect(updated.wrappedRows).toEqual([1])
  const frame=reflowFrame(updated.data,22,2,updated.wrappedRows)
  expect(frame.historySeam).toBe(true)
  expect(frame.historyRows).toBe(1)
  expect(plainText(frame.data)).not.toContain('gamm\r\na')
  expect(frame.data).toMatch(/\r\x1b\[2A\x1b\[21C\x1b\[\?25h$/)
})

it('cached history plus a live tail matches full reflow across tables, soft wraps and footer updates',()=>{
  const padding='\r\n'.repeat(36)+'\r\x1b[36A\x1b[?25h'
  const header='┌'+'─'.repeat(18)+'┬'+'─'.repeat(80)+'┐\r\n│ NAME             │ DESCRIPTION'+ ' '.repeat(68)+' │\r\n├'+'─'.repeat(18)+'┼'+'─'.repeat(80)+'┤'
  const screen=(text:string)=>'│ A                │ '+text.padEnd(78)+' │\r\n└'+'─'.repeat(18)+'┴'+'─'.repeat(80)+'┘\r\n❯ prompt\r\n'+ '─'.repeat(101)+padding
  const history=Array.from({length:150},(_,i)=>`\x1b[${i%2?32:33}mHISTORY-${i}\x1b[0m`).join('\r\n')
  for(const cols of [29,53,91]){
    const snapshot={data:history+'\r\n'+header+'\r\n'+screen('old')}
    const full=reflowFrame(snapshot.data,cols,40),cache=mobileHistoryTail(snapshot,40,full)
    expect(cache.prefix.length).toBeGreaterThan(100)
    for(const value of ['short','long-'+'Z'.repeat(65)]){
      const live={data:screen(value)},merged=replaceFrameScreen(snapshot,live,40),tail=replaceFrameScreen(cache.source,live,40)
      const expected=reflowFrame(merged.data,cols,40,merged.wrappedRows),actual=reflowFrame(tail.data,cols,40,tail.wrappedRows)
      expect([...cache.prefix,...actual.lines].map(plainText)).toEqual(expected.lines.map(plainText))
      expect(actual.cursor&&actual.cursor.row+cache.prefix.length).toBe(expected.cursor?.row)
    }
  }
  const snapshot={data:history+'\r\nalpha beta gamm\r\na delta original\r\nprompt',wrappedRows:[150]}
  const projected=reflowFrame(snapshot.data,25,2,snapshot.wrappedRows),cache=mobileHistoryTail(snapshot,2,projected)
  const live={data:'a delta changed\r\nprompt'},tail=replaceFrameScreen(cache.source,live,2),merged=replaceFrameScreen(snapshot,live,2)
  expect([...cache.prefix,...reflowFrame(tail.data,25,2,tail.wrappedRows).lines].map(plainText)).toEqual(reflowFrame(merged.data,25,2,merged.wrappedRows).lines.map(plainText))
})

// What tmux does to a row when the pane narrows: hard-wrap by cell width; a wide
// glyph that misses the last column starts the next row.
function tmuxWrap(row:string,cols:number){
  const rows:string[]=[];let current='',used=0
  for(const char of Array.from(row)){
    const size=textWidth(char)
    if(used+size>cols){rows.push(current);current='';used=0}
    current+=char;used+=size
  }
  return [...rows,current]
}
function narrowed(history:string[],screen:string[],cols:number){
  const lines:string[]=[],wrappedRows:number[]=[]
  for(const row of history){
    const pieces=tmuxWrap(row,cols)
    pieces.forEach((piece,i)=>{if(i<pieces.length-1)wrappedRows.push(lines.length);lines.push(piece)})
  }
  return {data:[...lines,...screen].join('\r\n')+'\r\x1b[2A\x1b[2C\x1b[?25h',wrappedRows}
}
const border=(l:string,j:string,r:string,w:number[])=>'  '+l+w.map(n=>'─'.repeat(n+2)).join(j)+r
const cells=(values:string[],w:number[])=>'  │'+values.map((v,i)=>' '+v+' '.repeat(w[i]-textWidth(v))+' │').join('')

it('desktop draws a history table a narrower width broke so it fits again, and leaves the rest of the grid alone',async()=>{
  const w=[20,46,30,16,24,12]   // six columns, printed 169 cells wide
  const table=[border('┌','┬','┐',w),cells(['파일','미리보기에서 바로 고치기','클릭하면','원문','되돌리기','상태'],w),border('├','┼','┤',w),
    cells(['Markdown·Quarto','문장·제목·목록 글자가 그 자리에서 입력 상태로','코드 블록은 그 블록 원문만','소스','↶ / Ctrl+Z','✅'],w),border('└','┴','┘',w)]
  const prose='  '+'화면 폭이 바뀔 때 다시 그려지는지 보려고 넣은 긴 문장입니다. '.repeat(4)
  const screen=['❯ prompt','','status']
  const frame=narrowed(['● 답',prose,...table,'끝'],screen,120)
  const fitted=fitHistoryTables(frame,120,screen.length)
  const tail=fitted.match(/\r\x1b\[2A\x1b\[2C\x1b\[\?25h$/)
  expect(tail).not.toBeNull()
  const lines=fitted.slice(0,tail!.index).split('\r\n')
  // Prose keeps tmux's rows; the screen the app draws on is untouched.
  const source=frame.data.split('\r\n'),head=1+tmuxWrap(prose,120).length
  expect(head).toBeGreaterThan(2)
  expect(lines.slice(0,head)).toEqual(source.slice(0,head))
  expect(lines.slice(-screen.length)).toEqual(screen)
  const drawn=lines.slice(head,-screen.length-1).map(plainText)
  expect(drawn.every(line=>textWidth(line)<=120)).toBe(true)
  expect(drawn.filter(line=>line.startsWith('  │')).every(line=>line.trimEnd().endsWith('│'))).toBe(true)
  const column=(rows:string[],c:number)=>rows.filter(line=>line.startsWith('  │')).map(line=>line.split('│')[c+1]).join('').replace(/\s/g,'')
  expect(w.map((_,c)=>column(drawn,c))).toEqual(w.map((_,c)=>column(table,c)))
  expect(lines[lines.length-screen.length-1]).toBe('끝')
  // xterm draws every row on a line of its own: nothing wraps at 120 columns.
  const term=new Terminal({cols:120,rows:10,scrollback:200,allowProposedApi:true})
  term.loadAddon(new Unicode11Addon());term.unicode.activeVersion='11'
  try{
    await new Promise<void>(resolve=>term.write(fitted,resolve))
    const buffer=term.buffer.active
    expect(buffer.length).toBe(lines.length)
    expect(Array.from({length:buffer.length},(_,i)=>buffer.getLine(i)!.isWrapped)).not.toContain(true)
  }finally{term.dispose()}
  // Without tmux's wrap marks nothing is joined or redrawn.
  expect(fitHistoryTables({data:frame.data},120,screen.length)).toBe(frame.data)
  // A table that fits keeps the source grid exactly, aligned or not.
  const narrow=narrowed(['  │ a │ b │','  ├───┼───┤','  │ ccc │ d │'],screen,120)
  expect(fitHistoryTables(narrow,120,screen.length)).toBe(narrow.data)
  // A wide pipe table is usually source text (a file, code in a command): left as tmux wrapped it.
  const markdown=narrowed(['    | 번호 | 자료 |','    |---|---|','    | 참고 1 | '+'긴 링크 텍스트 '.repeat(20)+'|'],screen,120)
  expect(markdown.wrappedRows.length).toBeGreaterThan(0)
  expect(fitHistoryTables(markdown,120,screen.length)).toBe(markdown.data)
})

it('separates the redrawn table from the cut-off old copy a resize joined it to, then and after a later reflow',()=>{
  // Claude Code redraws from the screen top after a resize; the row above keeps
  // its wrap mark, so the redraw's first table row hangs off the old copy's rule.
  const old=[20,46,30,16,24,12],now=[18,18,14,14,14,12]   // 169 and 111 cells wide
  const redrawn=[cells(['PDF·이미지','❌ 보기 전용','—','—','—','—'],now),border('└','┴','┘',now)]
  const history=['● 답 4',border('┌','┬','┐',old),cells(['파일','미리보기에서 바로 고치기','클릭하면','원문','되돌리기','상태'],old),
    tmuxWrap(border('├','┼','┤',old),120)[0]+redrawn[0],redrawn[1],'','  중간 문단 3.']
  const screen=['❯ prompt','','status']
  // 200: a wider reflow puts both on one row, with no wrap mark left.
  for(const cols of [120,100,200]){
    const frame=narrowed(history,screen,cols)
    if(cols===200)expect(frame.data.split('\r\n').filter(line=>line.includes('┼')&&line.includes('PDF'))).toHaveLength(1)
    const lines=fitHistoryTables(frame,cols,screen.length).split('\r\n').map(plainText)
    const pdf=lines.filter(line=>line.includes('PDF·이미지'))
    expect(pdf).toHaveLength(1)
    expect(pdf[0]).toMatch(/^ {2}│ PDF·이미지 +│.*│$/)
    expect(lines.every(line=>textWidth(line)<=cols)).toBe(true)
    // The phone reads it as a table row too, not as text after a border.
    const phone=reflowFrame(frame.data,44,screen.length,frame.wrappedRows).lines.map(plainText)
    expect(phone).toContain('  PDF·이미지 · ❌ 보기 전용 · — · — · — · —')
  }
})

it('joins the table rows Claude Code redraws broken where a narrower width ended',()=>{
  // Widening from 150 (or 140): each row of the new 197-cell table is written as
  // two rows, the second indented, with no wrap mark. At 150 every piece ends on
  // a divider and looks like a whole, narrower row.
  const w=[24,24,39,48,30,11]
  const table=[border('┌','┬','┐',w),cells(['파일','미리보기에서 바로 고치기','클릭하면','그 자리에서 안 되는 부분','원문 보기','되돌리기'],w),
    border('├','┼','┤',w),cells(['PDF·이미지','❌ 보기 전용','—','—','—','—'],w),border('└','┴','┘',w)]
  const screen=['❯ prompt','','status']
  for(const old of [150,140]){
    const broken=table.flatMap(row=>{const [head,...rest]=tmuxWrap(row,old);return [head.trimEnd(),'  '+rest.join('')]})
    const frame={data:['  끝 문단 3.','',...broken,'','  중간 문단 4.',...screen].join('\r\n')}
    const lines=fitHistoryTables(frame,200,screen.length).split('\r\n').map(plainText)
    expect(lines.slice(2,2+table.length)).toEqual(table)
    expect(lines.slice(2+table.length)).toEqual(['','  중간 문단 4.',...screen])
    const phone=reflowFrame(frame.data,44,screen.length).lines.map(plainText)
    expect(phone).toContain('  파일: PDF·이미지')
  }
  // Rows of a table that are whole are never joined, even to an indented line.
  const whole=[...table,'  ───']
  expect(fitHistoryTables({data:[...whole,...screen].join('\r\n')},200,screen.length)).toBe([...whole,...screen].join('\r\n'))
})
