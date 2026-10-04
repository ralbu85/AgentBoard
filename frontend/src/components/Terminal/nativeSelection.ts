// Keep the existing rendered terminal text available to the browser's own
// selection handles/copy menu. Never synthesize a menu or focus xterm's input.
export class NativeTerminalSelection {
  private pressed=false
  private paused=false
  private settling=false
  private timer:ReturnType<typeof setTimeout>|undefined
  private disposed=false
  private readonly events=['mousedown','mouseup','mousemove','click','contextmenu','copy']

  constructor(private root:HTMLElement,private resume:()=>void){
    root.classList.add('native-terminal-selection')
    for(const event of this.events)root.addEventListener(event,this.keepNative,true)
    document.addEventListener('selectionchange',this.changed)
  }
  private within(node:Node|null){
    const element=node?.nodeType===Node.ELEMENT_NODE?node as Element:node?.parentElement
    const rows=element?.closest('.xterm-rows, .mobile-terminal-text')
    return !!rows&&this.root.contains(rows)
  }
  get selected(){
    const selection=window.getSelection(),rows=this.root.querySelector('.mobile-terminal-text, .xterm-rows')
    return !!selection&&!selection.isCollapsed&&
      (this.within(selection.anchorNode)||this.within(selection.focusNode)||!!rows&&selection.rangeCount>0&&selection.getRangeAt(0).intersectsNode(rows))
  }
  get locked(){
    const locked=!this.disposed&&(this.pressed||this.selected||this.settling)
    if(locked)this.paused=true
    return locked
  }
  private keepNative=(event:Event)=>{
    // xterm cancels mousedown and redirects contextmenu to a hidden textarea.
    // Stop its handlers while retaining the browser's default selection/copy.
    if(this.within(event.target as Node)||event.type==='copy'&&this.selected)event.stopPropagation()
  }
  private changed=()=>{
    this.root.classList.toggle('has-native-selection',this.selected)
    if(this.selected){this.paused=true;this.settling=false;clearTimeout(this.timer)}else this.scheduleResume()
  }
  beginPress(){
    clearTimeout(this.timer);this.pressed=true;this.paused=true
  }
  endPress(){this.pressed=false;this.scheduleResume()}
  private scheduleResume(){
    clearTimeout(this.timer)
    if(this.pressed||!this.paused)return
    this.settling=true
    // Native handles can briefly collapse/recreate a range while being moved.
    // Wait for that gesture to settle before applying the latest output.
    this.timer=setTimeout(()=>{
      this.settling=false
      if(!this.disposed&&!this.locked&&this.paused){this.paused=false;this.resume()}
    },120)
  }
  clear(){
    clearTimeout(this.timer);this.pressed=false;this.settling=false
    if(this.selected)window.getSelection()?.removeAllRanges()
    this.root.classList.remove('has-native-selection')
    if(!this.disposed&&this.paused){this.paused=false;this.resume()}
  }
  dispose(){
    this.disposed=true;clearTimeout(this.timer)
    if(this.selected)window.getSelection()?.removeAllRanges()
    for(const event of this.events)this.root.removeEventListener(event,this.keepNative,true)
    document.removeEventListener('selectionchange',this.changed)
    this.root.classList.remove('native-terminal-selection','has-native-selection')
  }
}
