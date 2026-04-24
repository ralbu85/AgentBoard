import { Marked } from 'marked'
import markedKatex from 'marked-katex-extension'

const md = new Marked()
md.use(markedKatex({ throwOnError: false, nonStandard: true }))
md.use({ breaks: true, gfm: true })

/** Resolve image src to /api/file-raw endpoint */
function resolveImgSrc(src: string, baseDir: string): string {
  if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:')) return src
  let full: string
  if (src.startsWith('/')) {
    full = src
  } else {
    const parts = baseDir.replace(/\/$/, '').split('/')
    for (const seg of src.split('/')) {
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
  return html
}
