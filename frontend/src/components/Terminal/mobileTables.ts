import {AnsiStyle,ansiTokens,plainText,textWidth,trimCell,wrapCell} from './terminalText'

type TableLine={kind:'cells'|'border';prefix:string;family:string;cells:string[];widths:number[];joints?:string[];rule?:string;lead?:string}
const reset='\x1b[0m'

// A row whose text starts (after colours and its indent) with one of `chars`.
const starts=(chars:string)=>new RegExp(`^(?:\\x1b\\[[0-?]*[ -/]*[@-~]|\\x1b[()][0-2A-Z]| )*[${chars}]`)
const tableStart=starts('│┃║|┌┬┐└┴┘├┼┤╭╮╰╯┏┳┓┗┻┛┣╋┫╔╦╗╚╩╝╠╬╣+'),boxStart=starts('│┃║┌├└╭╰┏┣┗╔╠╚')

function parse(line:string):TableLine|undefined{
  if(!tableStart.test(line))return
  const plain=plainText(line),prefix=plain.match(/^ */)![0],body=plain.slice(prefix.length).trimEnd()
  if(/^[┌┬┐└┴┘├┼┤╭╮╰╯┏┳┓┗┻┛┣╋┫╔╦╗╚╩╝╠╬╣+][─━═-]+/.test(body)){
    const pieces=body.split(/[┌┬┐└┴┘├┼┤╭╮╰╯┏┳┓┗┻┛┣╋┫╔╦╗╚╩╝╠╬╣+]/)
    if(pieces.length<4||pieces[0]!==''||pieces[pieces.length-1]!==''||!pieces.slice(1,-1).every(p=>/^[─━═-]+$/.test(p)))return
    const joints=Array.from(body).filter(c=>!/[─━═-]/.test(c))
    return {kind:'border',prefix,family:body[0]==='+'?'|':/[╔╦╗╚╩╝╠╬╣]/.test(body[0])?'║':/[┏┳┓┗┻┛┣╋┫]/.test(body[0])?'┃':'│',cells:[],widths:pieces.slice(1,-1).map(textWidth),joints,rule:pieces[1][0]}
  }
  const divider=body[0]
  if(!['│','┃','║','|'].includes(divider)||body[body.length-1]!==divider)return
  // Pipes inside Markdown code spans and escaped pipes are cell contents.
  const parts:string[]=[];let part='',ticks=0,escaped=false
  for(let i=0;i<line.length;i++){
    const char=line[i]
    if(char==='`'&&divider==='|'){
      let n=1;while(line[i+n]==='`')n++
      ticks=ticks===n?0:ticks===0?n:ticks
      part+=line.slice(i,i+n);i+=n-1;escaped=false;continue
    }
    if(char===divider&&!escaped&&!ticks){parts.push(part);part=''}else part+=char
    escaped=char==='\\'&&!escaped
  }
  parts.push(part)
  if(parts.length<4||plainText(parts[0]).trim()||plainText(parts[parts.length-1]).trim())return
  const cells=parts.slice(1,-1)
  const markdownRule=divider==='|'&&cells.every(c=>/^\s*:?-{3,}:?\s*$/.test(plainText(c)))
  return {kind:markdownRule?'border':'cells',prefix,family:divider,cells,widths:cells.map(textWidth),lead:parts[0],
    ...(markdownRule?{joints:Array(cells.length+1).fill('|'),rule:'-'}:{})}
}

// A fixed cell grid only changes glyph placement; it does not reinterpret text.
// Include fitting/partial rows too, which need no width projection but can still
// drift when the browser uses fallback fonts for symbols, Hangul or emoji.
export const isMobileTableRow=(line:string)=>parse(line)!==undefined

const sameColumns=(a:TableLine|undefined,b:TableLine)=>!!a&&a.family===b.family&&a.prefix===b.prefix&&a.widths.length===b.widths.length&&a.widths.every((w,i)=>w===b.widths[i])
// The plain text of a captured row, and where each of its characters is in the row.
function plainOffsets(line:string){
  const raw:number[]=[];let plain=''
  for(const m of line.matchAll(ansiTokens))if(m[0][0]!=='\x1b'){plain+=m[0];for(let j=0;j<m[0].length;j++)raw.push(m.index!+j)}
  return {plain,raw}
}

// On a resize the app clears the screen and draws again from its top, but the
// row just above keeps tmux's wrap mark. Its old continuation is gone, so a
// cut-off row of the old copy and the first redrawn row become one line: soft-
// wrapped while narrow, a single row once a wider reflow joins them. Split it
// where a row of the table below starts: same border family, indent and widths.
export function splitRedrawSeam(line:string,below:string):[string,string]|undefined{
  const next=parse(below)
  if(!next||sameColumns(parse(line),next))return
  const same=(p?:TableLine)=>sameColumns(p,next)
  const {plain,raw}=plainOffsets(line)
  for(let p=next.prefix.length+1;p<plain.length;p++){
    if(!/[│┃║┌├└╭╰┏┣┗╔╠╚]/.test(plain[p])||plain.slice(p-next.prefix.length,p)!==next.prefix)continue
    const at=raw[p-next.prefix.length],row=line.slice(at)
    if(!same(parse(row)))continue
    const style=new AnsiStyle();style.feed(line.slice(0,at))
    return [line.slice(0,at),style.prefix+row]
  }
}

// After a resize to a wider terminal, Claude Code draws its first rows again
// laid out for the new width but broken where the old width ended: two rows,
// the second indented, no wrap mark between them. Returns the rows that join
// the next one into a row of their table, and the joined text. A border joins
// as it is; cells lost their trailing blanks, so they are padded to end where a
// nearby row of the same table does, and must then have its column widths.
export function brokenTableRows(lines:string[]):Map<number,string>{
  const joined=new Map<number,string>(),rows=lines.map(parse)
  // The first piece can end on a divider and look like a whole, narrower row.
  const piece=(i:number)=>{
    if(joined.has(i)||joined.has(i-1)||i+1>=lines.length||!boxStart.test(lines[i]))return
    const indent=plainText(lines[i]).match(/^ */)![0]
    if(rows[i+1]?.prefix===indent)return   // the next row of the table
    const {plain,raw}=plainOffsets(lines[i+1])
    if(!plain.startsWith(indent)||!plain.slice(indent.length).trim())return
    // Drop the indent, keep the colours set inside it.
    const at=raw[indent.length],codes=lines[i+1].slice(0,at).match(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][0-2A-Z]/g)||[]
    return {indent,rest:codes.join('')+lines[i+1].slice(at)}
  }
  const join=(i:number,line:string,row:TableLine)=>{joined.set(i,line);rows[i]=row;rows[i+1]=undefined}
  for(let i=0;i<lines.length-1;i++){
    const p=piece(i),line=p&&lines[i]+p.rest,row=line?parse(line):undefined
    if(row?.kind==='border'&&row.prefix===p!.indent)join(i,line!,row)
  }
  const width=(r:TableLine)=>textWidth(r.prefix)+r.widths.reduce((a,b)=>a+b,r.widths.length+1)
  for(let i=0;i<lines.length-1;i++){
    const p=rows[i]?.kind==='border'?undefined:piece(i)
    if(!p)continue
    near:for(let d=1;d<=4;d++)for(const ref of [rows[i-d],rows[i+1+d]]){
      if(!ref||ref.prefix!==p.indent)continue
      const pad=width(ref)-textWidth(lines[i])-textWidth(p.rest)
      const line=pad>=0?lines[i]+' '.repeat(pad)+p.rest:'',row=line?parse(line):undefined
      if(row?.kind==='cells'&&sameColumns(row,ref)){join(i,line,row);break near}
    }
  }
  return joined
}

function allocate(desired:number[],minimums:number[],budget:number):number[]{
  const widths=[...minimums]
  // Keep short names, statuses and numbers on one line before spending the
  // remaining width on a long prose column.
  for(let i=0;i<widths.length;i++)if(desired[i]<=12){
    const extra=Math.min(desired[i]-widths[i],budget-widths.reduce((a,b)=>a+b,0))
    widths[i]+=Math.max(0,extra)
  }
  while(widths.reduce((a,b)=>a+b,0)<budget){
    let best=-1
    for(let i=0;i<widths.length;i++)if(widths[i]<desired[i]&&(best<0||desired[i]/widths[i]>desired[best]/widths[best]))best=i
    if(best<0)break
    widths[best]++
  }
  return widths
}

// Projection is indexed by ORIGINAL source row, so history/screen boundaries
// remain meaningful even when one table row takes several phone lines.
// `desktop` touches only box-drawn tables wider than `cols`: the source grid
// draws the rest exactly, and a pipe table there is usually source text (a file,
// code in a command). Columns stay side by side while they have room.
export function mobileTables(lines:string[],cols:number,cursor?:{row:number;visible:boolean},desktop=false):Map<number,string[]>{
  const projected=new Map<number,string[]>(),parsed=lines.map(parse)
  if(!parsed.some(Boolean))return projected
  const styles:string[]=[],endStyles:string[]=[],state=new AnsiStyle()
  for(const line of lines){styles.push(state.prefix);state.feed(line);endStyles.push(state.prefix)}
  for(let start=0;start<lines.length;){
    const first=parsed[start]
    if(!first){start++;continue}
    let end=start+1
    while(end<lines.length&&parsed[end]?.family===first.family&&parsed[end]?.prefix===first.prefix&&parsed[end]?.widths.length===first.widths.length)end++
    const block=parsed.slice(start,end) as TableLine[],count=first.widths.length
    const data=block.filter(p=>p.kind==='cells'),hasRule=block.some(p=>p.kind==='border')
    // Avoid guessing that shell pipes, isolated box art or an editing cursor
    // are a table. Markdown needs its separator row as structural evidence.
    const verified=first.family==='|'?hasRule:hasRule||data.length>=2
    const editing=cursor?.visible&&cursor.row>=start&&cursor.row<end
    const sourceWidth=Math.max(...block.map(p=>textWidth(p.prefix)+p.widths.reduce((a,b)=>a+b,0)+count+1))
    const aligned=block.every(p=>p.widths.every((width,i)=>width===first.widths[i]))
    if(!data.length||!verified||editing||(desktop&&first.family==='|')||(sourceWidth<=cols&&(aligned||desktop))){start=end;continue}
    const desired=Array.from({length:count},(_,i)=>Math.max(2,...data.map(p=>textWidth(plainText(p.cells[i]).trim()))))
    const minimums=Array.from({length:count},(_,i)=>Math.min(desired[i],Math.max(2,...data.flatMap(p=>
      plainText(p.cells[i]).trim().split(/\s+/u).map(word=>Math.min(12,textWidth(word)))))))
    const indent=first.prefix.length<=4?first.prefix:''
    const budget=cols-indent.length-count*3-1
    const stacked=(count>5&&!desktop)||budget<minimums.reduce((a,b)=>a+b,0)
    const widths=stacked?[]:allocate(desired,minimums,budget)
    const firstData=block.findIndex(p=>p.kind==='cells')
    const header=block[firstData+1]?.kind==='border'?block[firstData]:undefined
    let record=0
    for(let row=start;row<end;row++){
      const line=parsed[row]!,out:string[]=[]
      if(line.kind==='border'){
        if(!stacked)out.push(reset+indent+line.joints!.map((joint,i)=>joint+(i<count?line.rule!.repeat(widths[i]+2):'')).join(''))
      }else{
        const style=new AnsiStyle();style.feed(styles[row]);style.feed(line.lead||'')
        // Carry styles across source cells, but don't let one rendered cell's
        // color bleed into its border or a neighboring cell after wrapping.
        const cells=line.cells.map(cell=>{const value=style.prefix+trimCell(cell);style.feed(cell);return value})
        if(stacked){
          if(line===header)out.push(...wrapCell(indent+cells.map(plainText).join(' · '),cols))
          else{
            record++
            out.push(reset+indent+`[${record}]`)
            for(let i=0;i<count;i++){
              const label=header?plainText(header.cells[i]).trim():`${i+1}열`
              out.push(...wrapCell(reset+indent+label+': '+cells[i]+reset,cols))
            }
          }
        }else{
          const wrapped=cells.map((cell,i)=>wrapCell(cell,widths[i]))
          const height=Math.max(...wrapped.map(c=>c.length))
          for(let k=0;k<height;k++)out.push(reset+indent+line.family+wrapped.map((cell,i)=>{
            const text=cell[k]||''
            return ' '+text+reset+' '.repeat(Math.max(0,widths[i]-textWidth(text)))+' '+line.family
          }).join(''))
        }
      }
      if(!out.length)out.push('')
      out[out.length-1]+=endStyles[row]
      projected.set(row,out)
    }
    start=end
  }
  return projected
}
