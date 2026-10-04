import { Terminal } from '@xterm/xterm'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { loadTerminalPreferences, terminalPreferenceKey, desktopColumns, viewportRows, viewportScale, type TerminalPreferences } from './readability'
import {handleCopyKey, writeClipboard} from './clipboard'
import {reflowFrame, replaceFrameScreen, mobileHistoryTail, type SourceFrame} from './reflow'
import {NativeTerminalSelection} from './nativeSelection'
import {MobileTerminalView} from './MobileTerminalView'
import {useToasts} from '../../toasts'
import { send } from '../../ws'
import { useStore, workspaceId } from '../../store'

// The terminal's whole buffer (scrollback + visible) as plain text.
export function getBufferText(id: string): string {
  const t = terminals.get(id)
  if (!t?.opened) return ''
  if(t.mobileView)return t.mobileView.text
  const buf = t.term.buffer.active
  const lines: string[] = []
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '')
  return lines.join('\n').replace(/\n+$/, '')
}

export function getCopySnapshot(id:string) {
  const text=getBufferText(id),t=terminals.get(id)
  const cellHeight=(t?.term as any)?._core?._renderService?.dimensions?.css?.cell?.height||1
  const top=t?.mobileView?.firstVisibleLine??((t?.term.buffer.active.viewportY||0)+(isMobile?Math.floor((t?.el.scrollTop||0)/cellHeight):0))
  return {text,firstVisibleLine:Math.max(0,Math.min(text.split('\n').length-1,top)),fontSize:preferences.fontSize}
}

export async function copySelection(id:string):Promise<void> {
  const text=terminals.get(id)?.term.getSelection()||''
  if(!text){useToasts.getState().push('복사할 텍스트를 드래그해 선택하세요. 실행 중단은 ‘실행 중단’ 버튼을 사용하세요.');return}
  try{await writeClipboard(text);useToasts.getState().push('선택한 내용을 복사했습니다.')}
  catch(error){useToasts.getState().push(error instanceof Error?error.message:'복사 실패')}
}

// Full-screen (alt-screen) apps keep their history inside the app, reachable
// with PageUp/PageDown — not in the terminal's scrollback. So translate scroll
// gestures on those sessions into page keys sent to the app.
function _isAltScreen(id: string): boolean {
  return !!useStore.getState().sessions[id]?.altScreen
}
function _sendPage(id: string, up: boolean) {
  send({ type: 'key', id, key: up ? 'PageUp' : 'PageDown' })
}

// Initial grid and fallback for older servers. The viewing desktop can change
// source columns. Phones wrap captures locally, without changing source width.
const CANONICAL_COLS = 80
const CANONICAL_ROWS = 40

export const isMobileViewport = window.matchMedia?.('(pointer: coarse)').matches ?? window.innerWidth <= 768
const isMobile = isMobileViewport
let preferences = loadTerminalPreferences(isMobile)
const touchTerminal = isMobile

interface TermInstance {
  id: string
  term: Terminal
  searchAddon: SearchAddon
  el: HTMLDivElement
  opened: boolean
  snapshot?: SourceFrame
  screen?: SourceFrame
  sourceTop?: number
  needsSnapshot?: boolean
  resyncAt?: number
  mobileHasLayout?: boolean
  mobileHistorySeam?: boolean
  mobileView?: MobileTerminalView
  mobileHistory?: ReturnType<typeof mobileHistoryTail>
  nativeSelection?: NativeTerminalSelection
  nativeFrames?: {snapshot?:FrameArgs;screen?:FrameArgs;version?:number}
  nativeRefit?: boolean
  nativeMeasure?: boolean
}

type FrameArgs=Parameters<typeof writeSnapshot>

// At most one snapshot and one newer screen are held, regardless of how long
// the user keeps iOS selection handles open. Geometry travels with each frame.
function holdNativeFrame(id:string,kind:'snapshot'|'screen',args:FrameArgs){
  const t=terminals.get(id)
  if(!t?.nativeSelection?.locked)return false
  const version=args[5],previous=t.nativeFrames?.version??grids.get(id)?.version
  if(version!==undefined&&previous!==undefined&&version<previous)return true
  const frames=t.nativeFrames??={}
  if(kind==='snapshot'){frames.snapshot=args;frames.screen=undefined}else frames.screen=args
  if(version!==undefined)frames.version=version
  return true
}

function resumeNative(t:TermInstance){
  if(t.nativeSelection?.locked)return
  const frames=t.nativeFrames;t.nativeFrames=undefined
  if(frames?.snapshot)writeSnapshot(...frames.snapshot)
  if(frames?.screen)writeScreen(...frames.screen)
  if(t.nativeMeasure){
    t.nativeMeasure=false
    t.mobileView?.invalidateMeasure()
    t.term.options.fontSize=preferences.fontSize;t.term.options.lineHeight=preferences.lineHeight
    try{(t.term as any)._core?._charSizeService?.measure?.()}catch{/* internal API */}
    t.term.refresh(0,t.term.rows-1)
  }
  if(t.nativeRefit){t.nativeRefit=false;refit(t.id)}
}

export function clearNativeSelection(id:string){terminals.get(id)?.nativeSelection?.clear()}

const terminals = new Map<string, TermInstance>()

// ── LRU eviction ──
// Each xterm instance holds a ~10k-line scrollback buffer (~6-10 MB). Visiting
// many sessions otherwise leaves them all resident — on a phone that grows the
// heap until the tab is force-reloaded. Keep the N most-recently-used; dispose
// the rest. A disposed session is rebuilt from the next snapshot on re-open, so
// nothing is lost. Never evict the active session or a currently-mounted tile
// (grid shows several at once).
const MAX_LIVE_TERMINALS = isMobile ? 4 : 12
const _lru: string[] = [] // least-recently-used first, most-recent last

function _touch(id: string) {
  const i = _lru.indexOf(id)
  if (i >= 0) _lru.splice(i, 1)
  _lru.push(id)
}

function _evict() {
  if (terminals.size <= MAX_LIVE_TERMINALS) return
  const activeId = useStore.getState().activeId
  for (const id of [..._lru]) {
    if (terminals.size <= MAX_LIVE_TERMINALS) break
    if (id === activeId) continue
    const t = terminals.get(id)
    if (!t) { const j = _lru.indexOf(id); if (j >= 0) _lru.splice(j, 1); continue }
    // Protect anything on screen: the current single view or a grid tile.
    if (t.opened && t.el.isConnected && t.el.style.display !== 'none') continue
    destroy(id) // removes from terminals + pending maps + _lru
  }
}

const _pendingSnapshots = new Map<string, SourceFrame>()
const _pendingScreens = new Map<string, SourceFrame>()
// Latest snapshot held back while the user is scrolled up (see writeSnapshot).
const _deferredSnapshots = new Map<string, SourceFrame>()

export function create(id: string): TermInstance {
  const existing = terminals.get(id)
  if (existing) return existing

  const term = new Terminal({
    cols: CANONICAL_COLS,
    rows: CANONICAL_ROWS,
    cursorBlink: !touchTerminal,  // Touch scrolling uses the input card; hardware keys remain enabled.
    cursorStyle: 'bar',
    disableStdin: false,
    scrollback: 10000,
    fontSize: preferences.fontSize,
    lineHeight: preferences.lineHeight,
    minimumContrastRatio: 4.5,
    letterSpacing: 0,
    // Lead with the bundled D2Coding so BOTH Latin and Hangul come from one
    // font where Hangul = exactly 2 Latin cells — no gaps in the fixed grid.
    // (A crisp SF Mono for Latin + system Hangul mismatched their metrics and
    // left the wide-spacing look.) ui-monospace backs it up.
    fontFamily: '"D2Coding", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    theme: {
      background: '#101014', foreground: '#ececf1', cursor: '#ececf1',
      selectionBackground: 'rgba(124, 108, 240, 0.25)',
      black: '#7c8495', red: '#ef6b6b', green: '#45d483', yellow: '#e5a63e',
      blue: '#7c9df0', magenta: '#b89cf0', cyan: '#4dd4c0', white: '#ececf1',
      brightBlack: '#9ca3af', brightRed: '#f09090', brightGreen: '#6ee6a0',
      brightYellow: '#efc060', brightBlue: '#9db8f0', brightMagenta: '#d0b4f0',
      brightCyan: '#60e8d0', brightWhite: '#f5f5fa',
    },
    allowProposedApi: true,
  })

  const searchAddon = new SearchAddon()
  term.loadAddon(searchAddon)
  term.loadAddon(new WebLinksAddon((event, url) => {
    event.preventDefault()
    if(event.ctrlKey||event.metaKey||event.shiftKey){window.open(url,'_blank','noopener,noreferrer');return}
    const state=useStore.getState(), session=state.sessions[id]
    state.openBrowser(url,session?workspaceId(session.cwd||'~',session.host||'local'):undefined)
  }))
  // Match tmux's character-width tables for emoji/CJK — without this, xterm
  // measures some emoji as narrow that tmux counted as wide, shifting every
  // box-drawing border to the right of them (Claude Code UI is emoji-heavy).
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'

  {
    term.attachCustomKeyEventHandler?.(event=>handleCopyKey(event,()=>void copySelection(id)))
    term.onData((data: string) => {
      send({ type: 'terminal-input', id, data })
    })
  }

  const el = document.createElement('div')
  el.className = 'xterm-wrap'
  el.id = `xterm-${id}`

  const inst: TermInstance = { id, term, searchAddon, el, opened: false }
  terminals.set(id, inst)
  _touch(id)
  _evict()
  return inst
}

export function open(id: string, container: HTMLElement) {
  const t = terminals.get(id) || create(id)
  _touch(id)
  if (!t.opened) {
    t.el.style.display = ''
    container.appendChild(t.el)
    if(isMobile)t.mobileView=new MobileTerminalView(t.el)
    else t.term.open(t.el)
    t.opened = true
    t.term.resize(CANONICAL_COLS, CANONICAL_ROWS)
    if (touchTerminal) {
      t.nativeSelection=new NativeTerminalSelection(t.el,()=>resumeNative(t))
      _setupMobileScroll(id, t)
    }
    else _setupWheelPaging(id, t)
    t.term.reset()
    refit(id)
    setTimeout(() => {
      if(terminals.get(id)!==t||!t.opened)return
      refit(id)
      send({ type: 'resync', id })
      const pending = _pendingSnapshots.get(id) || _pendingScreens.get(id)
      if (pending) {
        if(_pendingSnapshots.has(id))_applySnapshot(t,pending)
        else _writeScreen(t,pending)
        _pendingSnapshots.delete(id)
        _pendingScreens.delete(id)
      }
    }, 200)
  } else if (t.el.parentElement !== container) {
    container.appendChild(t.el)
  }
}

// Readable 12–22px text; display scaling and extra history rows stay client-local.
export function setReadability(patch: Partial<TerminalPreferences>) {
  preferences = { ...preferences, ...patch }
  preferences.fontSize = Math.max(12, Math.min(22, preferences.fontSize))
  preferences.lineHeight = Math.max(1, Math.min(1.5, preferences.lineHeight))
  try { localStorage.setItem(terminalPreferenceKey(isMobile), JSON.stringify(preferences)) } catch {}
  for (const [id, instance] of terminals) {
    if(instance.nativeSelection?.locked){instance.nativeMeasure=true;instance.nativeRefit=true;continue}
    instance.term.options.fontSize = preferences.fontSize
    instance.term.options.lineHeight = preferences.lineHeight
    requestAnimationFrame(() => refit(id))
  }
}
export function getReadability() { return { ...preferences } }
type Grid={cols:number;rows:number;fullRows?:boolean;version?:number;dynamic?:boolean}
const grids=new Map<string,Grid>()
function receiveGrid(id:string,cols=CANONICAL_COLS,rows=CANONICAL_ROWS,fullRows=false,version?:number,dynamic=false):boolean {
  if(!Number.isInteger(cols)||cols<30||cols>240||!Number.isInteger(rows)||rows<1||rows>200)return false
  const old=grids.get(id)
  if(old?.version!==undefined&&version!==undefined&&version<old.version)return false
  const changed=!!old&&(old.cols!==cols||old.rows!==rows||old.version!==version)
  grids.set(id,{cols,rows,fullRows,version,dynamic})
  const t=terminals.get(id)
  if(changed){
    _deferredSnapshots.delete(id);_pendingSnapshots.delete(id);_pendingScreens.delete(id)
    if(t){t.snapshot=undefined;t.screen=undefined;t.mobileHistory=undefined;t.sourceTop=0;t.needsSnapshot=true}
  }
  if(t&&!isMobile&&(t.term.cols!==cols||!old||old.rows!==rows||old.fullRows!==fullRows))t.term.resize(cols,rows)
  if(t?.opened)refit(id)
  return true
}

const viewportRequests=new Map<string,{device:string;cols:number;sent:number}>()
const viewportTimers=new Map<string,ReturnType<typeof setTimeout>>()
function requestViewport(id:string,cols:number){
  const t=terminals.get(id)
  if(!t?.el.isConnected||document.hidden)return
  const device=isMobile?'mobile':'desktop'
  const previous=viewportRequests.get(id)
  if(previous?.device===device&&previous.cols===cols&&Date.now()-previous.sent<5000)return
  clearTimeout(viewportTimers.get(id))
  viewportRequests.set(id,{device,cols,sent:Date.now()})
  viewportTimers.set(id,setTimeout(()=>{
    viewportTimers.delete(id)
    if(!t.el.isConnected||t.el.style.display==='none'||document.hidden)return
    viewportRequests.set(id,{device,cols,sent:Date.now()})
    send({type:'viewport',id,device,cols})
  },180))
}
export function releaseViewport(id:string){
  clearTimeout(viewportTimers.get(id));viewportTimers.delete(id)
  if(viewportRequests.delete(id))send({type:'viewport-release',id})
}
export function refreshViewports(){
  for(const [id,t] of terminals){
    if(t.opened&&t.el.isConnected&&t.el.style.display!=='none'&&!document.hidden){
      const previous=viewportRequests.get(id)
      if(previous)previous.sent=0
      refit(id)
    }else releaseViewport(id)
  }
}
// Keep ownership while visible, and release it when a tab/device leaves.
if(typeof document!=='undefined'){
  setInterval(refreshViewports,5000)
  document.addEventListener('visibilitychange',refreshViewports)
}

export function refit(id: string) {
  const t = terminals.get(id)
  if (!t?.opened) return
  if(t.nativeSelection?.locked){t.nativeRefit=true;return}
  const container = t.el.parentElement
  if (!container || container.clientWidth<=0 || container.clientHeight<=0) return
  const grid=grids.get(id)||{cols:CANONICAL_COLS,rows:CANONICAL_ROWS}
  const cell=t.mobileView?.measure(preferences.fontSize,preferences.lineHeight)||(t.term as any)._core?._renderService?.dimensions?.css?.cell
  const cellW=cell?.width
  if(!cellW)return
  if(isMobile){
    // Native font size and device-local columns: neither tiny text nor a
    // horizontally clipped source grid. The process retains its own geometry.
    const cols=Math.max(2,Math.min(240,Math.floor(container.clientWidth/cellW)))
    if(grid.dynamic)requestViewport(id,cols)
    if(t.term.cols!==cols){
      const scrolled=isScrolledUp(id),position=t.term.buffer.active.viewportY
      t.term.resize(cols,t.term.rows)
      if(t.snapshot!==undefined&&!t.needsSnapshot){
        const data=t.screen===undefined?t.snapshot:replaceFrameScreen(t.snapshot,t.screen,grid.rows)
        _renderMobileSnapshot(t,data,!scrolled,position)
      }
    }
    const screen=t.el.querySelector<HTMLElement>('.xterm')
    if(screen){screen.style.zoom='1';screen.style.width=`${cols*cellW}px`}
    t.el.dataset.cols=String(cols)
    t.el.dataset.sourceCols=String(grid.cols)
    t.el.dataset.rows=String(t.term.rows)
    t.el.dataset.sourceRows=String(grid.rows)
    t.el.dataset.scale='1'
    return
  }
  const scale=viewportScale(container.clientWidth,grid.cols*cellW,true)
  const scaleChanged=t.el.dataset.scale!==undefined&&Number(t.el.dataset.scale)!==scale
  const followOutput=!isScrolledUp(id),scrollPosition=t.term.buffer.active.viewportY
  const preserveZoomScroll=scaleChanged&&!t.needsSnapshot
  if(grid.dynamic)requestViewport(id,desktopColumns(container.clientWidth,cellW))
  const rows=viewportRows(container.clientHeight,cell.height,scale,grid.rows,!isMobile&&!!grid.fullRows)
  if(t.term.cols!==grid.cols||t.term.rows!==rows){
    const scrolled=isScrolledUp(id),position=t.term.buffer.active.viewportY
    t.term.resize(grid.cols,rows)
    // Rebuild from applied frames so extra rows contain history, not duplicates.
    const snapshot=t.snapshot,latest=t.screen
    if(snapshot!==undefined)_applySnapshot(t,snapshot)
    if(latest!==undefined)_writeScreen(t,latest)
    if(scrolled)t.term.write('',()=>t.term.scrollToLine(position))
  }
  const screen=t.el.querySelector<HTMLElement>('.xterm')
  if(screen){screen.style.zoom=String(scale);screen.style.width=`${grid.cols*cellW}px`}
  t.el.dataset.cols=String(grid.cols)
  t.el.dataset.rows=String(rows)
  t.el.dataset.sourceRows=String(grid.rows)
  t.el.dataset.scale=String(scale)
  // CSS zoom changes native scroll offsets on mobile rotation. Restore the
  // logical buffer position after layout instead of letting it jump to history.
  // A new grid needs its fresh snapshot to choose the position instead.
  if(preserveZoomScroll)requestAnimationFrame(()=>{
    if(terminals.get(id)!==t||Number(t.el.dataset.scale)!==scale||t.needsSnapshot||grids.get(id)?.version!==grid.version)return
    if(followOutput)t.term.scrollToBottom()
    else t.term.scrollToLine(scrollPosition)
  })
  // Only a desktop viewer negotiates the process's source columns.
}

// Desktop: on a full-screen session, a mouse wheel scrolls the APP's history
// (PageUp/PageDown) instead of the terminal's empty scrollback. Normal sessions
// keep native xterm scrollback.
function _setupWheelPaging(id: string, t: TermInstance) {
  let accum = 0
  let lastSend = 0
  t.el.addEventListener('wheel', (e) => {
    if (!_isAltScreen(id)) return  // normal session → native scrollback
    // Pan a clipped source grid before navigating the application's history.
    const before=t.el.scrollTop
    t.el.scrollTop+=e.deltaY
    if(t.el.scrollTop!==before){e.preventDefault();return}
    e.preventDefault()
    const now = Date.now()
    accum += e.deltaY
    if (now - lastSend < 60 || Math.abs(accum) < 24) return
    _sendPage(id, accum < 0)
    accum = 0
    lastSend = now
  }, { passive: false })
}

function _setupMobileScroll(_id: string, t: TermInstance) {
  // Native momentum, direction changes, selection auto-scroll and pinch belong
  // to the phone browser. Touches never scroll a second surface or send keys.
  let x=0,y=0,moved=false
  t.el.addEventListener('touchstart',e=>{
    if(e.touches.length!==1)return
    x=e.touches[0].clientX;y=e.touches[0].clientY;moved=false
    t.nativeSelection?.beginPress()
  },{passive:true})
  t.el.addEventListener('touchmove',e=>{
    if(e.touches.length!==1){t.nativeSelection?.endPress();return}
    if(!moved&&Math.max(Math.abs(e.touches[0].clientX-x),Math.abs(e.touches[0].clientY-y))>=8){moved=true;t.nativeSelection?.endPress()}
  },{passive:true})
  for(const event of ['touchend','touchcancel'])t.el.addEventListener(event,()=>t.nativeSelection?.endPress(),{passive:true})
}

// Page the terminal VIEW up/down. Normal sessions keep history in xterm's
// scrollback → scroll locally (sending PageUp to the app would be a no-op).
// Alt-screen apps own their history → caller should send the key instead.
export function pageView(id: string, up: boolean): boolean {
  if (_isAltScreen(id)) return false
  const t = terminals.get(id)
  if (!t?.opened) return false
  t.nativeSelection?.clear()
  if(t.mobileView)t.mobileView.page(up)
  else t.term.scrollPages(up ? -1 : 1)
  return true
}

export function scrollToBottom(id: string) {
  const t = terminals.get(id)
  if (!t?.opened) return
  t.nativeSelection?.clear()
  const deferred = _deferredSnapshots.get(id)
  if (deferred !== undefined) {
    // Apply the held-back snapshot instead of just jumping: it rebuilds the
    // scrollback that grew while the user was reading, then pins to bottom.
    _deferredSnapshots.delete(id)
    _applySnapshot(t, deferred)
    return
  }
  t.term.scrollToBottom()
  if(isMobile)t.el.scrollTop=t.el.scrollHeight
}

export function isScrolledUp(id?: string) {
  if (!id) return false
  const t = terminals.get(id)
  if (!t?.opened) return false
  if(t.mobileView)return t.mobileView.scrolledUp
  const buf = t.term.buffer.active
  return buf.viewportY < buf.baseY || (isMobile&&t.el.scrollHeight-t.el.clientHeight-t.el.scrollTop>2)
}

// \x1b[3J trims xterm's scrollback, \x1b[2J clears the visible rows,
// \x1b[H homes the cursor. Embedding all three in the data string puts
// them in the same write-queue entry as the snapshot — atomic relative
// to other queued writes. (term.clear() runs synchronously but write()
// is async, so a fast resync that triggers two snapshots in flight
// could otherwise stack their contents.)
function _applySnapshot(t: TermInstance, frame: SourceFrame,follow=true) {
  const data=frame.data
  t.needsSnapshot=false
  t.snapshot=frame
  t.screen=undefined
  if(isMobile){_renderMobileSnapshot(t,frame,follow);return}
  const grid=grids.get(t.id)
  t.sourceTop=grid?.fullRows?Math.max(0,Math.min(t.term.rows-grid.rows,data.split('\n').length-grid.rows)):0
  t.term.write('\x1b[0m\x1b[3J\x1b[2J\x1b[H' + data, () => {
    t.term.scrollToBottom()
  })
}

function _renderMobileSnapshot(t:TermInstance,data:SourceFrame,follow=true,position=0){
  const frame=reflowFrame(data.data,t.term.cols,grids.get(t.id)?.rows||CANONICAL_ROWS,data.wrappedRows)
  t.mobileHasLayout=frame.screenHasLayout
  t.mobileHistorySeam=frame.historySeam
  // A source history row may occupy many phone rows. Do not silently discard
  // its beginning at xterm's ordinary 10k display-row limit after wrapping.
  t.term.options.scrollback=Math.max(10000,frame.historyRows)
  const scrollTop=t.el.scrollTop
  t.term.resize(t.term.cols,Math.max(1,frame.rows))
  t.sourceTop=0
  t.el.dataset.rows=String(t.term.rows)
  if(t.mobileView){
    t.mobileHistory=mobileHistoryTail(data,grids.get(t.id)?.rows||CANONICAL_ROWS,frame)
    t.mobileView.render(frame.lines,frame.cursor,follow,frame.copyRows)
    return
  }
  t.term.write('\x1b[0m\x1b[3J\x1b[2J\x1b[H'+frame.data,()=>{
    if(follow){t.term.scrollToBottom();t.el.scrollTop=t.el.scrollHeight}
    else {t.term.scrollToLine(position);t.el.scrollTop=scrollTop}
  })
}

export function writeSnapshot(id: string, data: string, cols?:number, rows?:number, fullRows?:boolean, gridVersion?:number, dynamicWidth?:boolean,wrappedRows?:number[]) {
  if(holdNativeFrame(id,'snapshot',[id,data,cols,rows,fullRows,gridVersion,dynamicWidth,wrappedRows]))return
  if(!receiveGrid(id,cols,rows,fullRows,gridVersion,dynamicWidth))return
  const t = terminals.get(id) || create(id)
  const frame={data,wrappedRows:Array.isArray(wrappedRows)?wrappedRows:undefined}
  if (!t.opened) {
    _pendingSnapshots.set(id, frame)
    return
  }
  // While the user is scrolled up reading, a rebuild would erase the buffer
  // under them and yank the viewport to the bottom — and snapshots arrive
  // continuously while a session streams (history keeps growing). Hold only
  // the LATEST snapshot and apply it once the viewport returns to the bottom
  // (flushDeferred / scrollToBottom / next writeScreen at bottom).
  if (isScrolledUp(id)&&!t.needsSnapshot) {
    _deferredSnapshots.set(id, frame)
    return
  }
  _deferredSnapshots.delete(id)
  _pendingSnapshots.delete(id);_pendingScreens.delete(id)
  _applySnapshot(t, frame,!t.mobileView?.scrolledUp)
}

// Apply a held-back snapshot once the user has scrolled back to the bottom.
// Called from TerminalPane's scroll-state poll so an idle session (no further
// frames) still catches up after a manual scroll-down.
export function flushDeferred(id?: string) {
  if (!id) return
  const t = terminals.get(id)
  const deferred = _deferredSnapshots.get(id)
  if (!t?.opened || t.nativeSelection?.locked || deferred === undefined || isScrolledUp(id)) return
  _deferredSnapshots.delete(id)
  _applySnapshot(t, deferred)
}

// Screen frames overwrite the source region below the extra history rows.
// Scrollback and a reader's current scroll position remain intact.
export function writeScreen(id: string, data: string, cols?:number, rows?:number, fullRows?:boolean, gridVersion?:number, dynamicWidth?:boolean,wrappedRows?:number[]) {
  if(holdNativeFrame(id,'screen',[id,data,cols,rows,fullRows,gridVersion,dynamicWidth,wrappedRows]))return
  if(!receiveGrid(id,cols,rows,fullRows,gridVersion,dynamicWidth))return
  const t = terminals.get(id)
  const frame={data,wrappedRows:Array.isArray(wrappedRows)?wrappedRows:undefined}
  if (!t || !t.opened) {
    _pendingScreens.set(id, frame)
    return
  }
  if (t.el.style.display === 'none') return
  if(t.needsSnapshot){
    if(Date.now()-(t.resyncAt||0)>500){t.resyncAt=Date.now();send({type:'resync',id})}
    return
  }
  const deferred = _deferredSnapshots.get(id)
  if (deferred !== undefined && !isScrolledUp(id)) {
    // Back at the bottom: restore the scrollback that grew while scrolled up,
    // then let the fresh frame below overwrite the visible area.
    _deferredSnapshots.delete(id)
    _applySnapshot(t, deferred)
  }
  _writeScreen(t,frame)
}

function _writeScreen(t:TermInstance,data:SourceFrame){
  t.screen=data
  if(isMobile){
    const sourceRows=grids.get(t.id)?.rows||CANONICAL_ROWS
    if(isScrolledUp(t.id)){
      // Freeze all screen updates while reading, not only tables. A changing
      // prompt height must never move the text under the user's finger.
      const snapshot=_deferredSnapshots.get(t.id)??t.snapshot
      _deferredSnapshots.set(t.id,snapshot===undefined?data:replaceFrameScreen(snapshot,data,sourceRows))
      return
    }
    if(t.mobileView&&t.mobileHistory){
      const tail=replaceFrameScreen(t.mobileHistory.source,data,sourceRows)
      const projection=reflowFrame(tail.data,t.term.cols,sourceRows,tail.wrappedRows)
      const prefix=t.mobileHistory.prefix
      t.mobileView.render([...prefix,...projection.lines],projection.cursor?{...projection.cursor,row:prefix.length+projection.cursor.row}:undefined,true,[...t.mobileHistory.copyPrefix,...projection.copyRows])
      return
    }
    const frame=reflowFrame(data.data,t.term.cols,sourceRows,data.wrappedRows)
    if(t.mobileView||t.term.rows!==frame.rows||t.mobileHasLayout||t.mobileHistorySeam||frame.hasLayout){
      _renderMobileSnapshot(t,t.snapshot===undefined?data:replaceFrameScreen(t.snapshot,data,sourceRows))
    }else {
      t.term.write('\x1b[0m\x1b[1;1H\x1b[J'+frame.data,()=>{
        if(!t.nativeSelection?.locked){t.term.scrollToBottom();t.el.scrollTop=t.el.scrollHeight}
      })
    }
    return
  }
  // Keep the extra history rows intact; only overwrite the source screen.
  t.term.write(`\x1b[0m\x1b[${(t.sourceTop||0)+1};1H\x1b[J`+data.data)
}

export function writeStream(id: string, data: string) {
  const t = terminals.get(id) || create(id)
  if (!t.opened) return
  t.term.write(data)
}

export function show(id: string) {
  terminals.forEach((t, k) => {
    t.el.style.display = k === id ? '' : 'none'
  })
}

// Reveal one terminal without hiding the others (grid view shows many at once).
export function reveal(id: string) {
  const t = terminals.get(id)
  if (t) t.el.style.display = ''
}

// Mount a session's terminal into a grid tile: open (create/re-parent), make
// visible, and fit it to the tile. Used by SessionGrid for each tile.
export function mountInto(id: string, container: HTMLElement) {
  open(id, container)
  reveal(id)
  refit(id)
}

export function search(id: string, q: string) {
  const t = terminals.get(id)
  if (!t?.searchAddon) return
  t.nativeSelection?.clear()
  if(t.mobileView){t.mobileView.search(q);return}
  if (q) t.searchAddon.findNext(q)
  else t.searchAddon.clearDecorations()
}

// Test hook: ids of live (non-disposed) terminal instances.
export function _liveIds(): string[] {
  return [...terminals.keys()]
}

export function destroy(id: string) {
  releaseViewport(id)
  const t = terminals.get(id)
  if (!t) return
  t.nativeSelection?.dispose()
  t.mobileView?.dispose()
  t.term.dispose()
  t.el.remove()
  grids.delete(id)
  terminals.delete(id)
  _pendingSnapshots.delete(id)
  _pendingScreens.delete(id)
  _deferredSnapshots.delete(id)
  const i = _lru.indexOf(id)
  if (i >= 0) _lru.splice(i, 1)
}

// xterm measures its cell size once, on open. If a terminal opened before the
// bundled mono font finished loading, cells carry the fallback's metrics and
// Hangul misaligns. When the font is ready, force each open terminal to
// re-measure the cell and re-fit before negotiating desktop columns.
if (typeof document !== 'undefined' && document.fonts?.ready) {
  document.fonts.ready
    .then(() => document.fonts.load('15px "D2Coding"', 'ABC한글'))
    .catch(() => {})
    .finally(() => {
      terminals.forEach((t, id) => {
        if (!t.opened) return
        if(t.nativeSelection?.locked){t.nativeMeasure=true;t.nativeRefit=true;return}
        t.mobileView?.invalidateMeasure()
        try { (t.term as any)._core?._charSizeService?.measure?.() } catch { /* internal API */ }
                    refit(id)
        t.term.refresh(0, t.term.rows - 1)
      })
    })
}
