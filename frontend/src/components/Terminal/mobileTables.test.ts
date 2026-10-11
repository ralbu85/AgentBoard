import {expect,it} from 'vitest'
import {Terminal} from '@xterm/xterm'
import {Unicode11Addon} from '@xterm/addon-unicode11'
import {mobileTables} from './mobileTables'
import {textWidth,plainText} from './terminalText'
import {reflowFrame} from './reflow'

function boxed(values:string[][],widths:number[],indent=''){
  const rule=(left:string,join:string,right:string)=>indent+left+widths.map(w=>'─'.repeat(w+2)).join(join)+right
  return [rule('┌','┬','┐'),...values.flatMap((row,i)=>[
    indent+'│'+row.map((value,c)=>' '+value+' '.repeat(Math.max(0,widths[c]-textWidth(value)))+' │').join(''),
    ...(i===0?[rule('├','┼','┤')]:[]),
  ]),rule('└','┴','┘')]
}
const flatten=(rows:Map<number,string[]>)=>[...rows.values()].flat().map(plainText)

it('wraps cells inside aligned Unicode borders and keeps every column value',()=>{
  const original=boxed([['이름','설명','결과'],['실험 A','긴 설명입니다 '.repeat(5),'성공🙂']], [18,55,16],'  ')
  const result=flatten(mobileTables(original,48))
  expect(result.length).toBeGreaterThan(original.length)
  expect(result.every(line=>textWidth(line)<=48)).toBe(true)
  const data=result.filter(line=>line.includes('│'))
  const boundaries=data.map(line=>{let col=0;const positions:number[]=[];for(const char of line){if(char==='│')positions.push(col);col+=textWidth(char)}return positions})
  expect(boundaries.every(b=>JSON.stringify(b)===JSON.stringify(boundaries[0]))).toBe(true)
  const columns=[0,1,2].map(c=>data.map(line=>line.split('│')[c+1].trim()).join('').replace(/\s/g,''))
  expect(columns).toEqual(['이름실험A','설명'+'긴설명입니다'.repeat(5),'결과성공🙂'])
})

it('keeps fitting tables unchanged and does not mistake shell pipelines for tables',()=>{
  const small=boxed([['a','b'],['1','2']], [3,3])
  expect(mobileTables(small,60).size).toBe(0)
  expect(mobileTables(['cat file | sort | head','| expression | other expression |'],12).size).toBe(0)
})

it('repairs uneven source padding even when the entire table fits on the phone',()=>{
  const lines=['┌─────────┬─────────┐','│ 이름    │ 결과    │','├─────────┼─────────┤','│ A │ 성공🙂 │','└─────────┴─────────┘']
  const result=flatten(mobileTables(lines,48))
  expect(result).toHaveLength(lines.length)
  expect(new Set(result.map(textWidth)).size).toBe(1)
  const divisions=result.map(line=>{
    const joint=line.search(/[┬┼┴]/)
    return textWidth(line.slice(0,joint>=0?joint:line.indexOf('│',1)))
  })
  expect(new Set(divisions).size).toBe(1)
  expect(result.join('\n')).toContain('성공🙂')
})

it('aligns compact Markdown tables containing differently sized values',()=>{
  const lines=['| 이름 | 결과 |','| --- | --- |','| A | 완료 |','| 긴 항목 | 진행 중 |']
  const result=flatten(mobileTables(lines,48))
  expect(result).toHaveLength(lines.length)
  expect(new Set(result.map(textWidth)).size).toBe(1)
  expect(new Set(result.map(line=>textWidth(line.slice(0,line.indexOf('|',1))))).size).toBe(1)
  expect(result.join('\n')).toContain('긴 항목')
})

it('adapts Markdown tables without splitting escaped pipes or pipes inside inline code',()=>{
  const lines=['| 이름 | 설명 |','| --- | --- |','| A | `left | right` and escaped \\| value '+ 'long '.repeat(9)+'|']
  const result=flatten(mobileTables(lines,35))
  expect(result.every(row=>textWidth(row)<=35)).toBe(true)
  const compact=result.filter(line=>line.startsWith('|')).map(line=>line.slice(line.indexOf('|',1)+1,-1)).join('').replace(/\s/g,'')
  expect(compact).toContain('left|right')
  expect(compact).toContain('escaped\\|value')
})

it('stacks very wide tables by record with labels instead of shrinking text or losing columns',()=>{
  const headers=['이름','경로','설명','상태','시간','비고']
  const values=['Alpha','/work/a','테스트중','완료','12:30','LAST-COLUMN']
  const lines=boxed([headers,values],Array(6).fill(20))
  const result=flatten(mobileTables(lines,40)),text=result.join('\n')
  expect(result.every(row=>textWidth(row)<=40)).toBe(true)
  for(let i=0;i<headers.length;i++)expect(text).toContain(`${headers[i]}: ${values[i]}`)
  expect(text).not.toMatch(/[┌┬┼│]/)
})

it('preserves inherited color and cursor position below a reformatted table',async()=>{
  const lines=boxed([['항목','값'],['RED','긴내용'.repeat(12)]],[16,60])
  lines[3]='\x1b[31m'+lines[3]+'\x1b[0m'
  const source=lines.join('\r\n')+'\r\nprompt>'+'\r\n'.repeat(3)+'\r\x1b[3A\x1b[7C\x1b[?25h'
  const frame=reflowFrame(source,40,lines.length+4)
  expect(frame.hasLayout).toBe(true)
  const term=new Terminal({cols:40,rows:frame.rows,allowProposedApi:true})
  term.loadAddon(new Unicode11Addon());term.unicode.activeVersion='11'
  await new Promise<void>(resolve=>term.write(frame.data,resolve))
  try{
    const buf=term.buffer.active
    const row=Array.from({length:buf.length},(_,i)=>i).find(i=>buf.getLine(i)!.translateToString(true).includes('RED'))!
    const line=buf.getLine(row)!,col=line.translateToString(true).indexOf('RED')
    expect(line.getCell(col)!.getFgColor()).toBe(1)
    expect(line.getCell(0)!.isFgDefault()).toBe(true)
    expect(buf.getLine(buf.baseY+buf.cursorY)!.translateToString(true)).toBe('prompt>')
    expect(buf.cursorX).toBe(7)
  }finally{term.dispose()}
})

it('does not remap a visible editing cursor inside a table',()=>{
  const lines=boxed([['Header','Text'],['a','b']],[20,60])
  expect(mobileTables(lines,40,{row:3,visible:true}).size).toBe(0)
})

it('recognizes partial Unicode tables captured without their top border',()=>{
  const lines=boxed([['Header','Value'],['A','B'.repeat(45)],['C','D'.repeat(45)]],[18,50]).slice(3)
  const result=flatten(mobileTables(lines,40))
  expect(result.every(row=>textWidth(row)<=40)).toBe(true)
  expect(result.join('').replace(/[^BD]/g,'')).toBe('B'.repeat(45)+'D'.repeat(45))
})
