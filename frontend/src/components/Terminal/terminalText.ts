import type {Terminal, IUnicodeVersionProvider} from '@xterm/xterm'
import {Unicode11Addon} from '@xterm/addon-unicode11'

let unicode:IUnicodeVersionProvider
new Unicode11Addon().activate({unicode:{register(provider:IUnicodeVersionProvider){unicode=provider}}} as Terminal)
export const cellWidth=(text:string)=>unicode.wcwidth(text.codePointAt(0)!)
export const ansiTokens=/\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][0-2A-Z]|[^\x1b]/gu
export const plainText=(text:string)=>text.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][0-2A-Z]/g,'')
export const textWidth=(text:string)=>Array.from(plainText(text)).reduce((n,char)=>n+cellWidth(char),0)
const Segmenter=(Intl as unknown as {Segmenter?:new(locales?:string,options?:{granularity:string})=>{segment(text:string):Iterable<{segment:string}>}}).Segmenter
const graphemes=Segmenter?new Segmenter(undefined,{granularity:'grapheme'}):undefined
function displayTokens(text:string):string[]{
  return (text.match(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][0-2A-Z]|[^\x1b]+/gu)||[]).flatMap(part=>
    part.startsWith('\x1b')?[part]:graphemes&&/[\p{Mark}\u200d\u1100-\u11ff\u{1f1e6}-\u{1f1ff}\u{1f3fb}-\u{1f3ff}]/u.test(part)?Array.from(graphemes.segment(part),g=>g.segment):Array.from(part))
}

// Captured cells can inherit SGR attributes from preceding rows/cells. Keep a
// bounded style state so a wrapped cell can resume its own colors after borders.
export class AnsiStyle {
  private values=new Map<string,string>()
  apply(token:string){
    if(!/^\x1b\[[0-9;:]*m$/.test(token))return
    const args=token.slice(2,-1).split(';')
    for(let i=0;i<args.length;i++){
      const code=Number(args[i].split(':')[0])
      if(code===0){this.values.clear();continue}
      let key=String(code),value=args[i]
      if(code===38||code===48||code===58){
        key=code===38?'fg':code===48?'bg':'ul'
        if(!value.includes(':')){
          const count=args[i+1]==='2'?4:args[i+1]==='5'?2:0
          value=args.slice(i,i+count+1).join(';');i+=count
        }
      }else if((code>=30&&code<=39)||(code>=90&&code<=97))key='fg'
      else if((code>=40&&code<=49)||(code>=100&&code<=107))key='bg'
      else if(code===59)key='ul'
      else if(code===22){this.values.delete('1');this.values.delete('2');continue}
      else if([23,24,25,27,28,29].includes(code)){this.values.delete(String(code-20));continue}
      this.values.set(key,value)
    }
  }
  feed(text:string){for(const token of text.match(/\x1b\[[0-9;:]*m/g)||[])this.apply(token)}
  get prefix(){return '\x1b[0m'+(this.values.size?`\x1b[${[...this.values.values()].join(';')}m`:'')}
}

export function wrapText(text:string,width:number,cursor?:number){
  const parts=displayTokens(text),style=new AnsiStyle()
  const rows:string[]=[],starts:number[]=[],textStarts:number[]=[]
  let start=0,offset=0,textOffset=0,cursorRow=0,cursorCol=0
  while(start<parts.length){
    // A wrapping separator is represented by the line break, not by a stray
    // leading space on the next display row. Original line indentation stays.
    if(rows.length){
      while(start<parts.length&&(/\s/u.test(parts[start])||parts[start].startsWith('\x1b'))){
        if(parts[start].startsWith('\x1b'))style.apply(parts[start])
        else {offset+=textWidth(parts[start]);textOffset+=parts[start].length}
        start++
      }
      if(start===parts.length)break
    }
    let end=start,used=0,lastBreak=-1,breakWidth=0
    for(;end<parts.length;end++){
      const token=parts[end]
      if(token.startsWith('\x1b'))continue
      const size=textWidth(token)
      if(size>0&&used+size>width)break
      used+=size
      // Prefer word/eojeol boundaries. Long identifiers still split when no
      // boundary exists; combining marks stay attached to their base character.
      if(/\s/u.test(token)){lastBreak=end+1;breakWidth=used}
    }
    if(end<parts.length&&!/\s/u.test(parts[end])&&lastBreak>start&&breakWidth>0&&parts.slice(start,lastBreak).some(p=>!p.startsWith('\x1b')&&p.trim()))end=lastBreak
    if(end===start)end++
    const prefix=style.prefix,chunk=parts.slice(start,end)
    starts.push(offset)
    textStarts.push(textOffset)
    for(const token of chunk){
      if(token.startsWith('\x1b'))style.apply(token)
      else {offset+=textWidth(token);textOffset+=token.length}
    }
    rows.push(prefix+chunk.join(''))
    start=end
  }
  if(!rows.length){rows.push('');starts.push(0);textStarts.push(0)}
  if(cursor!==undefined){
    cursorRow=starts.length-1
    for(let i=1;i<starts.length;i++)if(cursor<starts[i]){cursorRow=i-1;break}
    cursorCol=cursor-starts[cursorRow]
    while(cursorCol>=width){
      if(cursorRow===rows.length-1){rows.push('');textStarts.push(textOffset)}
      cursorRow++;cursorCol-=width
    }
  }
  return {lines:rows,textStarts,cursorRow,cursorCol}
}

export const wrapCell=(text:string,width:number)=>wrapText(text,width).lines

export function trimCell(text:string):string{
  // Trim layout padding without throwing away color changes around that padding.
  const parts=text.match(ansiTokens)||[]
  let start=parts.findIndex(p=>!p.startsWith('\x1b')&&p.trim()!=='')
  if(start<0)return parts.filter(p=>p.startsWith('\x1b')).join('')
  let end=parts.length-1
  while(end>start&&(parts[end].startsWith('\x1b')||parts[end].trim()===''))end--
  return parts.slice(0,start).filter(p=>p.startsWith('\x1b')).join('')+
    parts.slice(start,end+1).join('')+parts.slice(end+1).filter(p=>p.startsWith('\x1b')).join('')
}
