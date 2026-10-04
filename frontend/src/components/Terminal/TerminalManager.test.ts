/**
 * Tests the REAL TerminalManager against @xterm/headless (aliased in
 * vitest.config.ts) — the scroll-deferral state machine, LRU eviction, and
 * page-view routing run on the actual xterm core buffer, no browser needed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../../store'
import * as TM from './TerminalManager'

const made: string[] = []

function makeOpened(id: string) {
  made.push(id)
  const inst = TM.create(id)
  // Tests don't mount into a real DOM — mark writable directly.
  inst.opened = true
  return inst
}

const flush = (inst: ReturnType<typeof TM.create>) =>
  new Promise<void>((res) => inst.term.write('', () => res()))

const lines = (tag: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${tag}-${i + 1}`).join('\r\n')

function bufText(inst: ReturnType<typeof TM.create>): string {
  const b = inst.term.buffer.active
  const out: string[] = []
  for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '')
  return out.join('\n')
}

const viewportY = (inst: ReturnType<typeof TM.create>) => inst.term.buffer.active.viewportY
const atBottom = (inst: ReturnType<typeof TM.create>) =>
  inst.term.buffer.active.viewportY === inst.term.buffer.active.baseY

afterEach(() => {
  for (const id of made.splice(0)) TM.destroy(id)
  useStore.setState({ activeId: null, sessions: {} } as never)
})

describe('snapshot application', () => {
  it('applies at bottom and pins the viewport to the bottom', async () => {
    const inst = makeOpened('s1')
    TM.writeSnapshot('s1', lines('first', 100))
    await flush(inst)
    expect(bufText(inst)).toContain('first-100')
    expect(atBottom(inst)).toBe(true)
  })

  it('defers while scrolled up: content and scroll position stay put', async () => {
    const inst = makeOpened('s2')
    TM.writeSnapshot('s2', lines('old', 100))
    await flush(inst)
    inst.term.scrollLines(-10)
    const vp = viewportY(inst)
    expect(TM.isScrolledUp('s2')).toBe(true)

    TM.writeSnapshot('s2', lines('new', 100))
    await flush(inst)
    expect(bufText(inst)).toContain('old-100')   // buffer untouched
    expect(bufText(inst)).not.toContain('new-100')
    expect(viewportY(inst)).toBe(vp)             // reader not yanked
  })

  it('holds only the LATEST deferred snapshot', async () => {
    const inst = makeOpened('s3')
    TM.writeSnapshot('s3', lines('base', 100))
    await flush(inst)
    inst.term.scrollLines(-10)
    TM.writeSnapshot('s3', lines('mid', 50))
    TM.writeSnapshot('s3', lines('last', 50))
    TM.scrollToBottom('s3')
    await flush(inst)
    expect(bufText(inst)).toContain('last-50')
    expect(bufText(inst)).not.toContain('mid-50')
  })
})

describe('returning to the bottom', () => {
  it('TM.scrollToBottom applies the deferred snapshot and pins bottom', async () => {
    const inst = makeOpened('r1')
    TM.writeSnapshot('r1', lines('old', 100))
    await flush(inst)
    inst.term.scrollLines(-10)
    TM.writeSnapshot('r1', lines('new', 100))

    TM.scrollToBottom('r1')
    await flush(inst)
    expect(bufText(inst)).toContain('new-100')
    expect(bufText(inst)).not.toContain('old-100') // \x1b[3J rebuilt the buffer
    expect(atBottom(inst)).toBe(true)
  })

  it('flushDeferred is a no-op while scrolled up, applies once back at bottom', async () => {
    const inst = makeOpened('r2')
    TM.writeSnapshot('r2', lines('old', 100))
    await flush(inst)
    inst.term.scrollLines(-10)
    TM.writeSnapshot('r2', lines('new', 100))

    TM.flushDeferred('r2')                       // still scrolled up → no-op
    await flush(inst)
    expect(bufText(inst)).not.toContain('new-100')

    inst.term.scrollToBottom()                   // user scrolls down manually
    TM.flushDeferred('r2')                       // TerminalPane's 300ms poll path
    await flush(inst)
    expect(bufText(inst)).toContain('new-100')
  })

  it('writeScreen at bottom flushes the deferred snapshot first', async () => {
    const inst = makeOpened('r3')
    TM.writeSnapshot('r3', lines('old', 100))
    await flush(inst)
    inst.term.scrollLines(-10)
    TM.writeSnapshot('r3', lines('grown', 100))

    inst.term.scrollToBottom()
    TM.writeScreen('r3', 'FRESH-FRAME')
    await flush(inst)
    const text = bufText(inst)
    // Scrollback from the deferred snapshot is restored (rows that were above
    // the visible area)…
    expect(text).toContain('grown-60')
    // …while the visible area belongs to the live frame — the snapshot's
    // bottom rows are intentionally overwritten by the fresher screen state.
    expect(text).toContain('FRESH-FRAME')
    expect(text).not.toContain('old-100')
  })
})

describe('writeScreen while scrolled up', () => {
  it('updates the screen rows without moving the viewport or flushing', async () => {
    const inst = makeOpened('w1')
    TM.writeSnapshot('w1', lines('old', 100))
    await flush(inst)
    inst.term.scrollLines(-10)
    const vp = viewportY(inst)
    TM.writeSnapshot('w1', lines('deferred', 100))

    TM.writeScreen('w1', 'LIVE-FRAME')
    await flush(inst)
    expect(bufText(inst)).toContain('LIVE-FRAME')      // screen area updated
    expect(bufText(inst)).not.toContain('deferred-100') // still held back
    expect(viewportY(inst)).toBe(vp)                    // reader undisturbed
  })
})

describe('LRU eviction', () => {
  it('caps live instances and never evicts the active session', () => {
    useStore.setState({ activeId: 'e-0' } as never)
    for (let i = 0; i < 14; i++) makeOpened(`e-${i}`)
    const live = TM._liveIds().filter((id) => id.startsWith('e-'))
    expect(live.length).toBeLessThanOrEqual(12)  // MAX_LIVE_TERMINALS (desktop)
    expect(live).toContain('e-0')                // active survives
    expect(live).not.toContain('e-1')            // oldest non-active evicted
  })
})

describe('pageView routing', () => {
  it('scrolls the local scrollback for normal sessions', async () => {
    useStore.setState({ sessions: { p1: { altScreen: false } } } as never)
    const inst = makeOpened('p1')
    TM.writeSnapshot('p1', lines('pg', 200))
    await flush(inst)
    const before = viewportY(inst)
    expect(TM.pageView('p1', true)).toBe(true)   // handled locally
    expect(viewportY(inst)).toBeLessThan(before)
  })

  it('declines for alt-screen sessions so the caller forwards the key', () => {
    useStore.setState({ sessions: { p2: { altScreen: true } } } as never)
    makeOpened('p2')
    expect(TM.pageView('p2', true)).toBe(false)
  })
})


describe('independent desktop height',()=>{
  function display(id:string,height:number){
    const inst=makeOpened(id)
    const container=document.createElement('div')
    Object.defineProperty(container,'clientWidth',{value:800,configurable:true})
    Object.defineProperty(container,'clientHeight',{value:height,configurable:true})
    ;(inst.term as any)._core._renderService={dimensions:{css:{cell:{width:8,height:15}}}}
    container.append(inst.el)
    return {inst,container}
  }
  it('fills taller views with history and updates only the bottom source screen',async()=>{
    const {inst,container}=display('height-history',900)
    TM.writeSnapshot(inst.id,lines('old',140),80,40,true)
    await flush(inst)
    expect(inst.term.rows).toBe(60)
    expect(inst.term.cols).toBe(80)
    const view=()=>inst.term.buffer.active.getLine(inst.term.buffer.active.viewportY)?.translateToString(true)
    expect(view()).toBe('old-81')
    TM.writeScreen(inst.id,lines('live',40),80,40,true)
    await flush(inst)
    expect(view()).toBe('old-81')
    expect(bufText(inst)).toContain('old-100')
    expect(bufText(inst)).not.toContain('old-101')
    expect(bufText(inst)).toContain('live-40')
    Object.defineProperty(container,'clientHeight',{value:630,configurable:true})
    TM.refit(inst.id);await flush(inst)
    expect(inst.term.rows).toBe(42)
    expect(view()).toBe('old-99')
    Object.defineProperty(container,'clientHeight',{value:1050,configurable:true})
    TM.refit(inst.id);await flush(inst)
    expect(inst.term.rows).toBe(70)
    expect(view()).toBe('old-71')
    expect(bufText(inst).match(/live-40/g)).toHaveLength(1)
  })
  it('preserves empty source rows, cursor coordinates, and the reader position',async()=>{
    const {inst,container}=display('height-cursor',900)
    const screen='first\r\nsecond\r\nprompt'+ '\r\n'.repeat(37)+'\r\x1b[37A\x1b[6C'
    TM.writeSnapshot(inst.id,lines('history',80)+'\r\n'+screen,80,40,true)
    await flush(inst)
    expect(inst.term.buffer.active.cursorY).toBe(22)
    expect(inst.term.buffer.active.cursorX).toBe(6)
    TM.writeScreen(inst.id,screen.replace('prompt','answer'),80,40,true)
    await flush(inst)
    expect(inst.term.buffer.active.cursorY).toBe(22)
    inst.term.scrollLines(-20)
    const position=viewportY(inst)
    Object.defineProperty(container,'clientHeight',{value:750,configurable:true})
    TM.refit(inst.id);await flush(inst)
    expect(viewportY(inst)).toBe(position)
    expect(bufText(inst)).toContain('answer')
  })
  it('keeps the source height for older servers without full-row frames',async()=>{
    const {inst}=display('height-legacy',900)
    TM.writeSnapshot(inst.id,lines('legacy',100),80,40)
    await flush(inst)
    expect(inst.term.rows).toBe(40)
  })
  it('preserves the logical scroll position when CSS zoom changes native offsets',async()=>{
    const {inst,container}=display('zoom-scroll',900)
    TM.writeSnapshot(inst.id,lines('history',100),80,40)
    await flush(inst)
    const frames:FrameRequestCallback[]=[]
    vi.stubGlobal('requestAnimationFrame',(cb:FrameRequestCallback)=>{frames.push(cb);return frames.length})
    try{
      Object.defineProperty(container,'clientWidth',{value:400,configurable:true})
      TM.refit(inst.id)
      inst.term.scrollLines(-10) // native scroll adjustment during zoom layout
      frames.shift()!(0)
      expect(atBottom(inst)).toBe(true)
      inst.term.scrollLines(-20)
      const position=viewportY(inst)
      Object.defineProperty(container,'clientWidth',{value:320,configurable:true})
      TM.refit(inst.id)
      inst.term.scrollToBottom()
      frames.shift()!(0)
      expect(viewportY(inst)).toBe(position)
    }finally{vi.unstubAllGlobals()}
  })
})


describe('dynamic source width',()=>{
  it('replaces old-width history and rejects frames from an older grid revision',async()=>{
    const inst=makeOpened('dynamic-source')
    TM.writeSnapshot(inst.id,lines('old',100),80,40,true,10,true)
    await flush(inst)
    inst.term.scrollLines(-10)
    TM.writeSnapshot(inst.id,lines('new',100),160,40,true,11,true)
    await flush(inst)
    expect(inst.term.cols).toBe(160)
    expect(bufText(inst)).toContain('new-100')
    expect(bufText(inst)).not.toContain('old-100')
    TM.writeScreen(inst.id,lines('stale',40),80,40,true,10,true)
    await flush(inst)
    expect(inst.term.cols).toBe(160)
    expect(bufText(inst)).not.toContain('stale-40')
  })
  it('waits for a snapshot if a new-size live frame arrives before its snapshot',async()=>{
    const inst=makeOpened('dynamic-first-screen')
    TM.writeSnapshot(inst.id,lines('base',100),80,40,true,20,true)
    await flush(inst)
    TM.writeScreen(inst.id,lines('early',40),140,40,true,21,true)
    await flush(inst)
    expect(bufText(inst)).not.toContain('early-40')
    TM.writeSnapshot(inst.id,lines('replacement',100),140,40,true,21,true)
    await flush(inst)
    TM.writeScreen(inst.id,lines('current',40),140,40,true,21,true)
    await flush(inst)
    expect(bufText(inst)).toContain('replacement-60')
    expect(bufText(inst)).toContain('current-40')
  })
})
