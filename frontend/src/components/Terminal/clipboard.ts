// Copy gestures must never fall through to xterm's Ctrl+C / SIGINT mapping.
export function handleCopyKey(event:KeyboardEvent, copy:()=>void):boolean {
  if(event.altKey||!(event.ctrlKey||event.metaKey)||(event.key.toLowerCase()!=='c'&&event.code!=='KeyC'))return true
  event.preventDefault()
  if(event.type==='keydown'&&!event.repeat)copy()
  return false
}

export async function writeClipboard(text:string):Promise<void> {
  try{
    if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(text);return}
  }catch{/* LAN HTTP and denied clipboard permissions can use the copy fallback. */}
  const focused=document.activeElement as HTMLElement|null
  const selection=window.getSelection()
  const ranges=selection?Array.from({length:selection.rangeCount},(_,i)=>selection.getRangeAt(i).cloneRange()):[]
  const input=document.createElement('textarea')
  // A visible-position, 16px read-only field avoids iOS focus zoom/sideways
  // scrolling while allowing the legacy copy path on LAN HTTP connections.
  input.value=text;input.readOnly=true;input.style.cssText='position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;font-size:16px;pointer-events:none'
  document.body.appendChild(input)
  try{
    input.select()
    input.setSelectionRange(0,input.value.length)
    if(!document.execCommand('copy'))throw Error('복사할 수 없습니다. 텍스트 선택 창에서 복사해 주세요.')
  }finally{
    input.remove();focused?.focus({preventScroll:true})
    if(selection){selection.removeAllRanges();ranges.forEach(range=>selection.addRange(range))}
  }
}
