import {expect,it} from 'vitest'
import {Terminal} from '@xterm/xterm'
import {Unicode11Addon} from '@xterm/addon-unicode11'
import {reflowFrame,replaceSourceScreen,replaceFrameScreen,mobileHistoryTail} from './reflow'
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
