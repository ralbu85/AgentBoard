import {AnsiStyle,plainText,textWidth,wrapText} from './terminalText'
import {brokenTableRows,mobileTables,splitRedrawSeam} from './mobileTables'
import {mobileChrome} from './mobileChrome'

const cursorTail = /\r(?:\x1b\[(\d+)([AB]))?(?:\x1b\[(\d+)C)?\x1b\[\?25([hl])$/
export interface SourceFrame {data:string;wrappedRows?:number[]}
export interface CopyRow {source:{text:string};start:number;end:number}

function splitFrame(data:string) {
  const tail=data.match(cursorTail)
  const lines=(tail?data.slice(0,tail.index):data).split('\r\n')
  const dy=tail?Number(tail[1]||0)*(tail[2]==='B'?1:-1):0
  return {lines, cursor:tail?{row:lines.length-1+dy,col:Number(tail[3]||0),visible:tail[4]==='h'}:undefined}
}

// Both inputs retain source coordinates. Never splice already-wrapped rows:
// the number of display rows can change on every update/phone rotation.
export function replaceSourceScreen(snapshot:string, screen:string, sourceRows:number):string {
  const history=splitFrame(snapshot).lines.slice(0,-sourceRows)
  return history.length?history.join('\r\n')+'\r\n'+screen:screen
}

export function replaceFrameScreen(snapshot:SourceFrame,screen:SourceFrame,sourceRows:number):SourceFrame{
  const history=Math.max(0,splitFrame(snapshot.data).lines.length-sourceRows)
  return {data:replaceSourceScreen(snapshot.data,screen.data,sourceRows),wrappedRows:[
    ...(snapshot.wrappedRows||[]).filter(row=>row<history),
    ...(screen.wrappedRows||[]).map(row=>row+history),
  ]}
}

// Undo what a resize does to the rows an app draws again (brokenTableRows,
// splitRedrawSeam). `from` is each returned line's index in `lines`; the line
// at `keep` (the cursor's) is left alone.
function repairRedraw(lines:string[],keep?:number){
  const broken=brokenTableRows(lines)
  const out:string[]=[],from:number[]=[]
  for(let i=0;i<lines.length;i++){
    const joined=i!==keep&&i+1!==keep?broken.get(i):undefined
    out.push(joined??lines[i]);from.push(i)
    if(joined!==undefined)i++
  }
  let changed=out.length<lines.length
  for(let i=out.length-2;i>=0;i--){
    const split=from[i]!==keep&&splitRedrawSeam(out[i],out[i+1])
    if(split){out.splice(i,1,...split);from.splice(i,0,from[i]);changed=true}
  }
  return {lines:out,from,changed}
}

export function reflowFrame(data:string, cols:number, sourceRows:number,wrappedRows:number[]=[] ) {
  const source=splitFrame(data)
  let lines=source.lines,cursor=source.cursor
  let sourceIndices=lines.map((_,i)=>i)
  const sourceRowStarts:number[]=[]
  const wrapped:string[]=[]
  const copyRows:CopyRow[]=[]
  const displayCopies=(rows:string[])=>rows.map(line=>{const text=plainText(line);return {source:{text},start:0,end:text.length}})
  let screenStart=Math.max(0,lines.length-sourceRows)
  // Empty padding belongs to the source grid, not mobile reading space. Keep
  // every content row and the cursor row, including an empty input prompt.
  while(lines.length>Math.max(screenStart+1,(cursor?.row??0)+1)&&lines[lines.length-1]==='')lines.pop()
  // Join only rows tmux marked as soft-wrapped. Explicit newlines, code
  // indentation and list boundaries are never guessed from their wording.
  const joins=new Set(wrappedRows.filter(row=>Number.isInteger(row)&&row>=0&&row<lines.length-1))
  const historySeam=joins.has(screenStart-1)
  if(joins.size){
    const logical:string[]=[]
    const indices:number[]=[]
    let newStart=0,newCursor=cursor
    for(let row=0;row<lines.length;row++){
      const first=row
      let text=lines[row],offset=0
      if(cursor?.row===row)newCursor={...cursor,row:logical.length}
      while(joins.has(row)&&row+1<lines.length){
        offset=textWidth(text);row++
        if(cursor?.row===row)newCursor={...cursor,row:logical.length,col:offset+cursor.col}
        text+=lines[row]
      }
      if(first<=screenStart&&row>=screenStart)newStart=logical.length
      logical.push(text)
      indices.push(first)
    }
    lines=logical;sourceIndices=indices;screenStart=newStart;cursor=newCursor
  }
  const repaired=repairRedraw(lines,cursor?.row)
  if(repaired.changed){
    const from=repaired.from,start=from.findIndex(row=>row>=screenStart)
    sourceIndices=from.map(row=>sourceIndices[row])
    screenStart=start<0?from.length:start
    if(cursor)cursor={...cursor,row:from.indexOf(cursor.row)}
    lines=repaired.lines
  }
  const tables=mobileTables(lines,cols,cursor)
  const chrome=mobileChrome(lines,cols,cursor)
  const style=new AnsiStyle()
  let historyRows=0, cursorRow=0, cursorCol=0
  for(let row=0;row<lines.length;row++) {
    sourceRowStarts[sourceIndices[row]]??=wrapped.length
    if(row===screenStart)historyRows=wrapped.length
    const chromeRow=chrome.get(row)
    if(chromeRow&&!tables.has(row)){
      if(cursor?.row===row){cursorRow=wrapped.length+chromeRow.cursorRow;cursorCol=chromeRow.cursorCol}
      wrapped.push(...chromeRow.lines)
      copyRows.push(...displayCopies(chromeRow.lines))
      style.feed(lines[row])
      continue
    }
    const tableRow=tables.get(row)
    if(tableRow){
      if(cursor?.row===row){cursorRow=wrapped.length;cursorCol=0}
      wrapped.push(...tableRow)
      copyRows.push(...displayCopies(tableRow))
      style.feed(lines[row])
      continue
    }
    const projection=wrapText(style.prefix+lines[row],cols,cursor?.row===row?cursor.col:undefined)
    style.feed(lines[row])
    if(cursor?.row===row){cursorRow=wrapped.length+projection.cursorRow;cursorCol=projection.cursorCol}
    wrapped.push(...projection.lines)
    const copySource={text:plainText(lines[row])}
    copyRows.push(...projection.lines.map((line,i)=>({source:copySource,start:projection.textStarts[i],end:projection.textStarts[i]+plainText(line).length})))
  }
  let output=wrapped.join('\r\n')
  if(cursor) {
    const up=wrapped.length-1-cursorRow
    output+='\r'+(up>0?`\x1b[${up}A`:'')+(cursorCol>0?`\x1b[${cursorCol}C`:'')+`\x1b[?25${cursor.visible?'h':'l'}`
  }
  return {data:output, lines:wrapped, copyRows, sourceRowStarts, cursor:cursor?{row:cursorRow,col:cursorCol,visible:cursor.visible}:undefined, rows:wrapped.length-historyRows, historyRows, hasLayout:tables.size>0||chrome.size>0,
    screenHasLayout:[...tables.keys(),...chrome.keys()].some(row=>row>=screenStart),historySeam}
}

// Desktop shows the source grid, except where a narrower width broke it: tmux
// re-wraps every row of a table printed wider than the terminal is now, and the
// app redraws only its latest output. Such a table in history is joined back
// (only where tmux marked a soft wrap) and drawn again to fit, as on a phone,
// and the table rows a redraw broke or stuck to the old copy are repaired.
// Everything else, and the screen rows the app still draws on, stays as is.
export function fitHistoryTables(frame:SourceFrame,cols:number,sourceRows:number):string{
  const tail=frame.data.match(cursorTail)
  const lines=(tail?frame.data.slice(0,tail.index):frame.data).split('\r\n')
  const history=lines.length-sourceRows
  const joins=new Set((frame.wrappedRows||[]).filter(row=>row>=0&&row<history-1))
  const chains:string[]=[],spans:[number,number][]=[]
  for(let row=0;row<history;row++){
    const first=row
    let text=lines[row]
    while(joins.has(row))text+=lines[++row]
    chains.push(text);spans.push([first,row])
  }
  const {lines:logical,from,changed}=repairRedraw(chains)
  // Only a wrapped row that starts with a box border can be part of a table to fit.
  const tables=changed||[...joins].some(row=>/^ *[│┃║┌├└╭╰┏┣┗╔╠╚]/.test(plainText(lines[row])))?mobileTables(logical,cols,undefined,true):new Map<number,string[]>()
  if(!tables.size&&!changed)return frame.data
  // A repaired line is drawn from its text; any other keeps tmux's rows.
  const out=logical.flatMap((text,i)=>tables.get(i)||(text===chains[from[i]]?lines.slice(spans[from[i]][0],spans[from[i]][1]+1):wrapText(text,cols).lines))
  return [...out,...lines.slice(history)].join('\r\n')+(tail?.[0]||'')
}

// Keep only the source block that can affect the next screen projection.
// Tables/input boxes may cross the seam; their entire contiguous block stays
// in the tail, as does a paragraph's verified soft-wrap chain. Stable history
// remains rendered at the same phone width until a fresh snapshot/rotation.
export function mobileHistoryTail(snapshot:SourceFrame,sourceRows:number,frame:ReturnType<typeof reflowFrame>){
  const {lines}=splitFrame(snapshot.data),history=Math.max(0,lines.length-sourceRows)
  const joins=new Set(snapshot.wrappedRows||[])
  const layout=(line:string)=>/^\s*[│┃║|┌┬┐└┴┘├┼┤╭╮╰╯┏┳┓┗┻┛┣╋┫╔╦╗╚╩╝╠╬╣+─━═]/u.test(plainText(line))
  let start=history
  while(start>0&&(joins.has(start-1)||layout(lines[start-1])))start--
  // Preserve the last few history rows for possible footer recognition. Back
  // up again if this cut lands inside a wrapped paragraph or a table block.
  start=Math.max(0,start-8)
  while(start>0&&(joins.has(start-1)||layout(lines[start-1])))start--
  const style=new AnsiStyle();for(let row=0;row<start;row++)style.feed(lines[row])
  const tailLines=lines.slice(start)
  if(tailLines.length)tailLines[0]=style.prefix+tailLines[0]
  const tail=snapshot.data.match(cursorTail)?.[0]||''
  const cut=frame.sourceRowStarts[start]??frame.lines.length
  return {prefix:frame.lines.slice(0,cut),copyPrefix:frame.copyRows.slice(0,cut),source:{
    data:tailLines.join('\r\n')+tail,wrappedRows:(snapshot.wrappedRows||[]).filter(row=>row>=start).map(row=>row-start),
  }}
}
