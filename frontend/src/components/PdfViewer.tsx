import { useEffect, useRef, useState, useCallback, useLayoutEffect } from 'react'
import { acquirePdf, peekPdf } from './pdfCache'
import type { PDFPageProxy } from 'pdfjs-dist'

interface PdfPosition { page: number; zoom: number; pageOffset: number; pdfScrollLeft: number }
interface Props { url: string; viewState?: Partial<PdfPosition>; onViewChange?: (view: PdfPosition) => void }
const ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3]

// Only paint pages near the viewport; the sized placeholders make slider jumps
// possible immediately, without allocating a canvas for the entire document.
function PdfPage({ page, width, zoom, root }: { page: PDFPageProxy; width: number; zoom: number; root: React.RefObject<HTMLDivElement | null> }) {
  const element = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [visible, setVisible] = useState(false)
  const base = page.getViewport({scale: 1})
  const cssWidth = Math.max(100, width - 24) * zoom
  const cssHeight = cssWidth * base.height / base.width
  useEffect(() => {
    const observer = new IntersectionObserver(entries => setVisible(entries.some(e => e.isIntersecting)), {root: root.current, rootMargin: '700px'})
    if (element.current) observer.observe(element.current)
    return () => observer.disconnect()
  }, [page, root])
  useEffect(() => {
    const node = canvas.current
    if (!visible || !node) return
    const viewport = page.getViewport({scale: cssWidth / base.width * (window.devicePixelRatio || 1)})
    node.width = Math.ceil(viewport.width); node.height = Math.ceil(viewport.height)
    const task = page.render({canvasContext: node.getContext('2d')!, viewport})
    task.promise.catch(() => {}) // cancelled when zooming, switching file, or leaving viewport
    return () => { task.cancel() }
  }, [page, visible, cssWidth, base.width])
  return <div ref={element} className="pdf-page" data-page={page.pageNumber} style={{width: cssWidth, height: cssHeight}}>
    {visible && <canvas ref={canvas} aria-label={`PDF ${page.pageNumber}페이지`} style={{width: cssWidth, height: cssHeight}} />}
  </div>
}

export function PdfViewer({ url, viewState, onViewChange }: Props) {
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
    </div>}
    <div className="pdf-reading-area">
    <div ref={containerRef} className="pdf-pages" onScroll={onScroll}>
      {pages.map(page=><PdfPage key={`${reloadKey}:${url}:${page.pageNumber}`} page={page} width={width} zoom={zoom} root={containerRef} />)}
    </div>
    {pages.length>0 && <div className="vertical-scroll-rail pdf-page-rail"><output>{currentPage}</output>
      <input className="pdf-page-slider vertical-slider" type="range" aria-label="PDF 페이지 이동" aria-orientation="vertical" min={1} max={pages.length} value={currentPage}
        aria-valuetext={`${currentPage} / ${pages.length} 페이지`} onChange={e=>goToPage(Number(e.target.value))} />
      <span>{pages.length}</span>
    </div>}
    </div>
  </div>
}
