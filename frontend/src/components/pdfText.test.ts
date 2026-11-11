import { afterEach, expect, it } from 'vitest'
import type { TextContent } from 'pdfjs-dist/types/src/display/api'
import { mergeLines, offsetIn, pageText, rangeRects, readText } from './pdfText'

// Text items as pdf.js gives them, and the layer TextLayer builds from them:
// a span per item with text, a <br> after an item that ends a line.
// `x`, `y`, `cw` (character width) place them for the measuring test, in px.
const items = [
  { str: 'Deep learn-', hasEOL: true, x: 0, y: 0, cw: 100 / 11 }, { str: 'ing models', hasEOL: true, x: 0, y: 12, cw: 10 },
  { str: '', hasEOL: true, x: 0, y: 0, cw: 0 },
  { str: 'are', hasEOL: false, x: 0, y: 24, cw: 10 }, { str: ' ', hasEOL: false, x: 30, y: 24, cw: 5 }, { str: 'big', hasEOL: false, x: 35, y: 24, cw: 10 },
]
function layer() {
  const div = document.createElement('div')
  div.className = 'textLayer'
  items.forEach((item, i) => {
    if (item.str) { const span = document.createElement('span'); span.textContent = item.str; span.dataset.item = String(i); div.append(span) }
    if (item.hasEOL) div.append(document.createElement('br'))
  })
  div.append(Object.assign(document.createElement('div'), { className: 'endOfContent' }))   // the selection helper: no text
  document.body.append(div)
  return div
}
const original = Range.prototype.getClientRects
afterEach(() => { Range.prototype.getClientRects = original; document.body.replaceChildren() })

it('counts a selection the way the page text does, and reads it with its line breaks', () => {
  const div = layer()
  const content = { items: items.map(({ str, hasEOL }) => ({ str, hasEOL, transform: [], width: 0, height: 0, dir: 'ltr', fontName: 'f' })), styles: {}, lang: null } as unknown as TextContent
  expect(div.textContent).toBe(pageText(content))
  const models = div.querySelectorAll('span')[1].firstChild!
  expect(offsetIn(div, models, 3)).toBe('Deep learn-ing'.length)
  expect(offsetIn(div, div, div.childNodes.length)).toBe(pageText(content).length)
  const text = div.textContent!
  expect(readText(div, 0, text.length)).toBe('Deep learn-ing models are big')   // no space after a hyphen
  expect(readText(div, text.indexOf('models'), text.indexOf('big'))).toBe('models are ')
})

it('measures the selected characters only, as parts of the page, one box per line', () => {
  const div = layer()
  // The page is at (50, 20); each item's characters are 10px tall.
  Range.prototype.getClientRects = function (this: Range) {
    const { x, y, cw } = items[Number(this.startContainer.parentElement!.dataset.item)]
    return [new DOMRect(50 + x + cw * this.startOffset, 20 + y, cw * (this.endOffset - this.startOffset), 10)] as unknown as DOMRectList
  }
  const page = new DOMRect(50, 20, 400, 600)
  const text = div.textContent!
  const rects = rangeRects(div, text.indexOf('learn'), text.indexOf('models') + 6, page)
  expect(rects.map(r => r.map(v => Math.round(v * 1000) / 1000))).toEqual([
    [0.114, 0, 0.136, 0.017],   // "learn-" of line 0
    [0, 0.02, 0.25, 0.017],     // all of "ing models"
  ])
  // "are", " " and "big" sit on one line: one box.
  expect(rangeRects(div, text.indexOf('are'), text.length, page)).toHaveLength(1)
})

it('joins boxes on one line but keeps lines and columns apart', () => {
  const round = (rects: number[][]) => rects.map(r => r.map(v => Math.round(v * 1e6) / 1e6))
  expect(round(mergeLines([[0.1, 0.1, 0.1, 0.02], [0.21, 0.101, 0.1, 0.02], [0.1, 0.13, 0.2, 0.02]])))
    .toEqual([[0.1, 0.1, 0.21, 0.021], [0.1, 0.13, 0.2, 0.02]])
  expect(mergeLines([[0.1, 0.1, 0.3, 0.02], [0.55, 0.1, 0.3, 0.02]])).toHaveLength(2)
})
