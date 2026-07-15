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
