import { useEffect, useRef, useState, useCallback, useLayoutEffect, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react'
import { acquirePdf, peekPdf } from './pdfCache'
import type { PDFPageProxy } from 'pdfjs-dist'
import { offsetIn, pageText, rangeRects, readText, renderTextLayer, textContentOf, type Rect } from './pdfText'
import { CONTEXT, chatMessage, inOrder, locateQuote, newMemoId, onItsPage, roundRects, sameRects, usePdfMemos, type PdfMemo, type Place } from './pdfMemos'
import { MemoChatButton } from './Viewer/memoChat'
import { useStore, viewerKey } from '../store'

interface PdfPosition { page: number; zoom: number; pageOffset: number; pdfScrollLeft: number }
/** `path`: the file on this server; memos need it (a file browser preview has none). */
interface Props { url: string; path?: string; viewState?: Partial<PdfPosition>; onViewChange?: (view: PdfPosition) => void; reloadSignal?: number }
const ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3]
const SIDE_KEY = 'agentboard.pdf.memoList'
type PageEvents = Pick<HTMLAttributes<HTMLDivElement>, 'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel' | 'onClick'>

// Only paint pages near the viewport; the sized placeholders make slider jumps
// possible immediately, without allocating a canvas for the entire document.
// The text goes over the picture so it can be selected; `marks` go between them.
function PdfPage({ page, width, zoom, root, onText, marks, events, children }: {
  page: PDFPageProxy; width: number; zoom: number; root: React.RefObject<HTMLDivElement | null>
  onText?: (page: number, layer: HTMLElement | null) => void; marks?: ReactNode; events?: PageEvents; children?: ReactNode
}) {
  const element = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const layer = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const base = page.getViewport({scale: 1})
  const cssWidth = Math.max(100, width - 24) * zoom
  const cssHeight = cssWidth * base.height / base.width
  const scale = cssWidth / base.width
  const report = useRef(onText); report.current = onText
  useEffect(() => {
    const observer = new IntersectionObserver(entries => setVisible(entries.some(e => e.isIntersecting)), {root: root.current, rootMargin: '700px'})
    if (element.current) observer.observe(element.current)
    return () => observer.disconnect()
  }, [page, root])
  useEffect(() => {
    const node = canvas.current
    if (!visible || !node) return
    const viewport = page.getViewport({scale: scale * (window.devicePixelRatio || 1)})
    node.width = Math.ceil(viewport.width); node.height = Math.ceil(viewport.height)
    const task = page.render({canvasContext: node.getContext('2d')!, viewport})
    task.promise.catch(() => {}) // cancelled when zooming, switching file, or leaving viewport
    return () => { task.cancel() }
  }, [page, visible, scale])
  useEffect(() => {
    const node = layer.current
    if (!visible || !node) return
    const task = renderTextLayer(page, node, page.getViewport({scale}))
    task.done.then(ok => { if (ok) report.current?.(page.pageNumber, node) }, () => {})
    return () => { task.cancel(); report.current?.(page.pageNumber, null) }
  }, [page, visible, scale])
  return <div ref={element} className="pdf-page" data-page={page.pageNumber} {...events}
    style={{width: cssWidth, height: cssHeight, '--scale-factor': String(scale)} as CSSProperties}>
    {visible && <canvas ref={canvas} aria-label={`PDF ${page.pageNumber}페이지`} style={{width: cssWidth, height: cssHeight}} />}
    {marks}
    {visible && <div ref={layer} className="textLayer" />}
    {children}
  </div>
}

const percent = (v: number) => `${v * 100}%`
const box = (r: Rect): CSSProperties => ({left: percent(r[0]), top: percent(r[1]), width: percent(r[2]), height: percent(r[3])})
const clamp = (v: number) => Math.max(0, Math.min(1, v))
const pointIn = (e: {clientX: number; clientY: number}, el: Element): [number, number] => {
  const r = el.getBoundingClientRect()
  return [clamp((e.clientX - r.left) / r.width), clamp((e.clientY - r.top) / r.height)]
}
const spanOf = (from: {x: number; y: number}, [x, y]: [number, number]): Rect => [Math.min(from.x, x), Math.min(from.y, y), Math.abs(x - from.x), Math.abs(y - from.y)]
const readSide = () => { try { const v = localStorage.getItem(SIDE_KEY); return v === null ? null : v === '1' } catch { return null } }
/** Text selected on a page, before it becomes a memo. */
interface Picked { page: number; start: number; quote: string; prefix: string; suffix: string; rects: Rect[] }

/** Writes a memo where it is on the page; every keystroke shows and saves. */
function MemoEditor({ memo, label, onText, onDelete, onClose }: { memo: PdfMemo; label: string; onText: (text: string) => void; onDelete: () => void; onClose: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { ref.current?.focus({preventScroll: true}) }, [memo.id])
  const last = memo.rects[memo.rects.length - 1] || [0, 0, 0, 0]
  return <div className="pdf-memo-editor" style={{left: `max(0px, min(${percent(last[0])}, calc(100% - 268px)))`, top: `calc(${percent(last[1] + last[3])} + 6px)`}}
    onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
    <textarea ref={ref} value={memo.text} rows={3} placeholder={memo.kind === 'area' ? '이 영역에 대한 메모' : '이 문장에 대한 메모'}
      onChange={e => onText(e.target.value)}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing)) { e.preventDefault(); onClose() }
      }} />
    <div className="pdf-memo-editor-bar"><span>{label} · 적는 대로 저장됩니다</span><button onClick={onDelete}>삭제</button><button onClick={onClose}>닫기</button></div>
  </div>
}

export function PdfViewer({ url, path, viewState, onViewChange, reloadSignal = 0 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState(() => peekPdf(url) ? '' : 'PDF 불러오는 중…')
  const [error, setError] = useState('')
  const [pages, setPages] = useState<PDFPageProxy[]>(() => peekPdf(url)?.pages || [])
  const [zoom, setZoom] = useState(viewState?.zoom || 1)
  const [currentPage, setCurrentPage] = useState(viewState?.page || 1)
  const currentRef = useRef(viewState?.page || 1)
  const offsetRef = useRef(viewState?.pageOffset || 0)
  const leftRef = useRef(viewState?.pdfScrollLeft || 0)
  const restoring = useRef(true)
  const [width, setWidth] = useState(0)
  const [reloadKey, setReloadKey] = useState(0)
  // The file changed on disk (a recompiled PDF): reload, keeping the page.
  useEffect(() => { if (reloadSignal) setReloadKey(k => k + 1) }, [reloadSignal])
  const viewChange = useRef(onViewChange); viewChange.current = onViewChange
  useEffect(() => {
    let cancelled = false
    const lease = acquirePdf(url, reloadKey > 0)
    const cached = reloadKey ? undefined : peekPdf(url)
    restoring.current = !cached
    setPages(cached?.pages || []); setError(''); setStatus(cached ? '' : 'PDF 불러오는 중…')
    lease.ready.then(result => {
      if (cancelled) return
      currentRef.current = Math.max(1, Math.min(result.pages.length, currentRef.current))
      setCurrentPage(currentRef.current)
      setPages(result.pages); setStatus('')
    }).catch(error => {
      if (!cancelled) { setError(error instanceof Error ? error.message : String(error)); setStatus('') }
    })
    return () => { cancelled = true; lease.release() }
  }, [url, reloadKey])

  useLayoutEffect(() => {
    const node = containerRef.current
    if (!node) return
    const observer = new ResizeObserver(() => setWidth(node.clientWidth))
    observer.observe(node); setWidth(node.clientWidth)
    return () => observer.disconnect()
  }, [])

  const remember = useCallback(() => {
    viewChange.current?.({page: currentRef.current, zoom, pageOffset: offsetRef.current, pdfScrollLeft: leftRef.current})
  }, [zoom])

  const goToPage = useCallback((value: number) => {
    const page = Math.max(1, Math.min(pages.length, value))
    const container = containerRef.current
    const target = container?.querySelector<HTMLElement>(`[data-page="${page}"]`)
    if (!target || !container) return
    offsetRef.current = 0
    container.scrollTop = target.offsetTop
    currentRef.current = page; setCurrentPage(page)
    remember()
  }, [pages.length, remember])

  // Restore an anchor inside the page, not just the page's top edge. The ratio
  // remains valid after zoom, column resizing and switching workspaces.
  useLayoutEffect(() => {
    if (!pages.length || !width) return
    const container = containerRef.current
    const target = container?.querySelector<HTMLElement>(`[data-page="${currentRef.current}"]`)
    if (container && target) {
      container.scrollTop = target.offsetTop + offsetRef.current * target.offsetHeight
      container.scrollLeft = leftRef.current
    }
    restoring.current = false
    remember()
  }, [pages, zoom, width, remember])

  const onScroll = () => {
    const container = containerRef.current
    if (!container || !pages.length || restoring.current) return
    const nodes = [...container.querySelectorAll<HTMLElement>('[data-page]')]
    const target = [...nodes].reverse().find(node => node.offsetTop <= container.scrollTop + 1) || nodes[0]
    if (target) {
      const page = Number(target.dataset.page)
      currentRef.current = page; setCurrentPage(page)
      offsetRef.current = Math.max(0, (container.scrollTop - target.offsetTop) / target.offsetHeight)
      leftRef.current = container.scrollLeft
      remember()
    }
  }

  // ── Memos ──
  const ownerKey = useStore(viewerKey)
  const { memos, change } = usePdfMemos(path)
  const memoOn = !!change
  const memosRef = useRef(memos); memosRef.current = memos
  const [open, setOpen] = useState<string | null>(null)
  const [picked, setPicked] = useState<Picked | null>(null)
  const pressingPick = useRef(false)
  const [tool, setTool] = useState<'select' | 'area'>('select')
  const [draft, setDraft] = useState<{page: number; rect: Rect} | null>(null)
  const drawFrom = useRef<{page: number; x: number; y: number} | null>(null)
  const [side, setSide] = useState<boolean | null>(readSide)
  const layers = useRef(new Map<number, HTMLElement>())
  const [layerTick, setLayerTick] = useState(0)
  const onText = useCallback((page: number, layer: HTMLElement | null) => {
    if (layer) layers.current.set(page, layer); else layers.current.delete(page)
    if (memosRef.current.some(m => m.kind === 'text')) setLayerTick(t => t + 1)
  }, [])

  // Where each passage is in this PDF. A recompiled PDF moves them, or drops
  // the words altogether (then the memo is listed as not found, maybe fixed).
  const [places, setPlaces] = useState<{pages: PDFPageProxy[]; at: Map<string, Place | null>}>({pages: [], at: new Map()})
  const anchors = memos.filter(m => m.kind === 'text').map(m => `${m.id}:${m.page}:${m.start}`).join('|')
  useEffect(() => {
    if (!pages.length || !anchors) return
    let cancelled = false
    const texts = new Map<number, Promise<string>>()
    const textOf = (n: number) => {
      let text = texts.get(n)
      if (!text) { text = textContentOf(pages[n - 1]).then(pageText); texts.set(n, text) }
      return text
    }
    void (async () => {
      const at = new Map<string, Place | null>(), missing: PdfMemo[] = []
      for (const m of memosRef.current) {
        if (m.kind !== 'text') continue
        const here = m.page <= pages.length ? onItsPage(await textOf(m.page), m) : null
        if (here) at.set(m.id, here); else missing.push(m)
      }
      if (missing.length) {
        const all = await Promise.all(pages.map((_, i) => textOf(i + 1)))
        for (const m of missing) at.set(m.id, locateQuote(m, all))
      }
      if (!cancelled) setPlaces({pages, at})
    })().catch(() => {})
    return () => { cancelled = true }
  }, [pages, anchors])
  const at = places.pages === pages ? places.at : undefined

  // Measure each passage on its page's text once that is shown: a new PDF puts
  // the same words somewhere else, and the memo follows (and is saved there).
  useEffect(() => {
    if (!change || !at) return
    const updates = new Map<string, Partial<PdfMemo>>()
    for (const m of memosRef.current) {
      const place = at.get(m.id)
      const layer = place && layers.current.get(place.page)
      const page = layer?.isConnected ? layer.closest('.pdf-page') : null
      if (!place || !layer || !page) continue
      const rects = roundRects(rangeRects(layer, place.start, place.end, page.getBoundingClientRect()))
      if (!rects.length) continue
      if (place.page !== m.page || place.start !== m.start) {
        // Moved: remember the words around it there, so the next load finds it on its page.
        const text = layer.textContent || ''
        updates.set(m.id, {page: place.page, start: place.start, rects, prefix: text.slice(Math.max(0, place.start - CONTEXT), place.start), suffix: text.slice(place.end, place.end + CONTEXT)})
      } else if (!sameRects(rects, m.rects)) updates.set(m.id, {rects})
    }
    if (updates.size) change(list => list.map(m => updates.has(m.id) ? {...m, ...updates.get(m.id)} : m))
  }, [layerTick, at, change])

  const lost = new Set(memos.filter(m => m.kind === 'text' && at?.get(m.id) === null).map(m => m.id))
  const drawn = (m: PdfMemo) => {
    const place = at?.get(m.id)
    return m.kind === 'area' || place === undefined || (!!place && place.page === m.page && place.start === m.start)
  }
  const ordered = [...inOrder(memos.filter(m => !lost.has(m.id))), ...memos.filter(m => lost.has(m.id))]
  // Memos with something written are numbered; a bare highlight isn't.
  const numbers = new Map(ordered.filter(m => m.text.trim()).map((m, i) => [m.id, i + 1]))
  const byPage = new Map<number, PdfMemo[]>()
  for (const m of ordered) if (drawn(m) && !lost.has(m.id)) byPage.set(m.page, [...byPage.get(m.page) || [], m])

  // A selection in a page's text offers 형광펜 / 메모 once the mouse is released
  // (a phone's selection handles change it without one).
  useEffect(() => {
    if (!memoOn) return
    let timer = 0, down = false
    const check = () => {
      if (pressingPick.current) return
      const container = containerRef.current
      const selection = document.getSelection()
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null
      const from = range && (range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement)
      const layer = from?.closest<HTMLElement>('.textLayer')
      const page = layer?.closest<HTMLElement>('.pdf-page')
      if (!range || range.collapsed || !container || !layer || !page || !container.contains(layer)) { setPicked(null); return }
      const text = layer.textContent || ''
      const start = offsetIn(layer, range.startContainer, range.startOffset)
      // A selection that runs on into the next page keeps this page's part.
      const end = layer.contains(range.endContainer) ? offsetIn(layer, range.endContainer, range.endOffset) : text.length
      const quote = end > start ? readText(layer, start, end).trim() : ''
      const rects = quote ? roundRects(rangeRects(layer, start, end, page.getBoundingClientRect())) : []
      if (!rects.length) { setPicked(null); return }
      setPicked({page: Number(page.dataset.page), start, quote, prefix: text.slice(Math.max(0, start - CONTEXT), start), suffix: text.slice(end, end + CONTEXT), rects})
    }
    const soon = () => { window.clearTimeout(timer); if (!down) timer = window.setTimeout(check, 150) }
    const press = () => { down = true }
    const release = () => {
      down = false
      if (pressingPick.current) window.setTimeout(() => { pressingPick.current = false }, 0)
      soon()
    }
    document.addEventListener('selectionchange', soon)
    document.addEventListener('pointerdown', press)
    document.addEventListener('pointerup', release)
    document.addEventListener('pointercancel', release)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('selectionchange', soon)
      document.removeEventListener('pointerdown', press)
      document.removeEventListener('pointerup', release)
      document.removeEventListener('pointercancel', release)
    }
  }, [memoOn])

  const add = (write: boolean) => {
    pressingPick.current = false
    if (!picked || !change) return
    const memo: PdfMemo = {id: newMemoId(), kind: 'text', page: picked.page, rects: picked.rects, text: '', quote: picked.quote,
      prefix: picked.prefix, suffix: picked.suffix, start: picked.start, created: Date.now()}
    change(list => [...list, memo], true)
    document.getSelection()?.removeAllRanges()
    setPicked(null)
    if (write) setOpen(memo.id)
  }
  const write = (id: string, text: string) => change?.(list => list.map(m => m.id === id ? {...m, text} : m))
  const remove = (id: string) => {
    change?.(list => list.filter(m => m.id !== id), true)
    setOpen(current => current === id ? null : current)
  }
  // Closing keeps a passage as a highlight; an area with nothing written goes.
  const close = useCallback((id: string) => {
    setOpen(current => current === id ? null : current)
    const memo = memosRef.current.find(m => m.id === id)
    if (memo?.kind === 'area' && !memo.text.trim()) change?.(list => list.filter(m => m.id !== id), true)
  }, [change])
  useEffect(() => {
    if (!open) return
    const outside = (e: Event) => { if (!(e.target as Element | null)?.closest?.('.pdf-memo-editor')) close(open) }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [open, close])
  useEffect(() => {
    if (tool !== 'area') return
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setTool('select'); setDraft(null); drawFrom.current = null } }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [tool])

  // ▭ draws an area (a figure, an equation, a scanned page); otherwise a click
  // on a highlight or an area opens its memo.
  const pageEvents = (n: number): PageEvents | undefined => {
    if (!change) return undefined
    if (tool === 'area') return {
      onPointerDown: e => {
        if (e.button !== 0 || (e.target as Element).closest('.pdf-memo-editor, .pdf-memo-badge')) return
        e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId)
        const [x, y] = pointIn(e, e.currentTarget)
        drawFrom.current = {page: n, x, y}; setDraft({page: n, rect: [x, y, 0, 0]})
      },
      onPointerMove: e => {
        const from = drawFrom.current
        if (from?.page === n) setDraft({page: n, rect: spanOf(from, pointIn(e, e.currentTarget))})
      },
      onPointerUp: e => {
        const from = drawFrom.current
        drawFrom.current = null; setDraft(null)
        if (from?.page !== n) return
        const [rect] = roundRects([spanOf(from, pointIn(e, e.currentTarget))])
        if (rect[2] < 0.01 || rect[3] < 0.006) return
        const memo: PdfMemo = {id: newMemoId(), kind: 'area', page: n, rects: [rect], text: '', created: Date.now()}
        change(list => [...list, memo], true)
        setTool('select'); setOpen(memo.id)
      },
      onPointerCancel: () => { drawFrom.current = null; setDraft(null) },
    }
    return {
      onClick: e => {
        if ((e.target as Element).closest('.pdf-memo-editor, .pdf-pick, .pdf-memo-badge') || !document.getSelection()?.isCollapsed) return
        const [x, y] = pointIn(e, e.currentTarget), pad = 0.003
        const hit = [...byPage.get(n) || []].reverse().find(m => m.rects.some(r => x >= r[0] - pad && x <= r[0] + r[2] + pad && y >= r[1] - pad && y <= r[1] + r[3] + pad))
        if (hit) setOpen(hit.id)
      },
    }
  }

  const reveal = (m: PdfMemo) => {
    const container = containerRef.current
    const page = container?.querySelector<HTMLElement>(`[data-page="${m.page}"]`)
    if (!container || !page || lost.has(m.id)) return
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    container.scrollTo({top: page.offsetTop + (m.rects[0]?.[1] ?? 0) * page.offsetHeight - container.clientHeight / 3, behavior: still ? 'auto' : 'smooth'})
    setOpen(m.id)
  }
  const showSide = memoOn && (side ?? memos.length > 0)
  const toggleSide = () => {
    setSide(!showSide)
    try { localStorage.setItem(SIDE_KEY, showSide ? '0' : '1') } catch {}
  }
  const label = (m: PdfMemo) => numbers.has(m.id) ? `메모 ${numbers.get(m.id)}` : '새 메모'

  return <div className="pdf-container" data-pdf-url={url}>
    {status && <div className="fp-loading" style={{padding:30}}><div className="spinner" /><span>{status}</span></div>}
    {error && <div className="fv-pdf-fallback"><p>{error}</p><button className="btn" onClick={()=>setReloadKey(k=>k+1)}>다시 불러오기</button><a href={url} target="_blank" rel="noopener" className="fv-download">다운로드</a></div>}
    {pages.length > 0 && <div className="pdf-toolbar">
      <button className="pdf-zoom-btn" onClick={() => goToPage(currentPage-1)} disabled={currentPage===1} title="이전 페이지">‹</button>
      <output className="pdf-page-info" aria-live="polite">{currentPage} / {pages.length} 페이지</output>
      <button className="pdf-zoom-btn" onClick={() => goToPage(currentPage+1)} disabled={currentPage===pages.length} title="다음 페이지">›</button>
      <button className="pdf-zoom-btn" onClick={()=>setZoom(z=>[...ZOOM_LEVELS].reverse().find(v=>v<z) || z)} title="Zoom out">−</button>
      <button className="pdf-zoom-label" onClick={()=>setZoom(1)} title="Fit width">{Math.round(zoom*100)}%</button>
      <button className="pdf-zoom-btn" onClick={()=>setZoom(z=>ZOOM_LEVELS.find(v=>v>z) || z)} title="Zoom in">+</button>
      <button className="pdf-zoom-btn" onClick={()=>setReloadKey(k=>k+1)} title="새로고침 (페이지 유지)">↻</button>
      {memoOn && <>
        <button className={`pdf-zoom-btn${tool === 'area' ? ' on' : ''}`} aria-pressed={tool === 'area'} onClick={() => { setTool(t => t === 'area' ? 'select' : 'area'); setDraft(null) }}
          title="영역 메모: 그림이나 수식 위에 네모를 그려 메모합니다">▭</button>
        <button className={`pdf-memo-toggle${showSide ? ' on' : ''}`} onClick={toggleSide} title="메모 목록">메모 {memos.length}</button>
        {tool === 'area' && <span className="pdf-tool-hint">메모할 곳에 네모를 그리세요 · Esc 취소</span>}
      </>}
    </div>}
    <div className="pdf-reading-area">
    <div ref={containerRef} className={`pdf-pages${tool === 'area' ? ' drawing' : ''}`} onScroll={onScroll}>
      {pages.map(page => {
        const n = page.pageNumber, here = byPage.get(n) || []
        const editing = here.find(m => m.id === open)
        return <PdfPage key={`${reloadKey}:${url}:${n}`} page={page} width={width} zoom={zoom} root={containerRef} onText={onText} events={pageEvents(n)}
          marks={here.length > 0 || draft?.page === n ? <div className="pdf-marks">
            {here.map(m => m.rects.map((r, i) => <div key={`${m.id}:${i}`} className={`pdf-mark pdf-mark-${m.kind}${open === m.id ? ' active' : ''}`} style={box(r)} />))}
            {draft?.page === n && <div className="pdf-mark pdf-mark-area drawing" style={box(draft.rect)} />}
          </div> : null}>
          {here.map(m => {
            const number = numbers.get(m.id), r = m.rects[0]
            return number && r ? <button key={m.id} className="pdf-memo-badge" data-text={m.text} aria-label={`메모 ${number}: ${m.text}`}
              style={{left: percent(Math.min(r[0] + r[2], 0.985)), top: percent(r[1])}} onClick={e => { e.stopPropagation(); setOpen(m.id) }}>{number}</button> : null
          })}
          {picked?.page === n && (() => {
            const r = picked.rects[picked.rects.length - 1]
            return <div className="pdf-pick" style={{left: `max(0px, min(calc(${percent(r[0] + r[2])} - 64px), calc(100% - 132px)))`, top: `calc(${percent(r[1] + r[3])} + 4px)`}}
              onPointerDown={e => { e.preventDefault(); e.stopPropagation(); pressingPick.current = true }} onClick={e => e.stopPropagation()}>
              <button onClick={() => add(false)}>형광펜</button>
              <button onClick={() => add(true)}>메모</button>
            </div>
          })()}
          {editing && <MemoEditor memo={editing} label={label(editing)} onText={text => write(editing.id, text)} onDelete={() => remove(editing.id)} onClose={() => close(editing.id)} />}
        </PdfPage>
      })}
    </div>
    {showSide && <aside className="pdf-memo-side" aria-label="PDF 메모">
      <div className="pdf-memo-side-head"><b>메모 {memos.length}</b><button onClick={toggleSide} title="메모 목록 닫기" aria-label="메모 목록 닫기">×</button></div>
      {numbers.size > 0 && path && <div className="pdf-memo-chat"><MemoChatButton ownerKey={ownerKey} count={numbers.size} compose={() => chatMessage(path, ordered, lost)} /></div>}
      {!memos.length && <p className="pdf-memo-hint">글을 드래그해 고르면 형광펜이나 메모를 달 수 있습니다. 그림이나 수식은 ▭ 를 누르고 네모를 그리세요.</p>}
      <ol className="pdf-memo-cards">
        {ordered.map(m => {
          const number = numbers.get(m.id), gone = lost.has(m.id)
          return <li key={m.id} className={`pdf-memo-card${open === m.id ? ' active' : ''}${gone ? ' lost' : ''}`} onClick={() => reveal(m)}>
            <div className="pdf-memo-card-head">
              {number ? <span className="pdf-memo-num">{number}</span> : <span className="pdf-memo-chip">형광펜</span>}
              <span>p.{m.page}{m.kind === 'area' ? ' · 영역' : ''}</span>
              {gone && <span className="pdf-memo-lost" title="PDF가 바뀌어 이 문장을 찾지 못했습니다. 고쳐졌을 수 있습니다.">찾지 못함</span>}
              <button className="pdf-memo-del" onClick={e => { e.stopPropagation(); remove(m.id) }} title="삭제" aria-label="메모 삭제">×</button>
            </div>
            {m.quote && <q>{m.quote}</q>}
            {m.text.trim() && <p>{m.text}</p>}
          </li>
        })}
      </ol>
    </aside>}
    {pages.length>0 && <div className="vertical-scroll-rail pdf-page-rail"><output>{currentPage}</output>
      <input className="pdf-page-slider vertical-slider" type="range" aria-label="PDF 페이지 이동" aria-orientation="vertical" min={1} max={pages.length} value={currentPage}
        aria-valuetext={`${currentPage} / ${pages.length} 페이지`} onChange={e=>goToPage(Number(e.target.value))} />
      <span>{pages.length}</span>
    </div>}
    </div>
  </div>
}
