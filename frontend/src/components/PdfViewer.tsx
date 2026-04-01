import { useEffect, useRef, useState, useCallback } from 'react'

interface Props {
  url: string
}

const ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3]

export function PdfViewer({ url }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState('Downloading...')
  const [error, setError] = useState('')
  const [pages, setPages] = useState(0)
  const [zoom, setZoom] = useState(1) // 1 = fit width
  const pdfRef = useRef<any>(null)
  const pdfjsRef = useRef<any>(null)

  // Download + parse PDF
  useEffect(() => {
    let cancelled = false
    pdfRef.current = null

    setStatus('Downloading...')
    setError('')
    setPages(0)
    setZoom(1)

    async function load() {
      try {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 60000)
        const resp = await fetch(url, { credentials: 'include', signal: ctrl.signal })
        clearTimeout(timer)
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)

        const total = parseInt(resp.headers.get('content-length') || '0')
        const reader = resp.body?.getReader()
        if (!reader) throw new Error('No body')

        const chunks: Uint8Array[] = []
        let received = 0
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (cancelled) { reader.cancel(); return }
          chunks.push(value)
          received += value.length
          setStatus(total > 0 ? `${Math.round(received/1024)} / ${Math.round(total/1024)} KB` : `${Math.round(received/1024)} KB`)
        }
        if (cancelled) return

        const data = new Uint8Array(received)
        let off = 0
        for (const c of chunks) { data.set(c, off); off += c.length }

        setStatus('Loading...')
        const [pdfjsLib, workerModule] = await Promise.all([
          import('pdfjs-dist'),
          import('pdfjs-dist/build/pdf.worker.min.mjs?raw'),
        ])
        const workerBlob = new Blob([workerModule.default], { type: 'application/javascript' })
        pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(workerBlob)
        pdfjsRef.current = pdfjsLib
        if (cancelled) return

        setStatus('Parsing...')
        const pdf = await pdfjsLib.getDocument({ data }).promise
        if (cancelled) return

        pdfRef.current = pdf
        setPages(pdf.numPages)
        setStatus('')
      } catch (e: any) {
        if (cancelled) return
        setError(e?.name === 'AbortError' ? 'Timeout' : (e?.message || String(e)))
        setStatus('')
      }
    }
    load()
    return () => { cancelled = true }
  }, [url])

  // Render pages at current zoom
  const renderPages = useCallback(async () => {
    const pdf = pdfRef.current
    const container = containerRef.current
    if (!pdf || !container) return

    container.innerHTML = ''
    const dpr = window.devicePixelRatio || 1
    const containerWidth = container.clientWidth || 360

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i)
      const baseVp = page.getViewport({ scale: 1 })
      const fitScale = containerWidth / baseVp.width
      const scale = fitScale * zoom * dpr

      const vp = page.getViewport({ scale })
      const canvas = document.createElement('canvas')
      canvas.width = vp.width
      canvas.height = vp.height
      canvas.style.width = `${(fitScale * zoom * baseVp.width)}px`
      canvas.style.height = 'auto'
      canvas.style.display = 'block'
      canvas.style.marginBottom = '4px'
      container.appendChild(canvas)
      await page.render({ canvasContext: canvas.getContext('2d')!, viewport: vp }).promise
    }
  }, [zoom])

  // Re-render when zoom changes or pdf loads
  useEffect(() => {
    if (pages > 0) renderPages()
  }, [pages, zoom, renderPages])

  const zoomIn = () => setZoom(z => { const i = ZOOM_LEVELS.findIndex(l => l >= z * 1.01); return ZOOM_LEVELS[Math.min(i + 1, ZOOM_LEVELS.length - 1)] || z })
  const zoomOut = () => setZoom(z => { const i = ZOOM_LEVELS.findIndex(l => l >= z * 0.99); return ZOOM_LEVELS[Math.max(i - 1, 0)] || z })
  const zoomFit = () => setZoom(1)

  return (
    <div className="pdf-container">
      {status && <div className="fp-loading" style={{padding:40}}><div className="spinner" /><span>{status}</span></div>}
      {error && <div className="fv-pdf-fallback"><p>{error}</p><a href={url} target="_blank" rel="noopener" className="fv-download">Download</a></div>}
      {pages > 0 && (
        <div className="pdf-toolbar">
          <button className="pdf-zoom-btn" onClick={zoomOut} title="Zoom out">-</button>
          <span className="pdf-zoom-label" onClick={zoomFit} title="Fit width">{Math.round(zoom * 100)}%</span>
          <button className="pdf-zoom-btn" onClick={zoomIn} title="Zoom in">+</button>
          <span className="pdf-page-info">{pages}p</span>
        </div>
      )}
      <div ref={containerRef} className="pdf-pages" />
    </div>
  )
}
