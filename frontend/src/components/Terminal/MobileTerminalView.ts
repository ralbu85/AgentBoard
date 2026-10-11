import {plainText,AnsiStyle,textWidth,textGraphemes} from './terminalText'
import type {CopyRow} from './reflow'
import {selectedSource,textLinks} from './mobileCopy'
import {isMobileTableRow} from './mobileTables'

type Cursor={row:number;col:number;visible:boolean}
const palette=['#7c8495','#ef6b6b','#45d483','#e5a63e','#7c9df0','#b89cf0','#4dd4c0','#ececf1','#9ca3af','#f09090','#6ee6a0','#efc060','#9db8f0','#d0b4f0','#60e8d0','#f5f5fa']
function color(value:number){
  if(value<16)return palette[value]
  if(value>=232)return `rgb(${Array(3).fill(8+(value-232)*10).join(',')})`
  const index=value-16,levels=[0,95,135,175,215,255]
  return `rgb(${[levels[Math.floor(index/36)],levels[Math.floor(index/6)%6],levels[index%6]].join(',')})`
}
function attributes(sgr:string){
  const style:Record<string,string>={};let inverse=false
  const codes=(sgr.match(/\x1b\[([\d;:]*)m/g)||[]).flatMap(s=>s.slice(2,-1).replace(/(38|48|58):2::/g,'$1;2;').replace(/:/g,';').split(';').map(Number))
  for(let i=0;i<codes.length;i++){
    const n=codes[i]
    if(n===0){for(const key of Object.keys(style))delete style[key];inverse=false}
    else if(n===1)style.fontWeight='600'
    else if(n===2)style.opacity='.72'
    else if(n===3)style.fontStyle='italic'
    else if(n===4)style.textDecoration='underline'
    else if(n===7)inverse=true
    else if(n===8)style.visibility='hidden'
    else if(n===9)style.textDecoration='line-through'
    else if(n===38||n===48){
      const key=n===38?'color':'backgroundColor',mode=codes[++i]
      if(mode===5)style[key]=color(Math.max(0,Math.min(255,codes[++i])))
      else if(mode===2){const rgb=codes.slice(i+1,i+4);i+=3;if(rgb.length===3&&rgb.every(v=>v>=0&&v<=255))style[key]=`rgb(${rgb.join(',')})`}
    }else if(n>=30&&n<=37)style.color=color(n-30)
    else if(n>=90&&n<=97)style.color=color(n-90+8)
    else if(n>=40&&n<=47)style.backgroundColor=color(n-40)
    else if(n>=100&&n<=107)style.backgroundColor=color(n-100+8)
    else if(n===39)delete style.color
    else if(n===49)delete style.backgroundColor
  }
  if(inverse){const fg=style.color||'#ececf1';style.color=style.backgroundColor||'#101014';style.backgroundColor=fg}
  return style
}

function gridText(span:HTMLElement,text:string){
  // ASCII runs stay compact (especially long links). Fallback-font graphemes
  // occupy explicit terminal columns, without splitting emoji/combining marks.
  const runs:{text:string;width:number}[]=[]
  for(const glyph of textGraphemes(text)){
    const width=textWidth(glyph),last=runs[runs.length-1]
    if(last&&(width===0||(/^[\x20-\x7e]+$/.test(glyph)&&/^[\x20-\x7e]+$/.test(last.text)))){
      last.text+=glyph;last.width+=width
    }else runs.push({text:glyph,width})
  }
  span.classList.add('mobile-terminal-grid-run')
  span.style.gridTemplateColumns=`repeat(${Math.max(1,textWidth(text))}, minmax(0, 1fr))`
  let column=1
  for(const run of runs){
    const cell=document.createElement('span');cell.textContent=run.text
    cell.style.gridColumn=`${column} / span ${Math.max(1,run.width)}`
    cell.style.gridRow='1';span.append(cell);column+=run.width
  }
}

// A normal DOM document is the phone's scroll/selection surface. It does not
// rearrange xterm internals, synthesize momentum, or send swipe gestures to a PTY.
// tmux supplies decoded captures; desktop keeps its own xterm renderer.
export class MobileTerminalView {
  readonly content=document.createElement('pre')
  private caret=document.createElement('span')
  private source:string[]=[]
  private nodes:HTMLSpanElement[]=[]
  private copies:CopyRow[]=[]
  private linkSources:{text:string;start:number}[]=[]
  private fontSize=12
  private lineHeight=1
  private searchOffset=-1
  private searchQuery=''
  private metrics?:{width:number;height:number}
  private renderedLineHeight=12
  private readonly onCopy=(event:ClipboardEvent)=>{
    const selection=window.getSelection()
    if(!this.root.isConnected||!event.clipboardData||!selection||selection.isCollapsed||selection.rangeCount!==1)return
    const range=selection.getRangeAt(0)
    if(!this.content.contains(range.startContainer)||!this.content.contains(range.endContainer))return
    const text=selectedSource(range,this.nodes,this.copies)
    if(text!==null){event.clipboardData.setData('text/plain',text);event.preventDefault()}
  }
  constructor(readonly root:HTMLElement){
    root.classList.add('mobile-output-scroll')
    this.content.className='mobile-terminal-text'
    this.content.setAttribute('aria-label','터미널 출력')
    this.caret.className='mobile-terminal-caret';this.caret.setAttribute('aria-hidden','true')
    this.content.append(this.caret)
    root.append(this.content)
    // Keep iOS's native selection/menu. Only the clipboard payload is corrected
    // so display wrapping never becomes a newline inside a command or URL.
    document.addEventListener('copy',this.onCopy,true)
  }
  dispose(){document.removeEventListener('copy',this.onCopy,true)}
  measure(fontSize:number,lineHeight:number){
    if(this.metrics&&this.fontSize===fontSize&&this.lineHeight===lineHeight)return this.metrics
    this.fontSize=fontSize;this.lineHeight=lineHeight
    this.content.style.fontSize=fontSize+'px';this.content.style.lineHeight=String(lineHeight)
    const probe=document.createElement('span');probe.textContent='M'.repeat(100)
    probe.style.cssText='position:absolute;visibility:hidden;white-space:pre;pointer-events:none'
    this.content.append(probe)
    const width=probe.getBoundingClientRect().width/100;probe.remove()
    this.content.style.setProperty('--mobile-cell-width',(width||fontSize/2)+'px')
    return this.metrics={width:width||fontSize/2,height:fontSize*lineHeight}
  }
  invalidateMeasure(){this.metrics=undefined}
  get text(){return this.copies.filter((row,i)=>i===0||row.source!==this.copies[i-1].source).map(row=>row.source.text).join('\n').replace(/\n+$/,'')}
  get scrolledUp(){return this.root.scrollHeight-this.root.clientHeight-this.root.scrollTop>2}
  get firstVisibleLine(){return Math.max(0,Math.floor(this.root.scrollTop/(this.fontSize*this.lineHeight)))}
  bottom(){this.root.scrollTop=this.root.scrollHeight}
  page(up:boolean){this.root.scrollBy?.({top:(up?-1:1)*this.root.clientHeight*.85,behavior:'smooth'})}
  render(lines:string[],cursor:Cursor|undefined,follow:boolean,copyRows?:CopyRow[]){
    const scroll=this.root.scrollTop
    const oldRow=Math.floor(scroll/this.renderedLineHeight),inset=scroll%this.renderedLineHeight
    const anchor=plainText(this.source[oldRow]||'').trim().slice(0,24)
    // Retain unchanged rows and their text nodes. Typical status updates touch
    // only the tail; never rebuild thousands of history rows on each poll.
    this.copies=copyRows||lines.map(line=>{const text=plainText(line);return {source:{text},start:0,end:text.length}})
    const links=new Map<CopyRow['source'],ReturnType<typeof textLinks>>()
    for(let i=0;i<lines.length;i++){
      const copy=this.copies[i]
      const oldLinkSource=this.linkSources[i]
      if(this.source[i]===lines[i]&&oldLinkSource?.text===copy.source.text&&oldLinkSource.start===copy.start)continue
      const row=document.createElement('span');row.className='mobile-terminal-line'
      const grid=isMobileTableRow(lines[i])?document.createElement('span'):undefined
      if(grid){
        grid.className='mobile-terminal-grid'
        grid.style.gridTemplateColumns=`repeat(${Math.max(1,textWidth(lines[i]))}, var(--mobile-cell-width, .5em))`
        row.append(grid)
      }
      const state=new AnsiStyle()
      if(!links.has(copy.source))links.set(copy.source,textLinks(copy.source.text))
      const rowLinks=links.get(copy.source)!
      let position=copy.start,column=1
      for(const token of lines[i].match(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][0-2A-Z]|[^\x1b]+/g)||[]){
        if(token.startsWith('\x1b')){state.feed(token);continue}
        const end=position+token.length
        while(position<end){
          const link=rowLinks.find(link=>link.start<=position&&link.end>position)
          const next=rowLinks.find(link=>link.start>position)
          const until=Math.min(end,link?.end??next?.start??end)
          const span=document.createElement(link?'a':'span')
          if(link){const anchor=span as HTMLAnchorElement;anchor.href=link.url;anchor.target='_blank';anchor.rel='noopener noreferrer';anchor.referrerPolicy='no-referrer'}
          Object.assign(span.style,attributes(state.prefix))
          const text=token.slice(position-(end-token.length),until-(end-token.length))
          if(grid){
            const width=textWidth(text)
            span.style.gridColumn=`${column} / span ${Math.max(1,width)}`;span.style.gridRow='1'
            gridText(span,text);grid.append(span);column+=width
          }else {span.textContent=text;row.append(span)}
          position=until
        }
      }
      // Explicit text-node newlines preserve blank lines and indentation in
      // native Copy, including selections spanning many off-screen rows.
      row.append(document.createTextNode('\n'))
      if(this.nodes[i])this.nodes[i].replaceWith(row)
      else this.content.append(row)
      this.nodes[i]=row
      this.linkSources[i]={text:copy.source.text,start:copy.start}
    }
    for(let i=lines.length;i<this.nodes.length;i++)this.nodes[i].remove()
    this.nodes.length=lines.length;this.linkSources.length=lines.length;this.source=[...lines]
    this.caret.style.display=cursor?.visible?'':'none'
    if(cursor){this.caret.style.left=cursor.col+'ch';this.caret.style.top=cursor.row*this.lineHeight+'em'}
    this.renderedLineHeight=this.fontSize*this.lineHeight
    if(follow)this.bottom()
    else {
      let row=-1
      if(anchor)for(let i=0;i<lines.length;i++){
        if(plainText(lines[i]).includes(anchor)&&(row<0||Math.abs(i-oldRow)<Math.abs(row-oldRow)))row=i
      }
      this.root.scrollTop=row<0?scroll:row*this.renderedLineHeight+inset
    }
  }
  search(query:string){
    if(!query){this.searchOffset=-1;this.searchQuery='';return}
    const text=this.source.map(plainText).join('\n')+'\n'
    const start=this.searchQuery===query?this.searchOffset+1:0
    let found=text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase(),start)
    if(found<0)found=text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase())
    if(found<0)return
    this.searchQuery=query;this.searchOffset=found
    const walker=document.createTreeWalker(this.content,NodeFilter.SHOW_TEXT)
    const range=document.createRange();let offset=0,started=false,node:Node|null
    while((node=walker.nextNode())){
      const length=node.textContent?.length||0
      if(!started&&found<offset+length){range.setStart(node,found-offset);started=true}
      if(started&&found+query.length<=offset+length){range.setEnd(node,found+query.length-offset);break}
      offset+=length
    }
    if(started&&node){const selection=window.getSelection();selection?.removeAllRanges();selection?.addRange(range);node.parentElement?.scrollIntoView?.({block:'center',inline:'nearest'})}
  }
}
