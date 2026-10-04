import {AnsiStyle,plainText,textWidth,wrapText} from './terminalText'
import {mobileTables} from './mobileTables'
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
  const tables=mobileTables(lines,cols,cursor)
  const chrome=mobileChrome(lines,cols,cursor)
  const style=new AnsiStyle()
  let historyRows=0, cursorRow=0, cursorCol=0
  for(let row=0;row<lines.length;row++) {
    sourceRowStarts[sourceIndices[row]]=wrapped.length
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
