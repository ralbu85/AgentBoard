import type {PDFDocumentProxy, PDFPageProxy} from 'pdfjs-dist'

export interface CachedPdf { document: PDFDocumentProxy; pages: PDFPageProxy[]; bytes: number }
interface Entry {
  source: string; users: number; touched: number; retired: boolean
  ready: Promise<CachedPdf>; value?: CachedPdf; dispose: () => void
}
const documents = new Map<string, Entry>()
const MAX_DOCUMENTS = 4
const MAX_BYTES = 64 * 1024 * 1024
let tick = 0

function cacheKey(url: string) {
  const parsed = new URL(url, 'http://agentboard.local')
  parsed.searchParams.delete('_t'); parsed.searchParams.delete('_r')
  return parsed.href
}
function retire(entry: Entry) {
  entry.retired = true
  if (!entry.users) entry.dispose()
}
function trim() {
  let bytes = [...documents.values()].reduce((n, e) => n + (e.value?.bytes || 0), 0)
  const unused = [...documents.entries()].filter(([,e]) => !e.users).sort((a,b) => a[1].touched - b[1].touched)
  for (const [key, entry] of unused) {
    if (documents.size <= MAX_DOCUMENTS && bytes <= MAX_BYTES) break
    documents.delete(key); bytes -= entry.value?.bytes || 0; retire(entry)
  }
}
export function peekPdf(url: string): CachedPdf | undefined {
  const entry = documents.get(cacheKey(url))
  return entry?.source === url ? entry.value : undefined
}

// Keep parsed documents and in-flight loads across tab/workspace switches.
// Only unused entries can be evicted; mounted viewers hold a lease.
export function acquirePdf(url: string, reload = false) {
  const key = cacheKey(url)
  let entry = documents.get(key)
  if (entry && (reload || entry.source !== url)) {
    documents.delete(key); retire(entry); entry = undefined
  }
  if (!entry) {
    const controller = new AbortController()
    let task: ReturnType<typeof import('pdfjs-dist').getDocument> | undefined
    let disposed = false
    const timer = window.setTimeout(() => controller.abort(), 60000)
    const created: Entry = {
      source: url, users: 0, touched: ++tick, retired: false,
      ready: undefined as unknown as Promise<CachedPdf>,
      dispose: () => {
        if (disposed) return
        disposed = true; controller.abort(); window.clearTimeout(timer)
        if (task) void task.destroy().catch(() => {})
      },
    }
    created.ready = (async () => {
      try {
        const requestUrl = reload ? `${url}${url.includes('?') ? '&' : '?'}_r=${Date.now()}` : url
        const response = await fetch(requestUrl, {credentials:'include', signal:controller.signal, cache: reload ? 'no-store' : 'default'})
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data = await response.arrayBuffer(), bytes = data.byteLength
        const [pdfjs, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')])
        if (disposed) throw new Error('PDF load cancelled')
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default
        task = pdfjs.getDocument({data})
        const document = await task.promise
        const pages: PDFPageProxy[] = []
        for (let n=1; n<=document.numPages; n++) {
          if (disposed) throw new Error('PDF load cancelled')
          pages.push(await document.getPage(n))
        }
        const value = {document, pages, bytes}
        created.value = value
        trim()
        return value
      } catch (error) {
        if (documents.get(key) === created) documents.delete(key)
        created.dispose()
        throw error
      } finally { window.clearTimeout(timer) }
    })()
    // Consumers attach their own handlers; a released pending lease can reject too.
    void created.ready.catch(() => {})
    documents.set(key, created); entry = created
  }
  entry.users++; entry.touched = ++tick
  trim()
  const leased = entry
  let released = false
  return {
    ready: leased.ready,
    release() {
      if (released) return
      released = true; leased.users--
      if (leased.retired && !leased.users) leased.dispose()
      trim()
    },
  }
}
