import { useEffect, useRef, useState } from 'react'

interface Props {
  url: string
}

export function PdfViewer({ url }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState('Downloading...')
  const [error, setError] = useState('')
  const [pages, setPages] = useState(0)

  useEffect(() => {
    let cancelled = false
    const container = containerRef.current
    if (!container) return

    setStatus('Downloading...')
    setError('')
    setPages(0)
    container.innerHTML = ''

    async function run() {
      try {
        // Download PDF
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
          setStatus(total > 0
            ? `${Math.round(received/1024)} / ${Math.round(total/1024)} KB`
            : `${Math.round(received/1024)} KB`)
        }
        if (cancelled) return

        const data = new Uint8Array(received)
        let off = 0
        for (const c of chunks) { data.set(c, off); off += c.length }

        // Load pdf.js + worker as blob URL (avoids path/CORS issues)
        setStatus('Loading...')
        const [pdfjsLib, workerModule] = await Promise.all([
          import('pdfjs-dist'),
          import('pdfjs-dist/build/pdf.worker.min.mjs?raw'),
        ])

        const workerBlob = new Blob([workerModule.default], { type: 'application/javascript' })
        pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(workerBlob)

        if (cancelled) return

        setStatus('Rendering...')
        const pdf = await pdfjsLib.getDocument({ data }).promise
        if (cancelled) return

        const n = pdf.numPages
        for (let i = 1; i <= n; i++) {
          if (cancelled) return
          setStatus(`Page ${i} / ${n}`)
          const page = await pdf.getPage(i)
          const dpr = window.devicePixelRatio || 1
          const w = container!.clientWidth || 360
          const bvp = page.getViewport({ scale: 1 })
          const vp = page.getViewport({ scale: (w / bvp.width) * dpr })

          const canvas = document.createElement('canvas')
          canvas.width = vp.width
          canvas.height = vp.height
          canvas.style.width = '100%'
          canvas.style.height = 'auto'
          canvas.style.display = 'block'
          canvas.style.marginBottom = '4px'
          container!.appendChild(canvas)
          await page.render({ canvasContext: canvas.getContext('2d')!, viewport: vp }).promise
        }
        if (!cancelled) { setStatus(''); setPages(n) }
      } catch (e: any) {
        if (cancelled) return
        setError(e?.name === 'AbortError' ? 'Timeout' : (e?.message || String(e)))
        setStatus('')
      }
    }
    run()
    return () => { cancelled = true }
  }, [url])

  return (
    <div className="pdf-container">
      {status && <div className="fp-loading" style={{padding:40}}><div className="spinner" /><span>{status}</span></div>}
      {error && <div className="fv-pdf-fallback"><p>{error}</p><a href={url} target="_blank" rel="noopener" className="fv-download">Download</a></div>}
      <div ref={containerRef} className="pdf-pages" />
      {pages > 0 && <div className="pdf-info">{pages} pages</div>}
    </div>
  )
}
