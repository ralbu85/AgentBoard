import { useEffect, useRef, useState, useCallback } from 'react'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'

interface Props { url: string; viewState?: { page?: number; zoom?: number }; onViewChange?: (view: {page: number; zoom: number}) => void }
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
  const [status, setStatus] = useState('PDF 불러오는 중…')
  const [error, setError] = useState('')
  const [pages, setPages] = useState<PDFPageProxy[]>([])
  const [zoom, setZoom] = useState(viewState?.zoom || 1)
  const [currentPage, setCurrentPage] = useState(viewState?.page || 1)
  const currentRef = useRef(viewState?.page || 1)
  const [width, setWidth] = useState(600)
  const [reloadKey, setReloadKey] = useState(0)
  const viewChange = useRef(onViewChange); viewChange.current = onViewChange
  useEffect(() => { if (pages.length) viewChange.current?.({page: currentPage, zoom}) }, [currentPage, zoom, pages.length])
  const previousUrl = useRef(url)
  const restorePage = useRef(1)

  useEffect(() => {
    let cancelled = false
    let document: PDFDocumentProxy | undefined
    let loadingTask: ReturnType<typeof import('pdfjs-dist').getDocument> | undefined
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), 60000)
    const same = previousUrl.current === url
    previousUrl.current = url
    restorePage.current = same ? currentRef.current : 1
    if (!same) { setZoom(1); setCurrentPage(1); currentRef.current = 1 }
    setPages([]); setError(''); setStatus('PDF 불러오는 중…')
    async function load() {
      try {
        const response = await fetch(url + (reloadKey ? `${url.includes('?') ? '&' : '?'}_r=${reloadKey}` : ''), {credentials:'include', signal:controller.signal})
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data = await response.arrayBuffer()
        const [pdfjs, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')])
        if (cancelled) return
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default
        loadingTask = pdfjs.getDocument({data})
        document = await loadingTask.promise
        const result: PDFPageProxy[] = []
        for (let n=1; n<=document.numPages; n++) {
          if (cancelled) return
          result.push(await document.getPage(n))
        }
        if (cancelled) return
        const page = Math.min(result.length, restorePage.current)
        currentRef.current = page; setCurrentPage(page)
        setPages(result); setStatus('')
      } catch (e) {
        if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setStatus('') }
      } finally { window.clearTimeout(timer) }
    }
    load()
    return () => {
      cancelled = true; controller.abort(); window.clearTimeout(timer)
      if (loadingTask) void loadingTask.destroy().catch(() => {})
    }
  }, [url, reloadKey])

  useEffect(() => {
    const node = containerRef.current
    if (!node) return
    const observer = new ResizeObserver(() => setWidth(node.clientWidth))
    observer.observe(node); setWidth(node.clientWidth)
    return () => observer.disconnect()
  }, [])

  const goToPage = useCallback((value: number) => {
    const page = Math.max(1, Math.min(pages.length, value))
    const container = containerRef.current
    const target = container?.querySelector<HTMLElement>(`[data-page="${page}"]`)
    if (!target || !container) return
    container.scrollTop = target.offsetTop
    currentRef.current = page; setCurrentPage(page)
  }, [pages.length])

  useEffect(() => {
    const frame = requestAnimationFrame(() => goToPage(currentRef.current))
    return () => cancelAnimationFrame(frame)
  }, [pages, zoom, width, goToPage])

  const onScroll = () => {
    const container = containerRef.current
    if (!container || !pages.length) return
    const nodes = [...container.querySelectorAll<HTMLElement>('[data-page]')]
    const readingLine = container.scrollTop + Math.min(80, container.clientHeight * .2)
    const target = [...nodes].reverse().find(node => node.offsetTop <= readingLine) || nodes[0]
    if (target) { const page = Number(target.dataset.page); currentRef.current = page; setCurrentPage(page) }
  }

  return <div className="pdf-container">
    {status && <div className="fp-loading" style={{padding:30}}><div className="spinner" /><span>{status}</span></div>}
    {error && <div className="fv-pdf-fallback"><p>{error}</p><a href={url} target="_blank" rel="noopener" className="fv-download">다운로드</a></div>}
    {pages.length > 0 && <div className="pdf-toolbar">
      <button className="pdf-zoom-btn" onClick={() => goToPage(currentPage-1)} disabled={currentPage===1} title="이전 페이지">‹</button>
      <output className="pdf-page-info" aria-live="polite">{currentPage} / {pages.length} 페이지</output>
      <button className="pdf-zoom-btn" onClick={() => goToPage(currentPage+1)} disabled={currentPage===pages.length} title="다음 페이지">›</button>
      <input className="pdf-page-slider" type="range" aria-label="PDF 페이지 이동" min={1} max={pages.length} value={currentPage}
        aria-valuetext={`${currentPage} / ${pages.length} 페이지`} onChange={e=>goToPage(Number(e.target.value))} />
      <button className="pdf-zoom-btn" onClick={()=>setZoom(z=>[...ZOOM_LEVELS].reverse().find(v=>v<z) || z)} title="Zoom out">−</button>
      <button className="pdf-zoom-label" onClick={()=>setZoom(1)} title="Fit width">{Math.round(zoom*100)}%</button>
      <button className="pdf-zoom-btn" onClick={()=>setZoom(z=>ZOOM_LEVELS.find(v=>v>z) || z)} title="Zoom in">+</button>
      <button className="pdf-zoom-btn" onClick={()=>setReloadKey(k=>k+1)} title="새로고침 (페이지 유지)">↻</button>
    </div>}
    <div ref={containerRef} className="pdf-pages" onScroll={onScroll}>
      {pages.map(page=><PdfPage key={`${reloadKey}:${url}:${page.pageNumber}`} page={page} width={width} zoom={zoom} root={containerRef} />)}
    </div>
  </div>
}
