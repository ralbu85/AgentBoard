import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Rect } from './pdfText'

// Memos on a PDF: a passage marked in its text, or an area drawn on a page (a
// figure, an equation, a scan), with what the reader wrote about it. They are
// kept beside the file (/api/notes), not written into it, so a recompiled PDF
// keeps them: a passage is found again by its words and the words around it.

export interface PdfMemo {
  id: string
  kind: 'text' | 'area'
  page: number
  /** Where it is drawn, measured on the page's text when it was last shown. */
  rects: Rect[]
  text: string
  /** Passages: the words, some words on either side, and where the words start in the page's text. */
  quote?: string; prefix?: string; suffix?: string; start?: number
  created: number
}
/** Where a passage is in the PDF as it is now. */
export interface Place { page: number; start: number; end: number }

export const CONTEXT = 40

export function isPdfMemo(note: unknown): note is PdfMemo {
  const m = note as PdfMemo
  return !!m && typeof m.id === 'string' && (m.kind === 'text' || m.kind === 'area') && Number.isInteger(m.page)
    && Array.isArray(m.rects) && typeof m.text === 'string'
}

export const newMemoId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

// Spaces and line breaks don't count when looking for a passage: a recompile
// moves them, and a page's text has none where a line ends.
function squeeze(text: string) {
  let out = ''
  const at: number[] = []
  for (let i = 0; i < text.length; i++) if (!/\s/.test(text[i])) { out += text[i]; at.push(i) }
  return { out, at }
}

/** Where the passage is in a page's text, [start, end). Of several matches,
 *  the one whose surrounding words match best, then the one nearest `start`.
 *  `score` counts the surrounding characters that matched. */
export function findQuote(text: string, m: Pick<PdfMemo, 'quote' | 'prefix' | 'suffix' | 'start'>) {
  const quote = squeeze(m.quote || '').out
  if (!quote) return null
  const page = squeeze(text), before = squeeze(m.prefix || '').out, after = squeeze(m.suffix || '').out
  let best: { start: number; end: number; score: number; distance: number } | null = null
  for (let i = page.out.indexOf(quote); i >= 0; i = page.out.indexOf(quote, i + 1)) {
    let score = 0
    while (score < before.length && i - score > 0 && page.out[i - score - 1] === before[before.length - score - 1]) score++
    const j = i + quote.length
    for (let k = 0; k < after.length && j + k < page.out.length && page.out[j + k] === after[k]; k++) score++
    const start = page.at[i], distance = Math.abs(start - (m.start ?? start))
    if (!best || score > best.score || (score === best.score && distance < best.distance))
      best = { start, end: page.at[j - 1] + 1, score, distance }
  }
  return best
}

/** The passage on its own page, if the words around it are there too. */
export function onItsPage(text: string | undefined, m: PdfMemo): Place | null {
  const hit = text === undefined ? null : findQuote(text, m)
  const context = squeeze(m.prefix || '').out.length + squeeze(m.suffix || '').out.length
  return hit && hit.score >= Math.min(12, context) ? { page: m.page, start: hit.start, end: hit.end } : null
}

/** The words before and after the passage are still on its page, close
 *  together, without it between them: it was deleted or rewritten there. */
function rewritten(text: string | undefined, m: PdfMemo) {
  const before = squeeze(m.prefix || '').out.slice(-16), after = squeeze(m.suffix || '').out.slice(0, 16)
  if (text === undefined || before.length < 12 || after.length < 12) return false
  const page = squeeze(text).out, room = squeeze(m.quote || '').out.length * 2 + 24
  for (let i = page.indexOf(before); i >= 0; i = page.indexOf(before, i + 1)) {
    const j = page.indexOf(after, i + before.length)
    if (j >= 0 && j - i - before.length <= room) return true
  }
  return false
}

/** Finds a passage in the PDF's page texts. Unless it is still on its page
 *  among the same words, the best match of all pages wins (the nearest page
 *  on a tie), and only a distinctive one (its surroundings match, or a long
 *  passage): words that were deleted shouldn't land on the same words elsewhere. */
export function locateQuote(m: PdfMemo, texts: string[]): Place | null {
  const here = onItsPage(texts[m.page - 1], m)
  if (here) return here
  if (rewritten(texts[m.page - 1], m)) return null
  const long = squeeze(m.quote || '').out.length >= 24
  let best: (Place & { score: number }) | null = null
  const pages = texts.map((_, i) => i + 1).sort((a, b) => Math.abs(a - m.page) - Math.abs(b - m.page) || a - b)
  for (const page of pages) {
    const hit = findQuote(texts[page - 1], page === m.page ? m : { ...m, start: undefined })
    if (hit && (long || hit.score >= 6) && (!best || hit.score > best.score)) best = { page, start: hit.start, end: hit.end, score: hit.score }
  }
  return best && { page: best.page, start: best.start, end: best.end }
}

const top = (m: PdfMemo) => m.rects[0]?.[1] ?? 0
const left = (m: PdfMemo) => m.rects[0]?.[0] ?? 0
/** Page order, then top to bottom. */
export const inOrder = (memos: PdfMemo[]) =>
  [...memos].sort((a, b) => a.page - b.page || top(a) - top(b) || left(a) - left(b) || a.created - b.created)

export const roundRects = (rects: Rect[]) => rects.map(r => r.map(v => Math.round(v * 1e4) / 1e4) as Rect)
export const sameRects = (a: Rect[], b: Rect[]) =>
  a.length === b.length && a.every((r, i) => r.every((v, j) => Math.abs(v - b[i][j]) < 0.002))

const area = (r?: Rect) => {
  if (!r) return ''
  const x = r[0] + r[2] / 2, y = r[1] + r[3] / 2
  return (y < 1 / 3 ? '위쪽' : y < 2 / 3 ? '가운데' : '아래쪽') + (x < 1 / 3 ? ' 왼편' : x > 2 / 3 ? ' 오른편' : '')
}

/** The memos as a request to the session that writes this PDF's source. */
export function chatMessage(path: string, memos: PdfMemo[], lost: Set<string>) {
  const parts = [`파일: ${path}`, 'PDF에 단 메모입니다. 메모대로 이 PDF의 원본을 고쳐 주세요. 선택 문장으로 위치를 찾아 주세요.']
  for (const m of memos) {
    if (!m.text.trim()) continue
    const at = m.kind === 'area' ? `p.${m.page} 영역, 페이지 ${area(m.rects[0])}` : `p.${m.page}${lost.has(m.id) ? ', 지금 PDF에서는 이 문장을 찾지 못함' : ''}`
    parts.push(`\n[${at}] 요청: ${m.text.trim()}`)
    if (m.quote) parts.push('선택 문장:\n' + m.quote.split('\n').map(line => '> ' + line).join('\n'))
  }
  return parts.join('\n')
}

/** One file's memos. Each change shows at once and is saved half a second
 *  after the last (adding and deleting at once); saves never overlap. */
export function memoStore(path: string, publish: (memos: PdfMemo[]) => void) {
  let memos: PdfMemo[] = [], others: object[] = [], loaded = false, closed = false
  let timer = 0, saving = false, again = false
  const save = async () => {
    window.clearTimeout(timer); timer = 0
    if (!loaded) return
    if (saving) { again = true; return }
    saving = true
    try {
      do { again = false; await api.saveNotes(path, [...others, ...memos]) } while (again)
    } finally { saving = false }
  }
  return {
    async load() {
      const res = await api.loadNotes(path)
      const notes: unknown[] = Array.isArray(res?.notes) ? res.notes : []
      memos = notes.filter(isPdfMemo)
      others = notes.filter(n => !isPdfMemo(n)) as object[]   // anything else in the file is kept as it is
      loaded = true
      if (!closed) publish(memos)
    },
    change(update: (memos: PdfMemo[]) => PdfMemo[], now = false) {
      if (!loaded) return
      const next = update(memos)
      if (next === memos) return
      memos = next
      if (!closed) publish(memos)
      window.clearTimeout(timer)
      if (now) void save()
      else timer = window.setTimeout(save, 500)
    },
    close() {
      closed = true
      if (timer) void save()
    },
  }
}

type Change = ReturnType<typeof memoStore>['change']
/** The file's memos; `change` is there once they are loaded. */
export function usePdfMemos(path: string | undefined) {
  const [state, setState] = useState<{ memos: PdfMemo[]; change?: Change }>({ memos: [] })
  useEffect(() => {
    setState({ memos: [] })
    if (!path) return
    const store = memoStore(path, memos => setState({ memos, change: store.change }))
    store.load().catch(() => {})
    return () => store.close()
  }, [path])
  return state
}
