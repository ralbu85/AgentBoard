import { Marked } from 'marked'
import markedKatex from 'marked-katex-extension'
import { sanitize } from './sanitize'

const md = new Marked()
md.use(markedKatex({ throwOnError: false, nonStandard: true }))
md.use({ breaks: true, gfm: true })

export type MarkdownAttachments = Record<string, Record<string, unknown>>

/** Resolve image src to /api/file-raw endpoint */
function resolveImgSrc(src: string, baseDir: string): string {
  // URL schemes are left for the sanitizer/browser, never treated as files.
  if (/^[a-z][a-z\d+.-]*:/i.test(src) || src.startsWith('//') || src.startsWith('/api/file-raw?')) return src
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

function attachmentSrc(name: string, attachments?: MarkdownAttachments): string | undefined {
  if (!attachments || typeof attachments !== 'object') return
  let decoded = name
  try { decoded = decodeURIComponent(name) } catch { /* malformed escape: try the original name */ }
  const key = Object.prototype.hasOwnProperty.call(attachments, name) ? name : decoded
  if (!Object.prototype.hasOwnProperty.call(attachments, key)) return
  const bundle = attachments[key]
  if (!bundle || typeof bundle !== 'object') return
  for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml']) {
    const value = bundle[mime]
    const data = typeof value === 'string' ? value : Array.isArray(value) && value.every(line => typeof line === 'string') ? value.join('') : ''
    if (!data.trim()) continue
    // SVG stays inside an image document; never inject attachment markup inline.
    return mime === 'image/svg+xml' ? `data:${mime};charset=utf-8,${encodeURIComponent(data)}` : `data:${mime};base64,${data.replace(/\s/g, '')}`
  }
}

// ── GFM task-list toggling ──
// Mirrors marked's task tokenizer: list bullet (or ordered marker), then
// "[ ]"/"[x]"/"[X]" followed by whitespace ("- [x]" alone is NOT a task).
// Blockquote prefixes allowed (marked renders those as checkboxes too);
// fenced code is skipped (marked doesn't render tasks there).
const TASK_RE = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\]\s)/
const FENCE_RE = /^\s{0,3}(```|~~~)/

/** 0-based indexes of source lines that render as task-list checkboxes, in
 *  document order — the Nth entry maps to the Nth <input type="checkbox">
 *  in renderMarkdown's HTML. Callers must verify the counts match before
 *  trusting the mapping (exotic markdown can desync the scan). */
export function findTaskLines(src: string): number[] {
  const out: number[] = []
  let fence: string | null = null
  const lines = src.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const f = lines[i].match(FENCE_RE)
    if (f) {
      if (!fence) fence = f[1]
      else if (f[1] === fence) fence = null
      continue
    }
    if (!fence && TASK_RE.test(lines[i])) out.push(i)
  }
  return out
}

/** Toggle the task checkbox on the given source line ("[ ]" ↔ "[x]"). */
export function toggleTaskLine(src: string, lineIdx: number): string {
  const lines = src.split('\n')
  if (lines[lineIdx] === undefined) return src
  lines[lineIdx] = lines[lineIdx].replace(TASK_RE, (_, pre, state, post) =>
    pre + (state === ' ' ? 'x' : ' ') + post)
  return lines.join('\n')
}

export function renderMarkdown(src: string, filePath?: string, attachments?: MarkdownAttachments): string {
  let html = md.parse(src) as string
  if (filePath || attachments) {
    // Template contents are inert. DOM attributes handle HTML images in any
    // attribute order, single quotes, and escaped filenames before sanitizing.
    const template = document.createElement('template')
    template.innerHTML = html
    const slash = filePath?.lastIndexOf('/') ?? -1
    const baseDir = slash >= 0 ? filePath!.slice(0, slash) || '/' : '.'
    for (const img of template.content.querySelectorAll('img')) {
      const imgSrc = img.getAttribute('src')?.trim()
      if (!imgSrc) continue
      if (imgSrc.startsWith('attachment:')) {
        const resolved = attachmentSrc(imgSrc.slice('attachment:'.length), attachments)
        if (resolved) img.setAttribute('src', resolved)
        else {
          img.removeAttribute('src')
          img.setAttribute('title', '노트북 셀에서 첨부 이미지를 찾을 수 없습니다.')
          if (!img.alt) img.alt = '첨부 이미지를 찾을 수 없습니다.'
        }
      } else if (filePath) img.setAttribute('src', resolveImgSrc(imgSrc, baseDir))
    }
    html = template.innerHTML
  }
  return sanitize(html)
}
