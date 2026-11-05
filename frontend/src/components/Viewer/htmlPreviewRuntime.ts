// Runs INSIDE the sandboxed HTML preview iframe (opaque origin). It is
// injected as source text via `previewRuntime.toString()`, so it must stay
// self-contained: no imports, no references to module scope.
//
// Every source element carries `data-ab-i="<ordinal>"` (its position among the
// file's start tags). Text edits are reported as {ordinal, before, after}; the
// parent maps them onto the exact source range and answers with patches that
// keep the ordinals in step, so editing never reloads the page or resets the
// slide the user is on.

export type PreviewScroll = [number, string, number, number]
export interface PreviewRestore { x: number; y: number; hash: string; scrolls: PreviewScroll[] }
export interface PreviewConfig { token: string; edit: boolean; restore?: PreviewRestore | null }
export interface PreviewPatch { kind: 'inner' | 'after' | 'remove'; i: number; html?: string; from: number; delta: number }
type Host = { send: (message: Record<string, unknown>) => void; listen: (handler: (message: Record<string, unknown>) => void) => void }

export function previewRuntime(cfg: PreviewConfig, host?: Host) {
  const w = window, d = document
  const ATTR = 'data-ab-i', HOVER = 'data-ab-hover', EDITING = 'data-ab-editing'
  const XHTML = 'http://www.w3.org/1999/xhtml'
  const DENY = new Set(['html', 'head', 'body', 'script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'video', 'audio', 'canvas', 'select', 'option', 'textarea', 'input', 'pre', 'title', 'br', 'hr', 'img'])
  // Capture the channel before page scripts run; they could replace it later.
  const parentWin = w.parent
  const post = parentWin.postMessage.bind(parentWin)
  const send = host ? host.send : (message: Record<string, unknown>) => post({...message, __ab: cfg.token}, '*')
  try { d.currentScript?.remove() } catch { /* already detached */ }
  if (cfg.restore?.hash && location.hash !== cfg.restore.hash) {
    try { location.hash = cfg.restore.hash } catch { /* srcdoc navigation blocked */ }
  }

  let edit = cfg.edit
  let current: HTMLElement | null = null
  let currentI = -1, before = '', original = '', fresh = false
  let pending: { i: number; el: HTMLElement; x: number; y: number } | null = null
  let queued: { el: HTMLElement; x: number; y: number } | null = null
  let busy = false
  let hover: Element | null = null
  let ui: { host: HTMLElement; bar: HTMLElement; note: HTMLElement } | null = null
  let noteTimer = 0, viewTimer = 0, userMoved = false

  const ordinal = (el: Element) => Number(el.getAttribute(ATTR))
  const find = (i: number) => {
    const all = d.querySelectorAll(`[${ATTR}="${i}"]`)
    return all.length === 1 ? all[0] as HTMLElement : null
  }
  const serialize = (el: Element) => {
    const copy = el.cloneNode(true) as Element
    for (const node of Array.from(copy.querySelectorAll(`[${ATTR}],[${HOVER}],[${EDITING}]`))) {
      node.removeAttribute(ATTR); node.removeAttribute(HOVER); node.removeAttribute(EDITING)
    }
    return copy.innerHTML
  }
  const inline = (el: Element) => /^(inline|contents)/.test(getComputedStyle(el).display)
  // The nearest block that holds text directly: a heading, paragraph, list
  // item or cell — never a container of other blocks such as a whole slide.
  const candidate = (target: EventTarget | null): HTMLElement | null => {
    let el = target instanceof Element ? target : target instanceof Node ? target.parentElement : null
    while (el && el.parentElement && el !== d.body && inline(el) && el.parentElement !== d.body) el = el.parentElement
    if (!(el instanceof HTMLElement) || el.namespaceURI !== XHTML || el === d.body || DENY.has(el.localName) || !el.hasAttribute(ATTR)) return null
    if (el.closest('svg,math,pre') || !el.textContent?.trim()) return null
    const directText = Array.from(el.childNodes).some(node => node.nodeType === 3 && node.textContent?.trim())
    if (!directText && Array.from(el.children).some(child => !inline(child))) return null
    return el
  }

  const css = `[${HOVER}]{outline:2px dashed rgba(37,99,235,.85)!important;outline-offset:2px!important;cursor:text!important}
[${EDITING}]{outline:2px solid #2563eb!important;outline-offset:2px!important;cursor:text!important}
[${EDITING}],[${EDITING}] *{-webkit-user-select:text!important;user-select:text!important}`
  const installStyle = () => {
    try {
      const sheet = new CSSStyleSheet()
      sheet.replaceSync(css)
      d.adoptedStyleSheets = [...d.adoptedStyleSheets, sheet]
    } catch {
      const style = d.createElement('style')
      style.textContent = css
      ;(d.head || d.documentElement).appendChild(style)
    }
  }
  const ensureUi = () => {
    if (ui) {
      if (!ui.host.isConnected) d.documentElement.appendChild(ui.host)
      return ui
    }
    const hostEl = d.createElement('agentboard-preview-editor')
    hostEl.setAttribute('style', 'all:initial!important;position:fixed!important;left:0!important;top:0!important;z-index:2147483647!important')
    const root = hostEl.attachShadow({mode: 'closed'})
    const mac = /Mac|iPhone|iPad/.test(navigator.platform)
    root.innerHTML = `<style>
.bar{position:fixed;display:none;gap:2px;align-items:center;padding:4px;border-radius:8px;background:#111827;color:#f9fafb;font:12px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.28);white-space:nowrap}
.bar.on{display:flex}
button{all:unset;cursor:pointer;padding:5px 8px;border-radius:5px;color:inherit}
button:hover,button:focus-visible{background:rgba(255,255,255,.16)}
.primary{background:#2563eb}
.primary:hover{background:#1d4ed8}
.hint{opacity:.65;padding:0 6px}
.note{position:fixed;display:none;max-width:320px;padding:7px 10px;border-radius:8px;background:#7f1d1d;color:#fff;font:12px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.28)}
.note.on{display:block}
</style><div class="bar" role="toolbar" aria-label="텍스트 편집"><button class="primary" data-act="commit" title="Enter">저장</button><button data-act="add" title="${mac ? '⌘' : 'Ctrl'}+Enter">＋ 아래에 추가</button><button data-act="delete">삭제</button><button data-act="cancel" title="이번 수정을 버립니다">취소</button><span class="hint">Enter 저장 · Shift+Enter 줄바꿈 · Esc 닫기</span></div><div class="note" role="status"></div>`
    const bar = root.querySelector('.bar') as HTMLElement, note = root.querySelector('.note') as HTMLElement
    // Keep focus (and the caret) in the text while a toolbar button is pressed.
    bar.addEventListener('mousedown', event => event.preventDefault())
    bar.addEventListener('click', event => {
      const act = (event.target as Element).closest('button')?.getAttribute('data-act')
      if (act === 'commit' || act === 'add' || act === 'delete' || act === 'cancel') finish(act)
    })
    d.documentElement.appendChild(hostEl)
    ui = {host: hostEl, bar, note}
    return ui
  }
  const place = (box: HTMLElement, el: Element) => {
    const r = el.getBoundingClientRect(), b = box.getBoundingClientRect()
    let top = r.top - b.height - 8
    if (top < 4) top = Math.min(r.bottom + 8, w.innerHeight - b.height - 4)
    box.style.top = `${Math.max(4, top)}px`
    box.style.left = `${Math.max(4, Math.min(r.left, w.innerWidth - b.width - 4))}px`
  }
  const placeBar = () => { if (current && ui) place(ui.bar, current) }
  const note = (el: Element, text: string) => {
    const box = ensureUi().note
    box.textContent = text
    box.classList.add('on')
    place(box, el)
    w.clearTimeout(noteTimer)
    noteTimer = w.setTimeout(() => box.classList.remove('on'), 3500)
  }
  const setHover = (el: Element | null) => {
    if (hover === el) return
    hover?.removeAttribute(HOVER)
    hover = el
    el?.setAttribute(HOVER, '')
  }

  const startEditing = (el: HTMLElement, at: { x?: number; y?: number; selectAll?: boolean; fresh?: boolean }) => {
    setHover(null)
    current = el; currentI = ordinal(el); fresh = !!at.fresh
    before = serialize(el); original = el.innerHTML
    el.setAttribute(EDITING, '')
    el.setAttribute('contenteditable', 'plaintext-only')
    // Browsers without plaintext-only ignore the value; fall back to rich editing.
    if (el.isContentEditable === false) el.setAttribute('contenteditable', 'true')
    el.focus({preventScroll: true})
    const selection = w.getSelection()
    if (selection) {
      let range: Range | null = null
      if (!at.selectAll && at.x !== undefined && at.y !== undefined) {
        const doc = d as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null; caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null }
        if (doc.caretRangeFromPoint) range = doc.caretRangeFromPoint(at.x, at.y)
        else if (doc.caretPositionFromPoint) {
          const point = doc.caretPositionFromPoint(at.x, at.y)
          if (point) { range = d.createRange(); range.setStart(point.offsetNode, point.offset) }
        }
        if (range && !el.contains(range.startContainer)) range = null
      }
      if (!range) { range = d.createRange(); range.selectNodeContents(el); if (!at.selectAll) range.collapse(false) }
      selection.removeAllRanges(); selection.addRange(range)
    }
    ensureUi().bar.classList.add('on')
    placeBar()
  }
  const clean = (html: string) => {
    // Editing inserts &nbsp; for typed trailing/double spaces and a stray <br>
    // in emptied blocks; neither belongs in the source unless it was there.
    if (!before.includes('&nbsp;')) html = html.replace(/&nbsp;/g, ' ')
    if (!/<br>\s*$/.test(before)) html = html.replace(/(<br>)+$/, '')
    return html
  }
  const operate = (message: Record<string, unknown>) => { busy = true; send(message) }
  const finish = (kind: 'commit' | 'add' | 'delete' | 'cancel') => {
    const el = current
    if (!el) return
    current = null
    el.removeAttribute('contenteditable'); el.removeAttribute(EDITING)
    ui?.bar.classList.remove('on')
    w.getSelection()?.removeAllRanges()
    const base = {i: currentI, tag: el.localName, before}
    if (kind === 'cancel') {
      el.innerHTML = original
      if (fresh) operate({...base, t: 'delete'})
      else send({t: 'end'})
      return
    }
    if (kind === 'delete') return operate({...base, t: 'delete'})
    const after = clean(serialize(el))
    if (fresh && kind === 'commit' && (!el.textContent?.trim() || after === before)) return operate({...base, t: 'delete'})
    if (after === before) {
      if (kind === 'add') return operate({...base, t: 'add'})
      return send({t: 'end'})
    }
    operate({...base, t: 'commit', after, add: kind === 'add'})
  }
  const request = (el: HTMLElement, x: number, y: number) => {
    if (busy || pending) { queued = {el, x, y}; return }
    const i = ordinal(el)
    if (find(i) !== el) {
      note(el, '페이지 스크립트가 복제한 내용이라 미리보기에서 고칠 수 없습니다. HTML 소스에서 수정하세요.')
      return
    }
    pending = {i, el, x, y}
    send({t: 'begin', i, tag: el.localName, before: serialize(el)})
  }
  const nextQueued = () => {
    const next = queued
    queued = null
    if (next && edit && !current && next.el.isConnected) request(next.el, next.x, next.y)
  }
  const lineBreak = () => {
    const selection = w.getSelection()
    if (!selection?.rangeCount) return
    const range = selection.getRangeAt(0)
    range.deleteContents()
    const br = d.createElement('br')
    range.insertNode(br)
    range.setStartAfter(br); range.collapse(true)
    selection.removeAllRanges(); selection.addRange(range)
  }
  const shift = (from: number, delta: number) => {
    if (!delta) return
    for (const node of Array.from(d.querySelectorAll(`[${ATTR}]`))) {
      const k = ordinal(node)
      if (k >= from) node.setAttribute(ATTR, String(k + delta))
    }
  }
  const applyPatches = (patches: PreviewPatch[]) => {
    for (const patch of patches) {
      const el = find(patch.i)
      if (!el) throw Error('missing element')
      if (patch.kind === 'remove') { el.remove(); shift(patch.from, patch.delta); continue }
      shift(patch.from, patch.delta)
      if (patch.kind === 'inner') el.innerHTML = patch.html || ''
      else el.insertAdjacentHTML('afterend', patch.html || '')
    }
  }

  const handle = (message: Record<string, unknown>) => {
    const i = typeof message.i === 'number' ? message.i : -1
    if (message.t === 'mode') {
      edit = message.edit === true
      if (!edit && current) finish('commit')
      setHover(null)
    } else if (message.t === 'begin-ok') {
      const target = pending
      pending = null
      if (target && target.i === i && target.el.isConnected && edit && !current) startEditing(target.el, target)
      else send({t: 'end'})
    } else if (message.t === 'begin-deny') {
      const target = pending
      pending = null
      if (target && target.i === i && typeof message.reason === 'string') note(target.el, message.reason)
      nextQueued()
    } else if (message.t === 'patch') {
      try { applyPatches(Array.isArray(message.patches) ? message.patches as PreviewPatch[] : []) } catch { busy = false; send({t: 'resync'}); return }
      busy = false
      if (typeof message.focus !== 'number') return nextQueued()
      const focus = find(message.focus)
      if (focus && edit && !current) return startEditing(focus, {selectAll: true, fresh: true})
      send({t: 'end'})
      nextQueued()
    } else if (message.t === 'ack') {
      busy = false
      nextQueued()
    }
  }
  if (host) host.listen(handle)
  else w.addEventListener('message', event => {
    const message = event.data
    if (event.source === parentWin && message && typeof message === 'object' && message.__ab === cfg.token) handle(message)
  })

  // ── Edit mode: page handlers never see clicks; typing never reaches them ──
  const fromUi = (event: Event) => !!ui && event.target === ui.host
  const swallow = (event: Event) => { if (edit && !fromUi(event)) event.stopPropagation() }
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'dblclick', 'auxclick']) {
    w.addEventListener(type, swallow, {capture: true})
  }
  w.addEventListener('click', event => {
    if (!edit || fromUi(event)) return
    event.stopPropagation()
    const target = event.target as Node
    if (current && current.contains(target)) {
      if ((target instanceof Element ? target : target.parentElement)?.closest('a')) event.preventDefault()
      return
    }
    event.preventDefault()
    const el = candidate(target)
    if (current) finish('commit')
    if (el) request(el, event.clientX, event.clientY)
  }, {capture: true})
  w.addEventListener('mouseover', event => {
    if (!edit || current || fromUi(event)) return setHover(null)
    setHover(candidate(event.target))
  }, {capture: true})
  d.documentElement.addEventListener('mouseleave', () => setHover(null))
  d.addEventListener('focusout', event => { if (current && event.target === current) finish('commit') }, true)
  w.addEventListener('keydown', event => {
    const key = event.key.toLowerCase(), mod = event.ctrlKey || event.metaKey
    if (current) {
      event.stopImmediatePropagation()
      if (event.isComposing || event.keyCode === 229) return
      // Every way out keeps the text (like the Markdown editor); only 취소 drops it.
      if (key === 'escape') { event.preventDefault(); finish('commit') }
      else if (key === 'enter') { event.preventDefault(); if (event.shiftKey) lineBreak(); else finish(mod ? 'add' : 'commit') }
      else if (mod && key === 's') { event.preventDefault(); finish('commit') }
      return
    }
    if (!edit || !mod || event.altKey) return
    if (key === 'z' && !event.shiftKey) { event.preventDefault(); event.stopImmediatePropagation(); send({t: 'undo'}) }
    else if (key === 's') { event.preventDefault(); event.stopImmediatePropagation() }
  }, {capture: true})
  for (const type of ['keyup', 'keypress', 'beforeinput', 'input', 'compositionstart', 'compositionupdate', 'compositionend']) {
    w.addEventListener(type, event => { if (current) { event.stopImmediatePropagation(); if (type === 'input') placeBar() } }, {capture: true})
  }
  w.addEventListener('paste', event => {
    if (!current) return
    event.preventDefault(); event.stopImmediatePropagation()
    const text = event.clipboardData?.getData('text/plain') || ''
    d.execCommand('insertText', false, text.replace(/\s*[\r\n]+\s*/g, ' '))
  }, {capture: true})
  w.addEventListener('drop', event => { if (current) { event.preventDefault(); event.stopImmediatePropagation() } }, {capture: true})
  w.addEventListener('resize', placeBar)

  // ── Keep the reader's place across reloads ──
  const scrolls = new Map<number, PreviewScroll>()
  for (const entry of cfg.restore?.scrolls || []) scrolls.set(entry[0], entry)
  const report = () => {
    viewTimer = 0
    send({t: 'view', x: w.scrollX, y: w.scrollY, hash: location.hash, scrolls: Array.from(scrolls.values()).slice(-20)})
  }
  const queueReport = () => { if (!viewTimer) viewTimer = w.setTimeout(report, 200) }
  w.addEventListener('scroll', event => {
    const target = event.target
    if (target instanceof Element && target.hasAttribute(ATTR)) {
      const k = ordinal(target)
      scrolls.delete(k)
      scrolls.set(k, [k, target.localName, target.scrollTop, target.scrollLeft])
    }
    queueReport()
    placeBar()
  }, {capture: true, passive: true})
  w.addEventListener('hashchange', queueReport)
  const restore = cfg.restore
  if (restore) {
    for (const type of ['wheel', 'keydown', 'pointerdown', 'touchstart']) {
      w.addEventListener(type, () => { userMoved = true }, {capture: true, passive: true, once: true})
    }
    const apply = () => {
      if (userMoved) return
      try { w.scrollTo({left: restore.x, top: restore.y, behavior: 'instant' as ScrollBehavior}) } catch { w.scrollTo(restore.x, restore.y) }
      for (const [k, tag, top, left] of restore.scrolls) {
        const el = find(k)
        if (el && el.localName === tag) { el.scrollTop = top; el.scrollLeft = left }
      }
    }
    d.addEventListener('DOMContentLoaded', apply)
    w.addEventListener('load', () => { apply(); w.setTimeout(apply, 150) })
  }
  const ready = () => { installStyle(); ensureUi() }
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', ready)
  else ready()
}
