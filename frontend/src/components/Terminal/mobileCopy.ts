import type {CopyRow} from './reflow'

// Display rows may wrap inside a URL/token, or omit wrapping whitespace. Map a
// native selection back to its logical source; never guess which newlines to join.
export function selectedSource(range:Range,nodes:HTMLElement[],rows:CopyRow[]):string|null {
  let result='',previous:CopyRow|undefined,previousEnd=0,breakAfter=false,found=false
  for(let i=0;i<nodes.length;i++){
    const node=nodes[i],row=rows[i]
    if(!row||!range.intersectsNode(node))continue
    const offset=(container:Node,n:number,fallback:number)=>{
      if(!node.contains(container))return fallback
      const prefix=document.createRange();prefix.selectNodeContents(node);prefix.setEnd(container,n)
      return prefix.toString().length
    }
    const length=row.end-row.start
    const from=offset(range.startContainer,range.startOffset,0)
    const to=offset(range.endContainer,range.endOffset,length+1)
    if(to<=from)continue
    const start=row.start+Math.min(from,length)
    const last=rows[i+1]?.source!==row.source
    const end=to>length&&last&&/^\s*$/.test(row.source.text.slice(row.end))?row.source.text.length:row.start+Math.min(to,length)
    if(previous?.source===row.source){result+=row.source.text.slice(previousEnd,end)}
    else {if(previous&&breakAfter)result+='\n';result+=row.source.text.slice(start,end)}
    found=true;previous=row;previousEnd=end
    breakAfter=to>length&&rows[i+1]?.source!==row.source
  }
  return found?result+(breakAfter?'\n':''):null
}

export function textLinks(text:string):{start:number;end:number;url:string}[]{
  const result:{start:number;end:number;url:string}[]=[]
  for(const match of text.matchAll(/https?:\/\/[^\s<>"'`\x00-\x1f]+/gi)){
    let value=match[0].replace(/[.,;:!?]+$/,'')
    for(const [open,close] of [['(',')'],['[',']'],['{','}']]){
      while(value.endsWith(close)&&value.split(close).length>value.split(open).length)value=value.slice(0,-1)
    }
    try{
      const url=new URL(value)
      if(value.length<=8192&&!url.username&&!url.password&&['http:','https:'].includes(url.protocol))result.push({start:match.index!,end:match.index!+value.length,url:url.href})
    }catch{/* malformed URL remains ordinary selectable text */}
  }
  return result
}
