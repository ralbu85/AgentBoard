import {AnsiStyle,ansiTokens,plainText,textWidth,wrapText} from './terminalText'

type Cursor={row:number;col:number;visible:boolean}
type Projection={lines:string[];cursorRow:number;cursorCol:number}
const reset='\x1b[0m'
const rule=/^(\s*)([╭╰┌└┏┗╔╚]?)([─━═])\3{7,}([╮╯┐┘┓┛╗╝]?)\s*$/u
const labeledRule=/^(\s*)([─━═]{1,4}) +(.+?) +([─━═])\4{7,}\s*$/u
const footer=/^\s*(?:\? for shortcuts|\d+% context left|esc to (?:interrupt|cancel)|shift[ +]tab|[⏵▶]+\s|accept edits|bypass permissions|auto[- ]compact)/iu

// Slice cells without losing SGR state. Used only for verified UI padding, never
// for code or arbitrary whitespace in the user's prompt.
function cells(text:string,start:number,end=Infinity){
  let offset=0,out='';const state=new AnsiStyle()
  for(const token of text.match(ansiTokens)||[]){
    if(token.startsWith('\x1b')){state.apply(token);if(offset>=start&&offset<end)out+=token;continue}
    const width=textWidth(token)
    if(offset>=start&&offset<end)out+=token
    else if(offset<start&&offset+width>=start)out+=state.prefix
    offset+=width
  }
  return out
}

// Mobile chrome is a projection of captured cells. The source remains intact
// for desktop, copying, rotation and the next screen. Only pure divider lines,
// a verified single-column prompt box, and known non-editable footers qualify.
export function mobileChrome(lines:string[],cols:number,cursor?:Cursor):Map<number,Projection>{
  const result=new Map<number,Projection>(),style=new AnsiStyle(),styles:string[]=[],ends:string[]=[]
  for(const line of lines){styles.push(style.prefix);style.feed(line);ends.push(style.prefix)}
  const put=(row:number,out:string[],cursorRow=0,cursorCol=0)=>{
    out[out.length-1]+=ends[row]
    result.set(row,{lines:out,cursorRow,cursorCol})
  }
  for(let row=0;row<lines.length;row++){
    const plain=plainText(lines[row]),match=plain.match(rule),label=plain.match(labeledRule)
    const lead=new AnsiStyle();lead.feed(styles[row]);lead.feed(lines[row].match(/^(?:\x1b\[[0-?]*[ -/]*[@-~]|\s)*/)?.[0]||'')
    const editing=cursor?.visible&&cursor.row===row
    if(match&&textWidth(plain)>cols&&!editing){
      const indent=match[1].length<=4?match[1]:'',left=match[2],right=match[4]
      put(row,[lead.prefix+indent+left+match[3].repeat(Math.max(1,cols-indent.length-left.length-right.length))+right])
    }else if(label&&textWidth(plain)>cols&&!editing){
      const indent=label[1].length<=4?label[1]:'',out=wrapText(lead.prefix+indent+label[2]+' '+label[3],cols).lines
      const remaining=cols-textWidth(out[out.length-1])
      if(remaining>=3)out[out.length-1]+=' '+label[4].repeat(remaining-1)
      put(row,out)
    }
    // A status footer can have right-aligned counters hundreds of cells away.
    // Keep every field, but turn its layout padding into a word separator.
    const modelFooter=/^\s*(?:gpt-[\d.]|claude-|Opus |Sonnet )/i.test(plain)&&/(?:context|tokens|\d+%)/i.test(plain)
    if(row>=lines.length-8&&!editing&&(footer.test(plain)||modelFooter)&&textWidth(plain)>cols){
      const compact=lines[row].replace(/ {3,}/g,' ').trimEnd()
      put(row,wrapText(styles[row]+compact,cols).lines)
    }
  }
  for(let start=0;start<lines.length;start++){
    const top=plainText(lines[start]).match(rule)
    if(!top||!['╭','┌','┏','╔'].includes(top[2])||textWidth(plainText(lines[start]))<=cols)continue
    const indent=top[1],width=textWidth(plainText(lines[start]).trimEnd()),edge=top[2]==='╔'?'║':top[2]==='┏'?'┃':'│'
    let end=start+1
    while(end<lines.length&&plainText(lines[end]).startsWith(indent+edge)&&plainText(lines[end]).trimEnd().endsWith(edge)&&textWidth(plainText(lines[end]).trimEnd())===width)end++
    const bottom=plainText(lines[end]||'').match(rule)
    if(end===start+1||!bottom||bottom[1]!==indent||!['╰','└','┗','╚'].includes(bottom[2])||textWidth(plainText(lines[end]).trimEnd())!==width)continue
    // Exclude tables and unverified box art. A visible input cursor or a CLI
    // prompt is the evidence that this is an input box.
    if(!lines.slice(start+1,end).some(line=>/^\s*[│┃║]\s*[❯›>] /u.test(plainText(line)))&&!(cursor?.visible&&cursor.row>start&&cursor.row<end))continue
    if(lines.slice(start+1,end).some(line=>plainText(line).slice(indent.length+1,-1).includes(edge)))continue
    const displayIndent=indent.length<=4?indent:'',available=cols-displayIndent.length-4
    if(available<2)continue
    for(let row=start+1;row<end;row++){
      const left=indent.length+1,body=cells(styles[row]+lines[row],left,width-1)
      const plainBody=plainText(body),padding=plainBody.startsWith(' ')?1:0
      // Trailing box-fill spaces have no content. Preserve the cursor even
      // when it sits after typed spaces or on an otherwise empty input row.
      const caret=cursor?.row===row?Math.max(0,cursor.col-left-padding):undefined
      const meaningful=Math.max(textWidth(plainBody.trimEnd())-padding,(caret??-1)+1)
      const content=cells(body,padding,padding+meaningful)
      const wrapped=wrapText(content,available,caret)
      put(row,wrapped.lines.map(line=>reset+displayIndent+edge+' '+line+reset+' '.repeat(Math.max(0,available-textWidth(line)))+' '+edge),wrapped.cursorRow,displayIndent.length+2+wrapped.cursorCol)
    }
    start=end
  }
  return result
}
