import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { send } from '../../ws'

const isMobile = window.innerWidth <= 768

interface TermInstance {
  term: Terminal
  fitAddon: FitAddon
  searchAddon: SearchAddon
  el: HTMLDivElement
  opened: boolean
}

const terminals = new Map<string, TermInstance>()
const _pendingSnapshots = new Map<string, string>()
const _pendingScreens = new Map<string, string>()

// Track if user scrolled away from bottom — writeScreen saves position
let _userScrolledUp = false
let _savedScrollTop = -1

export function create(id: string): TermInstance {
  const existing = terminals.get(id)
  if (existing) return existing

  const term = new Terminal({
    cursorBlink: true,
    cursorStyle: 'bar',
    disableStdin: isMobile,
    scrollback: 10000,
    fontSize: isMobile ? 11 : 13,
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

  const fitAddon = new FitAddon()
  term.loadAddon(fitAddon)

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

  const inst: TermInstance = { term, fitAddon, searchAddon, el, opened: false }
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
    if (isMobile) _setupMobileScroll(t)
    try { t.fitAddon.fit() } catch {}
    // Reset clears buffer and forces renderer to fully reinitialize
    t.term.reset()
    // Request fresh data after terminal + renderer is ready
    setTimeout(() => {
      try { t.fitAddon.fit() } catch {}
      send({ type: 'resync', id })
    }, 300)
    setTimeout(() => send({ type: 'resync', id }), 1500)
  } else if (t.el.parentElement !== container) {
    container.appendChild(t.el)
  }
}

function _writeData(t: TermInstance, data: string) {
  t.term.write(data, () => {
    t.term.scrollToBottom()
    _userScrolledUp = false
    _savedScrollTop = -1
  })
}

function _setupMobileScroll(t: TermInstance) {
  const wrap = t.el
  const vp = wrap.querySelector('.xterm-viewport') as HTMLElement
  if (!vp) return

  // Disable xterm's touch handling completely
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
    const dy = lastY - y  // positive = finger moved up
    const now = Date.now()
    const dt = now - ts
    if (dt > 0) velocity = dy / dt

    // Finger up → see earlier content → scrollTop DECREASES
    vp.scrollTop += dy

    // Track if user scrolled away from bottom
    const maxScroll = vp.scrollHeight - vp.clientHeight
    _userScrolledUp = vp.scrollTop < maxScroll - 10
    _savedScrollTop = vp.scrollTop

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
      const maxScroll = vp.scrollHeight - vp.clientHeight
      _userScrolledUp = vp.scrollTop < maxScroll - 10
      _savedScrollTop = vp.scrollTop
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
  }, { capture: true, passive: true })
}

// Called by scroll-to-bottom button
export function scrollToBottom(id: string) {
  const t = terminals.get(id)
  if (!t?.opened) return
  t.term.scrollToBottom()
  _userScrolledUp = false
  _savedScrollTop = -1
}

export function isScrolledUp() { return _userScrolledUp }

export function writeSnapshot(id: string, data: string) {
  const t = terminals.get(id) || create(id)
  if (!t.opened) {
    _pendingSnapshots.set(id, data)
    return
  }
  t.term.write('\x1b[2J\x1b[H' + data, () => {
    t.term.scrollToBottom()
    _userScrolledUp = false
    _savedScrollTop = -1
  })
}

// writeScreen: ALWAYS update terminal, but preserve scroll position if user scrolled up
export function writeScreen(id: string, data: string) {
  const t = terminals.get(id)
  if (!t || !t.opened) {
    _pendingScreens.set(id, data)
    return
  }
  if (t.el.style.display === 'none') return

  const vp = t.el.querySelector('.xterm-viewport') as HTMLElement
  // Use the globally tracked scroll position (updated by touch handler)
  const savedTop = _userScrolledUp ? _savedScrollTop : -1
  const wasScrolledUp = _userScrolledUp

  const lines = data.split('\r\n')
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length === 0) return

  let out = '\x1b[H'
  for (let i = 0; i < lines.length; i++) {
    out += lines[i] + '\x1b[K'
    if (i < lines.length - 1) out += '\r\n'
  }
  out += '\x1b[J'
  t.term.write(out, () => {
    if (wasScrolledUp && vp && savedTop >= 0) {
      vp.scrollTop = savedTop
    }
  })
}

export function writeStream(id: string, data: string) {
  const t = terminals.get(id) || create(id)
  if (!t.opened) return
  t.term.write(data)
  const buf = t.term.buffer.active
  if (buf.viewportY >= buf.baseY) t.term.scrollToBottom()
}

export function show(id: string) {
  terminals.forEach((t, k) => {
    t.el.style.display = k === id ? '' : 'none'
  })
  const t = terminals.get(id)
  if (t?.opened) {
    requestAnimationFrame(() => {
      try { t.fitAddon.fit() } catch {}
    })
  }
}

export function resize(id: string): { cols: number; rows: number } | null {
  const t = terminals.get(id)
  if (!t?.opened) return null
  try {
    t.fitAddon.fit()
    return { cols: t.term.cols, rows: t.term.rows }
  } catch {
    return null
  }
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
}
