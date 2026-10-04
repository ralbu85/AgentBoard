import {AnsiStyle,plainText,textWidth,trimCell,wrapCell} from './terminalText'

type TableLine={kind:'cells'|'border';prefix:string;family:string;cells:string[];widths:number[];joints?:string[];rule?:string;lead?:string}
const reset='\x1b[0m'

function parse(line:string):TableLine|undefined{
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
export function mobileTables(lines:string[],cols:number,cursor?:{row:number;visible:boolean}):Map<number,string[]>{
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
    if(!data.length||!verified||editing||sourceWidth<=cols){start=end;continue}
    const desired=Array.from({length:count},(_,i)=>Math.max(2,...data.map(p=>textWidth(plainText(p.cells[i]).trim()))))
    const minimums=Array.from({length:count},(_,i)=>Math.min(desired[i],Math.max(2,...data.flatMap(p=>
      plainText(p.cells[i]).trim().split(/\s+/u).map(word=>Math.min(12,textWidth(word)))))))
    const indent=first.prefix.length<=4?first.prefix:''
    const budget=cols-indent.length-count*3-1
    const stacked=count>5||budget<minimums.reduce((a,b)=>a+b,0)
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
