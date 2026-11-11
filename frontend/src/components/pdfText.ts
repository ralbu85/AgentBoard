import type { PDFPageProxy, PageViewport } from 'pdfjs-dist'
import type { TextContent } from 'pdfjs-dist/types/src/display/api'

// The selectable text over a rendered PDF page (pdf.js's TextLayer), and the
// mapping between a selection in it and the page's text. A page's text is its
// text items joined with nothing between them: the same characters, in the same
// order, as the text nodes of its layer (a line break is a <br>, which has none).

export type Rect = [number, number, number, number]   // x, y, width, height as fractions of the page

const contents = new WeakMap<PDFPageProxy, Promise<TextContent>>()
export const textContentOf = (page: PDFPageProxy) => {
  let content = contents.get(page)
  if (!content) { content = page.getTextContent(); contents.set(page, content) }
  return content
}
export const pageText = (content: TextContent) => content.items.map(item => 'str' in item ? item.str : '').join('')

// pdf.js's viewer keeps a drag that leaves the glyphs from selecting the rest of
// the page: an empty block is moved right after the selection's moving end, so
// the blank space under the pointer belongs to it. The same, for our layers.
const ends = new Map<HTMLElement, HTMLElement>()
let listening: AbortController | null = null
function reset(end: HTMLElement, layer: HTMLElement) {
  layer.append(end); end.style.width = ''; end.style.height = ''
  layer.classList.remove('selecting')
}
function smoothSelection() {
  if (listening) return
  listening = new AbortController()
  const {signal} = listening
  let down = false, previous: Range | null = null
  document.addEventListener('pointerdown', () => { down = true }, {signal})
  document.addEventListener('pointerup', () => { down = false; ends.forEach(reset) }, {signal})
  window.addEventListener('blur', () => { down = false; ends.forEach(reset) }, {signal})
  document.addEventListener('keyup', () => { if (!down) ends.forEach(reset) }, {signal})
  document.addEventListener('selectionchange', () => {
    const selection = document.getSelection()
    if (!selection?.rangeCount) { ends.forEach(reset); return }
    const range = selection.getRangeAt(0)
    for (const [layer, end] of ends) {
      if (range.intersectsNode(layer)) layer.classList.add('selecting')
      else reset(end, layer)
    }
    const movedStart = previous && (range.compareBoundaryPoints(Range.END_TO_END, previous) === 0 || range.compareBoundaryPoints(Range.START_TO_END, previous) === 0)
    let anchor: Node = movedStart ? range.startContainer : range.endContainer
    if (anchor.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode!
    const layer = anchor.parentElement?.closest<HTMLElement>('.textLayer')
    const end = layer && ends.get(layer)
    if (layer && end && anchor.parentElement) {
      end.style.width = layer.style.width; end.style.height = layer.style.height
      anchor.parentElement.insertBefore(end, movedStart ? anchor : anchor.nextSibling)
    }
    previous = range.cloneRange()
  }, {signal})
}

/** Renders the page's text into `container` (which carries `--scale-factor`).
 *  `done` says whether the text got there; `cancel` stops it and forgets the layer. */
export function renderTextLayer(page: PDFPageProxy, container: HTMLElement, viewport: PageViewport) {
  let layer: { cancel(): void } | null = null, cancelled = false
  const done = (async () => {
    const [{ TextLayer }, content] = await Promise.all([import('pdfjs-dist'), textContentOf(page)])
    if (cancelled) return false
    container.replaceChildren()
    const text = new TextLayer({ textContentSource: content, container, viewport })
    layer = text
    await text.render()
    if (cancelled) return false
    const end = document.createElement('div')
    end.className = 'endOfContent'
    container.append(end)
    container.onmousedown = () => container.classList.add('selecting')
    ends.set(container, end)
    smoothSelection()
    return true
  })()
  return {
    done,
    cancel() {
      cancelled = true; layer?.cancel(); ends.delete(container)
      if (!ends.size) { listening?.abort(); listening = null }
    },
  }
}

/** Where a DOM position falls in the layer's text. */
export function offsetIn(layer: Node, node: Node, offset: number) {
  const range = document.createRange()
  range.setStart(layer, 0); range.setEnd(node, offset)
  return range.toString().length
}

/** The layer's text [start, end) as it reads: a line break becomes a space
 *  (none after a hyphen or a space), where the page's text has nothing. */
export function readText(layer: Node, start: number, end: number) {
  let at = 0, out = ''
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
  for (let node = walker.nextNode(); node && at <= end; node = walker.nextNode()) {
    if (node instanceof Text) {
      out += node.data.slice(Math.max(start - at, 0), Math.max(end - at, 0))
      at += node.data.length
    } else if (node.nodeName === 'BR' && at > start && at < end && !/[\s-]$/.test(out)) out += ' '
  }
  return out
}

/** Boxes on the same line (and close along it) become one. */
export function mergeLines(rects: Rect[]): Rect[] {
  const lines: Rect[] = []
  for (const r of [...rects].sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
    const line = lines.find(l => {
      const overlap = Math.min(l[1] + l[3], r[1] + r[3]) - Math.max(l[1], r[1])
      const gap = Math.max(l[3], r[3]) * 1.5
      return overlap > Math.min(l[3], r[3]) / 2 && r[0] <= l[0] + l[2] + gap && r[0] + r[2] >= l[0] - gap
    })
    if (!line) { lines.push([...r]); continue }
    const x = Math.min(line[0], r[0]), y = Math.min(line[1], r[1])
    line[2] = Math.max(line[0] + line[2], r[0] + r[2]) - x; line[3] = Math.max(line[1] + line[3], r[1] + r[3]) - y
    line[0] = x; line[1] = y
  }
  return lines
}

/** The boxes of the layer's characters [start, end), as fractions of `page`.
 *  Measured text node by text node: a range's own boxes would add the elements
 *  it spans, such as the selection helper above, which can cover the page. */
export function rangeRects(layer: Node, start: number, end: number, page: DOMRect): Rect[] {
  if (!page.width || !page.height) return []
  const boxes: DOMRect[] = []
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT)
  let at = 0
  for (let node = walker.nextNode() as Text | null; node && at < end; node = walker.nextNode() as Text | null) {
    const from = Math.max(start - at, 0), to = Math.min(end - at, node.data.length)
    if (to > from) {
      const range = document.createRange()
      range.setStart(node, from); range.setEnd(node, to)
      boxes.push(...range.getClientRects())
    }
    at += node.data.length
  }
  return mergeLines(boxes.filter(b => b.width > 0.5 && b.height > 0.5)
    .map(b => [(b.left - page.left) / page.width, (b.top - page.top) / page.height, b.width / page.width, b.height / page.height]))
}
