import { Marked } from 'marked'
import markedKatex from 'marked-katex-extension'
import { sanitize } from './sanitize'

const md = new Marked()
md.use(markedKatex({ throwOnError: false, nonStandard: true }))
md.use({ breaks: true, gfm: true })

/** Resolve image src to /api/file-raw endpoint */
function resolveImgSrc(src: string, baseDir: string): string {
  if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:')) return src
  // marked URL-encodes non-ASCII chars in image src; decode before re-encoding to avoid double-encoding (e.g. Korean/space paths).
  let decoded = src
  try { decoded = decodeURIComponent(src) } catch { /* leave as-is on malformed sequence */ }
  let full: string
  if (decoded.startsWith('/')) {
    full = decoded
  } else {
    const parts = baseDir.replace(/\/$/, '').split('/')
    for (const seg of decoded.split('/')) {
      if (seg === '..') parts.pop()
      else if (seg !== '.') parts.push(seg)
    }
    full = parts.join('/')
  }
  return `/api/file-raw?path=${encodeURIComponent(full)}`
}

export function renderMarkdown(src: string, filePath?: string): string {
  let html = md.parse(src) as string
  if (filePath) {
    const baseDir = filePath.replace(/\/[^/]*$/, '')
    html = html.replace(/<img\s+src="([^"]+)"/g, (_, imgSrc) => {
      return `<img src="${resolveImgSrc(imgSrc, baseDir)}"`
    })
  }
  return sanitize(html)
}
