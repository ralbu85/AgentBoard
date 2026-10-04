import {expect,it} from 'vitest'
import {reflowFrame} from './reflow'
import {plainText,textWidth} from './terminalText'
import {mobileChrome} from './mobileChrome'

const projected=(lines:string[],cols:number)=>plainText(reflowFrame(lines.join('\r\n'),cols,lines.length).data).split('\r\n')

it('keeps a desktop-length status divider on one phone row without shrinking text',()=>{
  const source=['answer','\x1b[90m'+'─'.repeat(160)+'\x1b[0m','❯ prompt','─'.repeat(160),'  ? for shortcuts'+' '.repeat(110)+'62% context left']
  const out=projected(source,48)
  expect(out.filter(line=>/^─+$/.test(line))).toEqual(['─'.repeat(48),'─'.repeat(48)])
  expect(out.every(line=>textWidth(line)<=48)).toBe(true)
  expect(out.slice(-1)[0]).toBe('  ? for shortcuts 62% context left')
  expect(source[1]).toContain('─'.repeat(160))
})

it('wraps footer fields without dropping words, percentage or ANSI attributes',()=>{
  const source=['answer','\x1b[32m  shift+tab to cycle modes'+' '.repeat(100)+'\x1b[33m81% context left\x1b[0m']
  const out=mobileChrome(source,28).get(1)!
  expect(out.lines.map(plainText).join(' ').trim().split(/\s+/)).toEqual('shift+tab to cycle modes 81% context left'.split(' '))
  expect(out.lines.every(line=>textWidth(line)<=28)).toBe(true)
  expect(out.lines.join('')).toContain('\x1b[33m')
})

it('rebuilds a verified prompt box including typed Korean and cursor at phone width',()=>{
  const text='› 한글 요청을 입력하는 중입니다',width=120
  const source=['╭'+'─'.repeat(width-2)+'╮','│ '+text+' '.repeat(width-textWidth(text)-4)+' │','╰'+'─'.repeat(width-2)+'╯']
  const caret={row:1,col:2+textWidth(text),visible:true}
  const out=mobileChrome(source,26,caret),body=out.get(1)!
  expect([...out.values()].flatMap(p=>p.lines).every(line=>textWidth(line)<=26)).toBe(true)
  expect(body.lines.map(plainText).map(line=>line.slice(2,-2).trim()).join(' ')).toBe(text)
  expect(body.cursorRow).toBe(1)
  expect(body.cursorCol).toBeGreaterThan(2)
  expect(body.cursorCol).toBeLessThan(25)
})

it('preserves editing spaces and does not compact arbitrary code, tables or cursor rows',()=>{
  const source=['const value = "? for shortcuts          test"','    untouched    spaces','  ? for shortcuts'+' '.repeat(70)+'typed']
  const out=mobileChrome(source,40,{row:2,col:90,visible:true})
  // Plain source code is not a status footer even when it quotes help text.
  expect(out.has(0)).toBe(false)
  expect(out.has(1)).toBe(false)
  expect(out.has(2)).toBe(false)
  const box=['╭'+'─'.repeat(78)+'╮','│ '+('a │ b').padEnd(76)+' │','╰'+'─'.repeat(78)+'╯']
  expect(mobileChrome(box,30,{row:1,col:5,visible:true}).has(1)).toBe(false)
})

it('does not rewrite short dividers or wide diagram content that is not an input box',()=>{
  const lines=['─'.repeat(10),'╭'+'─'.repeat(78)+'╮','│ '+('network diagram').padEnd(76)+' │','╰'+'─'.repeat(78)+'╯']
  const out=mobileChrome(lines,40)
  expect(out.has(0)).toBe(false)
  expect(out.has(2)).toBe(false)
})

it('fits a labeled Codex completion rule without repeating its decorative tail',()=>{
  const out=projected(['\x1b[90m─ Worked for 2m 10s '+'─'.repeat(120)+'\x1b[0m'],38)
  expect(out).toHaveLength(1)
  expect(out[0]).toContain('Worked for 2m 10s')
  expect(textWidth(out[0])).toBe(38)
  const narrow=projected(['─ A long completion message with every word preserved '+'─'.repeat(80)],20)
  expect(narrow.every(line=>textWidth(line)<=20)).toBe(true)
  expect(narrow.join(' ')).toContain('preserved')
})
