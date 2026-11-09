import {parse, type DefaultTreeAdapterMap} from 'parse5'
import {previewRuntime, type PreviewConfig, type PreviewPatch} from './htmlPreviewRuntime'

// Maps preview edits back onto the HTML source. parse5 implements the same
// tree construction as the browser, so its start-tag offsets identify the very
// elements the iframe renders; edits replace only that element's source range
// and the rest of the file stays byte-for-byte intact.

type ParentNode = DefaultTreeAdapterMap['parentNode']

export const PLACEHOLDER = '새 텍스트'
// Opaque sandbox origin + CSP: the HTML cannot reach the app, its API or
// credentials. It loads what the file embeds, files of its own project (a
// signed read-only address, see routes_preview.py) and the common CDNs.
// Nothing can be sent anywhere else, so what the page reads stays on screen.
const CDN = 'https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://fonts.googleapis.com https://fonts.gstatic.com https://cdn.plot.ly'
const policy = (project = '') => {
  const own = project ? ` ${project}` : ''
  return `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:${own} ${CDN}; style-src 'unsafe-inline'${own} ${CDN}; ` +
    `img-src data: blob:${own} ${CDN}; font-src data:${own} ${CDN}; media-src data: blob:${own}; connect-src${own} ${CDN}; worker-src blob:${own}; ` +
    `frame-src 'none'; object-src 'none'; base-uri ${project || "'none'"}; form-action 'none'`
}
const attr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
/** Where a previewed page's own files are served: `project` grants the whole
 *  project (`../site_libs`), `folder` is the page's folder (its <base>). */
export interface PreviewFiles { project: string; folder: string }
const head = (files?: PreviewFiles) => `<!doctype html><meta http-equiv="Content-Security-Policy" content="${attr(policy(files?.project))}"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  (files ? `<base href="${attr(files.folder)}">` : '')
// The token shape of the head + runtime <script>: parsing the file behind it puts
// parse5 in the same insertion mode the iframe is in when the file begins (a
// <base> is one more head element and changes nothing).
const SHAPE = '<!doctype html><meta><meta><script></script>'
const HTML_NS = 'http://www.w3.org/1999/xhtml'
const LOCKED = new Set(['html', 'head', 'body', 'script', 'style', 'noscript', 'template', 'title', 'pre', 'textarea',
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
const RUNTIME = `(${previewRuntime.toString()})`.replace(/<\/script/gi, '<\\/script')

export interface SourceElement {
  tag: string
  html: boolean
  start: number
  nameEnd: number
  openEnd: number
  closeStart: number
  end: number
  id?: [number, number]
}
export interface PreviewOp { t: 'commit' | 'add' | 'delete'; i: number; tag: string; before: string; after?: string; add?: boolean }
export type PreviewResult = { content: string; patches: PreviewPatch[] | null; focus?: number } | { error: string }
type Normalize = (html: string) => string

// A leading BOM would end the head early; a space keeps every offset.
const withoutBom = (src: string) => src.charCodeAt(0) === 0xfeff ? ' ' + src.slice(1) : src

/** Every element that has a start tag in `src`, in source order (index = ordinal). */
export function parseElements(src: string): SourceElement[] {
  const text = withoutBom(src)
  const doc = parse(SHAPE + text, {sourceCodeLocationInfo: true})
  const out: SourceElement[] = []
  const seen = new Set<number>()
  const at = (offset: number) => offset - SHAPE.length
  const visit = (node: ParentNode) => {
    for (const child of node.childNodes) {
      if (!('tagName' in child)) continue
      const loc = child.sourceCodeLocation, open = loc?.startTag
      // Formatting elements the parser re-creates share their original start tag.
      if (loc && open && open.startOffset >= SHAPE.length && !seen.has(open.startOffset)) {
        seen.add(open.startOffset)
        const start = at(open.startOffset)
        let nameEnd = start + 1
        while (nameEnd < text.length && !/[\s/>]/.test(text[nameEnd])) nameEnd++
        const end = at(loc.endOffset ?? SHAPE.length + text.length)
        const id = loc.attrs?.id
        out.push({
          tag: child.tagName, html: child.namespaceURI === HTML_NS, start, nameEnd,
          openEnd: at(open.endOffset), closeStart: loc.endTag ? at(loc.endTag.startOffset) : end, end,
          id: id ? [at(id.startOffset), at(id.endOffset)] : undefined,
        })
      }
      visit(child)
      if ('content' in child) visit(child.content)
    }
  }
  visit(doc)
  return out.sort((a, b) => a.start - b.start)
}

/** `src[from, to)` with `data-ab-i` added to every start tag inside it. */
export function annotate(src: string, els: SourceElement[], from = 0, to = src.length): string {
  const text = withoutBom(src)
  let out = '', pos = from
  els.forEach((el, k) => {
    if (el.start < from || el.start >= to) return
    out += text.slice(pos, el.nameEnd) + ` data-ab-i="${k}"`
    pos = el.nameEnd
  })
  return out + text.slice(pos, to)
}

const SEPARATORS = new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]`, 'g')
const json = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c').replace(SEPARATORS, c => `\\u${c.charCodeAt(0).toString(16)}`)

export function buildDocument(src: string, cfg: PreviewConfig, files?: PreviewFiles): string {
  return `${head(files)}<script>${RUNTIME}(${json(cfg)})</script>${annotate(src, parseElements(src))}`
}

/** The element a preview message names, verified against the current source. */
export function locate(src: string, op: { i: number; tag: string; before: string }, normalize: Normalize): { els: SourceElement[]; el: SourceElement } | { error: string } {
  const els = parseElements(src), el = els[op.i]
  if (!el || !el.html || el.tag !== op.tag || LOCKED.has(el.tag)) {
    return {error: '원본에서 이 부분을 찾지 못했습니다. 미리보기를 새로고침한 뒤 다시 시도하세요.'}
  }
  if (normalize(src.slice(el.openEnd, el.closeStart)) !== op.before) {
    return {error: '페이지 스크립트가 바꾼 내용이라 미리보기에서 고칠 수 없습니다. HTML 소스에서 수정하세요.'}
  }
  return {els, el}
}

function replaceRegion(src: string, els: SourceElement[], a: number, b: number, text: string, kind: PreviewPatch['kind'], i: number, normalize: Normalize) {
  const content = src.slice(0, a) + text + src.slice(b)
  const next = parseElements(content)
  const head = els.filter(e => e.start < a), tail = els.filter(e => e.start >= b)
  const newHead = next.filter(e => e.start < a), newTail = next.filter(e => e.start >= a + text.length)
  const same = (x: SourceElement[], y: SourceElement[], offset: number) =>
    x.length === y.length && x.every((e, k) => e.tag === y[k].tag && e.start + offset === y[k].start)
  // Everything outside the region must parse exactly as before (and edited
  // text must stay inside its element), or the iframe's ordinals can't be
  // patched in place — the caller reloads instead.
  const target = next[i]
  const stable = same(head, newHead, 0) && same(tail, newTail, text.length - (b - a))
    && (kind !== 'inner' || !!target && normalize(content.slice(target.openEnd, target.closeStart)) === normalize(text))
  const from = els.length - tail.length
  const delta = (next.length - newHead.length - newTail.length) - (els.length - head.length - tail.length)
  const patch: PreviewPatch | null = !stable ? null
    : kind === 'remove' ? {kind, i, from, delta}
    : {kind, i, from, delta, html: annotate(content, next, a, a + text.length)}
  return {content, els: next, patch}
}

/** Same tag and attributes (minus id) with placeholder text, on its own line when the original is. */
function sibling(src: string, el: SourceElement) {
  let open = src.slice(el.start, el.openEnd)
  if (el.id) {
    let cut = el.id[0]
    while (cut > el.start && /\s/.test(src[cut - 1])) cut--
    open = src.slice(el.start, cut) + src.slice(el.id[1], el.openEnd)
  }
  const outer = `${open}${PLACEHOLDER}</${src.slice(el.start + 1, el.nameEnd)}>`
  const lineStart = src.lastIndexOf('\n', el.start - 1) + 1
  const indent = src.slice(lineStart, el.start)
  if (!/^[ \t]*$/.test(indent)) return {text: outer, offset: 0}
  const nl = src[lineStart - 2] === '\r' ? '\r\n' : '\n'
  // An element without an end tag already ends on the next sibling's line.
  if (el.closeStart === el.end && /\n[ \t]*$/.test(src.slice(el.openEnd, el.end))) return {text: outer + nl + indent, offset: 0}
  return {text: nl + indent + outer, offset: nl.length + indent.length}
}

export function applyPreviewOp(src: string, op: PreviewOp, normalize: Normalize): PreviewResult {
  const found = locate(src, op, normalize)
  if ('error' in found) return found
  let {els, el} = found
  if (op.t === 'delete') {
    let a = el.start, b = el.end
    const lineStart = src.lastIndexOf('\n', a - 1) + 1
    const newline = src.indexOf('\n', b)
    const lineEnd = newline < 0 ? src.length : newline + 1
    // Take the whole line when the element sits on its own line.
    if (/^[ \t]*$/.test(src.slice(lineStart, a)) && /^[ \t\r]*\n?$/.test(src.slice(b, lineEnd))) { a = lineStart; b = lineEnd }
    const step = replaceRegion(src, els, a, b, '', 'remove', op.i, normalize)
    return {content: step.content, patches: step.patch && [step.patch]}
  }
  let content = src
  const patches: (PreviewPatch | null)[] = []
  if (op.t === 'commit') {
    if (typeof op.after !== 'string') return {error: '수정 내용을 읽지 못했습니다.'}
    const step = replaceRegion(content, els, el.openEnd, el.closeStart, op.after, 'inner', op.i, normalize)
    content = step.content; els = step.els
    patches.push(step.patch)
    if (!op.add) return {content, patches: step.patch && [step.patch]}
    el = els[op.i]
    if (!el || el.tag !== op.tag) return {content, patches: null}
  }
  const {text, offset} = sibling(content, el)
  const step = replaceRegion(content, els, el.end, el.end, text, 'after', op.i, normalize)
  patches.push(step.patch)
  const focus = step.els.findIndex(e => e.start === el.end + offset)
  const complete = patches.every((patch): patch is PreviewPatch => patch !== null)
  return {content: step.content, patches: complete ? patches as PreviewPatch[] : null, focus: complete && focus >= 0 ? focus : undefined}
}
