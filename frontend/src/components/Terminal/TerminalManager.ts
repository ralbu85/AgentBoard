import { Terminal } from '@xterm/xterm'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { send } from '../../ws'

// Canonical tmux pane size — every client renders this exact shape.
// Backend pins the tmux pane to the same values, so there's no resize whiplash
// when desktop + mobile view the same session simultaneously.
const CANONICAL_COLS = 80
const CANONICAL_ROWS = 40

const isMobile = window.innerWidth <= 768

interface TermInstance {
  term: Terminal
  searchAddon: SearchAddon
  el: HTMLDivElement
  opened: boolean
}

const terminals = new Map<string, TermInstance>()
const _pendingSnapshots = new Map<string, string>()
const _pendingScreens = new Map<string, string>()

export function create(id: string): TermInstance {
  const existing = terminals.get(id)
  if (existing) return existing

  const term = new Terminal({
    cols: CANONICAL_COLS,
    rows: CANONICAL_ROWS,
    cursorBlink: !isMobile,  // mobile has no stdin — blinking cursor only confuses
    cursorStyle: 'bar',
    disableStdin: isMobile,
    scrollback: 10000,
    fontSize: isMobile ? 10 : 13,
    letterSpacing: 0,
    fontFamily: '"D2Coding", "Cascadia Code", "Cascadia Mono", "Consolas", monospace',
    theme: {
      background: '#101014', foreground: '#ececf1', cursor: '#ececf1',
      selectionBackground: 'rgba(124, 108, 240, 0.25)',
      black: '#3b3b4f', red: '#ef6b6b', green: '#45d483', yellow: '#e5a63e',
      blue: '#7c9df0', magenta: '#b89cf0', cyan: '#4dd4c0', white: '#ececf1',
      brightBlack: '#5c5c6e', brightRed: '#f09090', brightGreen: '#6ee6a0',
      brightYellow: '#efc060', brightBlue: '#9db8f0', brightMagenta: '#d0b4f0',
      brightCyan: '#60e8d0', brightWhite: '#f5f5fa',
    },
    allowProposedApi: true,
  })

  const searchAddon = new SearchAddon()
  term.loadAddon(searchAddon)
  term.loadAddon(new WebLinksAddon())

  if (!isMobile) {
    term.onData((data: string) => {
      send({ type: 'terminal-input', id, data })
    })
  }

  const el = document.createElement('div')
  el.className = 'xterm-wrap'
  el.id = `xterm-${id}`

  const inst: TermInstance = { term, searchAddon, el, opened: false }
  terminals.set(id, inst)
  return inst
}

export function open(id: string, container: HTMLElement) {
  const t = terminals.get(id) || create(id)
  if (!t.opened) {
    t.el.style.display = ''
    container.appendChild(t.el)
    t.term.open(t.el)
    t.opened = true
    t.term.resize(CANONICAL_COLS, CANONICAL_ROWS)
    if (isMobile) _setupMobileScroll(t)
    t.term.reset()
    refit(id)
    setTimeout(() => {
      refit(id)
      send({ type: 'resync', id })
      const pending = _pendingSnapshots.get(id) || _pendingScreens.get(id)
      if (pending) {
        t.term.write('\x1b[2J\x1b[H' + pending)
        _pendingSnapshots.delete(id)
        _pendingScreens.delete(id)
      }
    }, 200)
  } else if (t.el.parentElement !== container) {
    container.appendChild(t.el)
  }
}

// Rows scale to fill the terminal container on both mobile and desktop —
// width drives font, height drives row count.
const TARGET_FONT = isMobile ? 10 : 13
const MIN_FONT = 8
const _lastSentRows = new Map<string, number>()

export function refit(id: string) {
  const t = terminals.get(id)
  if (!t?.opened) return
  const container = t.el.parentElement
  if (!container) return

  const cH = container.clientHeight
  const cW = container.clientWidth
  if (cH <= 0 || cW <= 0) return

  const core = (t.term as any)._core
  const cellH = core?._renderService?.dimensions?.css?.cell?.height
  const cellW = core?._renderService?.dimensions?.css?.cell?.width
  if (!cellH || !cellW) return

  const curFont = (t.term.options.fontSize as number) || TARGET_FONT
  const cellWPerFont = cellW / curFont
  const cellHPerFont = cellH / curFont
  const fontByWidth = Math.floor(cW / (CANONICAL_COLS * cellWPerFont))
  const newFont = Math.max(MIN_FONT, Math.min(TARGET_FONT, fontByWidth))

  if (newFont !== curFont) {
    t.term.options.fontSize = newFont
  }
  // Project cell height from the (font-independent) ratio so we don't read a
  // stale dimension before xterm has applied the new fontSize.
  const projectedCellH = cellHPerFont * newFont

  const fitRows = Math.max(CANONICAL_ROWS, Math.min(200, Math.floor(cH / projectedCellH)))

  if (t.term.rows !== fitRows || t.term.cols !== CANONICAL_COLS) {
    t.term.resize(CANONICAL_COLS, fitRows)
  }

  if (_lastSentRows.get(id) !== fitRows) {
    _lastSentRows.set(id, fitRows)
    send({ type: 'resize', id, rows: fitRows })
  }
}

function _setupMobileScroll(t: TermInstance) {
  const wrap = t.el
  const vp = wrap.querySelector('.xterm-viewport') as HTMLElement
  if (!vp) return

  // Disable xterm's touch handling so our custom scroll wins
  const xtermEl = wrap.querySelector('.xterm') as HTMLElement
  if (xtermEl) xtermEl.style.pointerEvents = 'none'
  vp.style.pointerEvents = 'none'
  const screen = wrap.querySelector('.xterm-screen') as HTMLElement
  if (screen) screen.style.pointerEvents = 'none'

  let lastY = 0
  let velocity = 0
  let ts = 0
  let raf = 0

  wrap.addEventListener('touchstart', (e) => {
    e.stopPropagation()
    cancelAnimationFrame(raf)
    lastY = e.touches[0].clientY
    velocity = 0
    ts = Date.now()
  }, { capture: true, passive: true })

  wrap.addEventListener('touchmove', (e) => {
    e.stopPropagation()
    const y = e.touches[0].clientY
    const dy = lastY - y
    const now = Date.now()
    const dt = now - ts
    if (dt > 0) velocity = dy / dt
    vp.scrollTop += dy
    lastY = y
    ts = now
  }, { capture: true, passive: true })

  wrap.addEventListener('touchend', (e) => {
    e.stopPropagation()
    if (Math.abs(velocity) < 0.05) return
    let v = velocity
    const tick = () => {
      v *= 0.93
      if (Math.abs(v) < 0.01) return
      vp.scrollTop += v * 16
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
  }, { capture: true, passive: true })
}

export function scrollToBottom(id: string) {
  const t = terminals.get(id)
  if (!t?.opened) return
  t.term.scrollToBottom()
}

export function isScrolledUp(id?: string) {
  if (!id) return false
  const t = terminals.get(id)
  if (!t?.opened) return false
  const buf = t.term.buffer.active
  return buf.viewportY < buf.baseY
}

export function writeSnapshot(id: string, data: string) {
  const t = terminals.get(id) || create(id)
  if (!t.opened) {
    _pendingSnapshots.set(id, data)
    return
  }
  // \x1b[3J trims xterm's scrollback, \x1b[2J clears the visible rows,
  // \x1b[H homes the cursor. Embedding all three in the data string puts
  // them in the same write-queue entry as the snapshot — atomic relative
  // to other queued writes. (term.clear() runs synchronously but write()
  // is async, so a fast resync that triggers two snapshots in flight
  // could otherwise stack their contents.)
  t.term.write('\x1b[3J\x1b[2J\x1b[H' + data, () => {
    t.term.scrollToBottom()
  })
}

// writeScreen: clear the visible area, home the cursor, dump the fresh frame.
// `\x1b[2J` only touches the visible grid, not scrollback — so if the user has
// scrolled up, xterm preserves their scroll position automatically.
export function writeScreen(id: string, data: string) {
  const t = terminals.get(id)
  if (!t || !t.opened) {
    _pendingScreens.set(id, data)
    return
  }
  if (t.el.style.display === 'none') return
  t.term.write('\x1b[2J\x1b[H' + data)
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

export function search(id: string, q: string) {
  const t = terminals.get(id)
  if (!t?.searchAddon) return
  if (q) t.searchAddon.findNext(q)
  else t.searchAddon.clearDecorations()
}

export function destroy(id: string) {
  const t = terminals.get(id)
  if (!t) return
  t.term.dispose()
  t.el.remove()
  terminals.delete(id)
  _pendingSnapshots.delete(id)
  _pendingScreens.delete(id)
  _lastSentRows.delete(id)
}
