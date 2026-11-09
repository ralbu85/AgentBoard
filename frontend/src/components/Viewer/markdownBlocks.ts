import {Marked, Renderer, type Links, type MarkedExtension, type Token, type TokenizerAndRendererExtension, type Tokens} from 'marked'
import markedKatex from 'marked-katex-extension'
import {finishHtml, toggleTaskLine, type MarkdownAttachments} from '../../markdown'

// Click-to-edit for rendered Markdown and Quarto. Each block element carries
// data-mb="k" and blocks[k] names the source range it came from. Editing shows
// that block's own markdown (rendered text would lose emphasis, math and
// citations) and writes back only that range.

export type BlockKind = 'paragraph' | 'heading' | 'item' | 'code' | 'table' | 'math' | 'quote' | 'div' | 'html' | 'hr' | 'meta'

export interface MdBlock {
  kind: BlockKind
  start: number        // [start, end) is what the editor replaces
  end: number
  next: number         // end of the whole block, an item's sub-items included
  raw: string          // src.slice(start, end) at render time
  full: string         // src.slice(start, next) at render time
  text: string         // what the editor shows: nested-line prefixes removed
  lead: string         // prefix of the block's first line (its container's)
  cont: string         // prefix for further lines that have no source line yet
  prefixes: string[]   // the source's own prefix of each further line (kept as is)
  multiline: boolean   // Enter types a newline (code, tables, divs) instead of saving
  sibling: string      // first-line prefix of a same-level addition ('## ', '- ', '')
  blank: boolean       // additions are separated by a blank line
}
export interface MdRender { html: string; blocks: MdBlock[]; links: Links }   // links: the document's [ref]: definitions

export const isQuarto = (path: string) => /\.(qmd|rmd)$/i.test(path)

type Tok = Token & {_mb?: number; [key: string]: any}
// A container's text: `abs` maps an offset in it to the source, `local` to the
// parent container's text.
interface Seg { abs: (o: number) => number; local: (o: number) => number; cont: string }

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const lineStarts = (s: string) => { const out = [0]; for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) out.push(i + 1); return out }
const lineAt = (starts: number[], o: number) => {
  let lo = 0, hi = starts.length - 1
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= o) lo = mid; else hi = mid - 1 }
  return lo
}
const joined = (tokens: Tok[]) => tokens.map(t => t.raw).join('')

/** List items and quotes lex their children from text with each line's prefix
 *  (marker, indent, "> ") removed. Map that text back line by line; null when a
 *  line is not a plain prefix removal (expanded tabs and the like). */
function stripped(raw: string, text: string, at: number, parent: Seg, cont: string): Seg | null {
  const rawLines = raw.split('\n'), textLines = text.split('\n')
  if (textLines.length > rawLines.length) return null
  const rawStart: number[] = [], cut: number[] = []
  let pos = 0
  for (let j = 0; j < rawLines.length; j++) {
    rawStart.push(pos); pos += rawLines[j].length + 1
    if (j >= textLines.length) { if (rawLines[j].trim()) return null; continue }
    if (!rawLines[j].endsWith(textLines[j])) return null
    cut.push(rawLines[j].length - textLines[j].length)
  }
  const starts = lineStarts(text)
  const local = (o: number) => { const j = lineAt(starts, o); return at + rawStart[j] + cut[j] + o - starts[j] }
  return {cont, local, abs: o => parent.abs(local(o))}
}

class Builder {
  blocks: MdBlock[] = []
  constructor(readonly src: string) {}
  /** Register `text` (segment coordinates, starting at offset o) as a block —
   *  only when every line of it is found where the mapping says. */
  add(tok: Tok, seg: Seg, o: number, text: string, kind: BlockKind, opts: {full?: string; show?: string; cont?: string; multiline?: boolean; sibling?: string; blank?: boolean} = {}) {
    const t = text.trimEnd(), whole = (opts.full ?? text).trimEnd()
    if (!t) return
    let k = o
    for (const line of whole.split('\n')) {
      const a = seg.abs(k)
      if (this.src.slice(a, a + line.length) !== line) return
      k += line.length + 1
    }
    const start = seg.abs(o), end = seg.abs(o + t.length - 1) + 1, next = seg.abs(o + whole.length - 1) + 1
    // Whatever precedes each shown line in the source (">>", "   ", a lazy
    // nothing) is written back unchanged.
    const shown = opts.show ?? t, prefixes: string[] = []
    let nl = this.src.indexOf('\n', start)
    for (const line of shown.split('\n').slice(1)) {
      const from = nl + 1, to = this.src.indexOf('\n', from), source = this.src.slice(from, Math.min(to < 0 ? end : to, end))
      if (!source.endsWith(line)) return
      prefixes.push(source.slice(0, source.length - line.length))
      nl = to
    }
    tok._mb = this.blocks.length
    this.blocks.push({kind, start, end, next, raw: this.src.slice(start, end), full: this.src.slice(start, next), text: shown, lead: seg.cont, cont: opts.cont ?? seg.cont,
      prefixes, multiline: !!opts.multiline, sibling: opts.sibling ?? '', blank: opts.blank ?? true})
  }
}

function walk(b: Builder, tokens: Tok[], text: string, seg: Seg, skipFirst = false) {
  let o = 0, skip = skipFirst
  for (const tok of tokens) {
    if (!text.startsWith(tok.raw, o)) return   // the rest of this container stays read-only
    if (skip && tok.type !== 'space' && tok.type !== 'checkbox') skip = false
    else visit(b, tok, seg, o)
    o += tok.raw.length
  }
}

function visit(b: Builder, tok: Tok, seg: Seg, o: number) {
  switch (tok.type) {
    case 'paragraph': b.add(tok, seg, o, tok.raw, 'paragraph'); break
    case 'heading': b.add(tok, seg, o, tok.raw, 'heading', {sibling: '#'.repeat(tok.depth) + ' '}); break
    case 'code': b.add(tok, seg, o, tok.raw, 'code', {multiline: true}); break
    case 'table': b.add(tok, seg, o, tok.raw, 'table', {multiline: true}); break
    case 'blockKatex': b.add(tok, seg, o, tok.raw, 'math', {multiline: true}); break
    case 'hr': b.add(tok, seg, o, tok.raw, 'hr'); break
    case 'html': if (tok.block && /^\s*<[a-z]/i.test(tok.raw)) b.add(tok, seg, o, tok.raw, 'html', {multiline: true}); break
    case 'blockquote': {
      b.add(tok, seg, o, tok.raw, 'quote', {multiline: true})
      const children = tok.tokens as Tok[], body = joined(children), inner = stripped(tok.raw, body, o, seg, seg.cont + '> ')
      if (inner) walk(b, children, body, inner)
      break
    }
    case 'qdiv': {
      b.add(tok, seg, o, tok.raw, 'div', {multiline: true})
      const open = o + tok.raw.indexOf('\n') + 1
      walk(b, tok.tokens as Tok[], tok.text, {cont: seg.cont, local: k => open + k, abs: k => seg.abs(open + k)})
      break
    }
    case 'list': {
      let k = 0
      for (const item of tok.items as Tok[]) {
        if (!tok.raw.startsWith(item.raw, k)) return
        visitItem(b, tok, item, seg, o + k)
        k += item.raw.length
      }
      break
    }
  }
}

function visitItem(b: Builder, list: Tok, item: Tok, seg: Seg, o: number) {
  const children = item.tokens as Tok[], body = joined(children)
  const marker = /^ *([-*+]|(\d{1,9})([.)]))( +|$)/.exec(item.raw)
  const pad = ' '.repeat(marker ? marker[0].length : 2), cont = seg.cont + pad
  const inner = stripped(item.raw, body, o, seg, cont)
  // The item's own text ends where its second piece of content (a sub-list,
  // a further paragraph) begins; those are blocks of their own.
  let head = item.raw
  if (inner) {
    let k = 0, seen = false
    for (const c of children) {
      if (c.type !== 'space' && c.type !== 'checkbox') {
        if (seen) { head = item.raw.slice(0, inner.local(k) - o); break }
        seen = true
      }
      k += c.raw.length
    }
  }
  const sibling = !marker ? '- ' : marker[2] ? `${+marker[2] + 1}${marker[3]} ` : `${marker[1]} `
  // Continuation lines are shown without the item's own indent.
  const show = head.trimEnd().split('\n').map((l, k) => k === 0 ? l : l.startsWith(pad) ? l.slice(pad.length) : l.trimStart()).join('\n')
  b.add(item, seg, o, head, 'item', {full: item.raw, show, cont, sibling: sibling + (item.task ? '[ ] ' : ''), blank: !!list.loose})
  if (inner) walk(b, children, body, inner, true)
}

// ── Quarto syntax ──

const DIV_OPEN = /^ {0,3}:{3,}[ \t]*(\{[^{}\n]*\}|[A-Za-z][\w-]*)[ \t]*:*[ \t]*$/
const DIV_CLOSE = /^ {0,3}:{3,}[ \t]*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})/
export const ATTRS = /(?=[.#]|[\w-]+=)[^{}<>\n]*/.source
const CALLOUT_TITLE: Record<string, string> = {note: 'Note', tip: 'Tip', warning: 'Warning', important: 'Important', caution: 'Caution'}

interface Attrs { id: string; classes: string[]; kv: Record<string, string> }
function parseAttrs(spec: string): Attrs {
  const out: Attrs = {id: '', classes: [], kv: {}}
  if (!spec.startsWith('{')) { out.classes.push(spec); return out }
  for (const m of spec.slice(1, -1).matchAll(/([.#])([\w:-]+)|([\w-]+)=(?:"([^"]*)"|'([^']*)'|([^\s}]+))/g)) {
    if (m[1] === '.') out.classes.push(m[2])
    else if (m[1] === '#') out.id = m[2]
    else out.kv[m[3]] = m[4] ?? m[5] ?? m[6]
  }
  return out
}

const stripAttrs = (html: string) => html.replace(new RegExp(String.raw`\s*\{${ATTRS}\}(?=\s*(?:<\/h[1-6]>|$))`), '')
const mark = (html: string, tok: Tok) => tok._mb === undefined ? html : html.replace(/^(\s*<[a-zA-Z][\w-]*)/, `$1 data-mb="${tok._mb}"`)

const fencedDiv: TokenizerAndRendererExtension = {
  name: 'qdiv', level: 'block',
  start(src) { return /^ {0,3}:{3,}/m.exec(src)?.index },
  tokenizer(src) {
    const first = src.indexOf('\n')
    const open = first < 0 ? null : DIV_OPEN.exec(src.slice(0, first))
    if (!open) return
    let pos = first + 1, depth = 1, fence = ''
    while (pos < src.length) {
      const nl = src.indexOf('\n', pos), line = src.slice(pos, nl < 0 ? src.length : nl)
      if (fence) {
        const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)
        if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = ''
      } else if (FENCE.test(line)) fence = FENCE.exec(line)![1]
      else if (DIV_OPEN.test(line)) depth++
      else if (DIV_CLOSE.test(line) && !--depth) {
        const token: Tok = {type: 'qdiv', raw: src.slice(0, nl < 0 ? src.length : nl + 1), text: src.slice(first + 1, pos), attrs: parseAttrs(open[1]), tokens: []} as Tok
        this.lexer.blockTokens(token.text, token.tokens)
        return token
      }
      if (nl < 0) break
      pos = nl + 1
    }
  },
  renderer(token) {
    const tok = token as Tok, {id, classes, kv} = tok.attrs as Attrs
    const mb = tok._mb === undefined ? '' : ` data-mb="${tok._mb}"`
    const callout = classes.map(c => /^callout-(note|tip|warning|important|caution)$/.exec(c)).find(Boolean)
    if (callout) {
      let body = tok.tokens as Tok[], title = kv.title ? esc(kv.title) : ''
      const first = body.findIndex(t => t.type !== 'space')
      if (!title && body[first]?.type === 'heading') {   // Quarto takes a leading heading as the title
        const h = body[first]
        title = `<span class="qmd-callout-heading"${h._mb === undefined ? '' : ` data-mb="${h._mb}"`}>${stripAttrs(this.parser.parseInline(h.tokens as Token[]))}</span>`
        body = body.filter((_, k) => k !== first)
      }
      const look = kv.appearance === 'minimal' || kv.appearance === 'simple' ? kv.appearance : 'default'
      const cls = `qmd-callout qmd-callout-${callout[1]} qmd-callout-${look}${kv.icon === 'false' ? ' qmd-callout-noicon' : ''}`
      const head = title || esc(CALLOUT_TITLE[callout[1]]), inner = this.parser.parse(body)
      if (kv.collapse === 'true' || kv.collapse === 'false')
        return `<details class="${cls}"${mb}${kv.collapse === 'false' ? ' open' : ''}><summary class="qmd-callout-title">${head}</summary><div class="qmd-callout-body">${inner}</div></details>\n`
      return `<div class="${cls}"${mb}><div class="qmd-callout-title">${head}</div><div class="qmd-callout-body">${inner}</div></div>\n`
    }
    const inner = this.parser.parse(tok.tokens)
    if (classes.includes('columns')) return `<div class="qmd-columns"${mb}>${inner}</div>\n`
    if (classes.includes('column')) {
      const width = /^\d+(?:\.\d+)?%$/.test(kv.width ?? '') ? ` style="flex:0 1 ${kv.width}"` : ''
      return `<div class="qmd-column"${mb}${width}>${inner}</div>\n`
    }
    const cond = classes.find(c => /^content-(visible|hidden)$/.test(c))
    const label = classes.includes('notes') ? '발표자 노트'
      : cond ? [cond, ...Object.entries(kv).filter(([k]) => /^(when|unless)-/.test(k)).map(([k, v]) => `${k}=${v}`)].join(' ')
      : [id && '#' + id, ...classes.map(c => '.' + c)].filter(Boolean).join(' ')
    const cls = classes.includes('notes') ? 'qmd-div qmd-notes' : cond ? 'qmd-div qmd-cond' : 'qmd-div'
    return `<div class="${cls}"${mb} data-label="${esc(label)}">${inner}</div>\n`
  },
}

const SPAN = new RegExp(String.raw`^\[((?:\\.|[^\[\]\\\n]|\[(?:\\.|[^\[\]\\\n])*\])*)\]\{(${ATTRS})\}`)
const span: TokenizerAndRendererExtension = {
  name: 'qspan', level: 'inline',
  start(src) { const k = src.indexOf('['); return k < 0 ? undefined : k },
  tokenizer(src) {
    const m = SPAN.exec(src)
    if (m) return {type: 'qspan', raw: m[0], attrs: parseAttrs(`{${m[2]}}`), tokens: this.lexer.inlineTokens(m[1])}
    // Citations: [@key], [see @key, p. 3; @other]
    const c = /^\[((?:\\.|[^\[\]\\\n])*)\]/.exec(src)
    if (c && /(?:^|[\s;-])@\w/.test(c[1]) && !/^[([{:]/.test(src.slice(c[0].length))) return {type: 'qcite', raw: c[0]}
  },
  renderer(token) {
    const {classes} = token.attrs as Attrs, inner = this.parser.parseInline(token.tokens!)
    if (classes.includes('underline')) return `<u>${inner}</u>`
    if (classes.includes('mark')) return `<mark>${inner}</mark>`
    return `<span class="qmd-span${classes.includes('smallcaps') ? ' qmd-smallcaps' : ''}">${inner}</span>`
  },
}
const cite: TokenizerAndRendererExtension = {name: 'qcite', level: 'inline', renderer: token => `<span class="qmd-cite">${esc(token.raw)}</span>`}
const XREF = /@(?:fig|tbl|sec|eq|lst|thm|lem|cor|prp|cnj|def|exm|exr|rem|alg|nte|tip|wrn|imp|cau)-\w[\w-]*/
const XREF_AT = new RegExp(`(^|[^\\w@.])${XREF.source}`), XREF_HERE = new RegExp(`^${XREF.source}`)
const xref: TokenizerAndRendererExtension = {
  name: 'qxref', level: 'inline',
  start(src) { const m = XREF_AT.exec(src); return m ? m.index + m[1].length : undefined },
  tokenizer(src) { const m = XREF_HERE.exec(src); if (m) return {type: 'qxref', raw: m[0]} },
  renderer: token => `<span class="qmd-xref">${esc(token.raw)}</span>`,
}
const shortcode: TokenizerAndRendererExtension = {
  name: 'qshort', level: 'inline',
  start(src) { const k = src.indexOf('{{<'); return k < 0 ? undefined : k },
  tokenizer(src) { const m = /^\{\{<\s*([\s\S]*?)\s*>\}\}/.exec(src); if (m) return {type: 'qshort', raw: m[0], text: m[1]} },
  renderer: token => `<span class="qmd-short">${esc(token.text)}</span>`,
}

const cellOptions = (code: string) => {
  const out: Record<string, string> = {}
  for (const line of code.split('\n')) {
    const m = /^(?:#|\/\/|%%)\|\s*([\w-]+)\s*:\s*(.*?)\s*$/.exec(line)
    if (!m) break
    out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2')
  }
  return out
}

function build(quarto: boolean): Marked {
  const md = new Marked()
  const katex = markedKatex({throwOnError: false, nonStandard: true})
  for (const ext of katex.extensions || []) {
    if (ext.name !== 'blockKatex' || !('renderer' in ext)) continue
    const render = ext.renderer
    ext.renderer = function (token) { return mark(`<div class="qmd-math">${render.call(this, token)}</div>\n`, token as Tok) }
  }
  md.use(katex)
  md.use({gfm: true, breaks: !quarto})
  md.use({extensions: quarto ? [fencedDiv, span, cite, xref, shortcode] : [fencedDiv]})
  const renderer: MarkedExtension['renderer'] = {
    paragraph(t) { return mark(Renderer.prototype.paragraph.call(this, t), t as Tok) },
    heading(t) { return mark(stripAttrs(Renderer.prototype.heading.call(this, t)), t as Tok) },
    blockquote(t) { return mark(Renderer.prototype.blockquote.call(this, t), t as Tok) },
    table(t) { return mark(Renderer.prototype.table.call(this, t), t as Tok) },
    hr(t) { return mark(Renderer.prototype.hr.call(this, t), t as Tok) },
    listitem(t) { return mark(Renderer.prototype.listitem.call(this, t), t as Tok) },
    html(t) { return t.block ? mark(t.text, t as Tok) : false },
    code(t) {
      const cell = /^\{([=\w.+-]+)[^}]*\}$/.exec(t.lang?.trim() || '')
      if (!cell) return mark(Renderer.prototype.code.call(this, t), t as Tok)
      const engine = cell[1].toLowerCase(), lang = engine.replace(/^=/, '')
      if (engine === '=html') return mark(`<div class="qmd-raw-html">${t.text}</div>\n`, t as Tok)
      const opts = cellOptions(t.text), pre = Renderer.prototype.code.call(this, {...t, lang} as Tokens.Code)
      const hidden = engine.startsWith('=') || engine === 'ojs' || opts.echo === 'false' || opts.include === 'false'
      const label = engine.startsWith('=') ? `${lang} 원본 블록 · Quarto 렌더 결과에만 들어갑니다`
        : engine === 'ojs' ? 'OJS 대화형 셀 · 결과는 Quarto 렌더에서 보입니다'
        : `${lang} 셀${hidden ? ' · 코드 숨김' : ''}${opts['fig-cap'] ? ' · ' + opts['fig-cap'] : ''}`
      return mark(hidden ? `<details class="qmd-cell"><summary>${esc(label)}</summary>${pre}</details>\n`
        : `<div class="qmd-cell"><div class="qmd-cell-label">${esc(label)}</div>${pre}</div>\n`, t as Tok)
    },
  }
  md.use({renderer})
  // Pandoc's smart punctuation, as Quarto renders it.
  if (quarto) md.use({walkTokens(t) { if (t.type === 'text' && !('tokens' in t && t.tokens) && !(t as Tok).escaped) t.text = t.text.replace(/---/g, '—').replace(/--/g, '–') }})
  return md
}
const instances = new Map<boolean, Marked>()
export const instance = (quarto: boolean) => { let md = instances.get(quarto); if (!md) instances.set(quarto, md = build(quarto)); return md }

/** YAML front matter: `---` on the first line through the next `---`/`...`. */
function frontMatter(src: string): {yaml: string; end: number} | null {
  if (!/^---[ \t]*\n/.test(src)) return null
  let pos = src.indexOf('\n') + 1
  const body = pos
  while (pos < src.length) {
    const nl = src.indexOf('\n', pos), line = src.slice(pos, nl < 0 ? src.length : nl)
    if (/^(?:---|\.\.\.)[ \t]*$/.test(line)) {
      const yaml = src.slice(body, pos)
      return /^\s*[\w-]+\s*:/.test(yaml) ? {yaml, end: pos + line.length} : null
    }
    if (nl < 0) break
    pos = nl + 1
  }
  return null
}
function metaHtml(yaml: string, mb: number | undefined): string {
  const field = (key: string) => (new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(yaml)?.[1] || '').trim().replace(/^(["'])(.*)\1$/, '$2')
  let author = field('author')
  if (!author) {   // author:\n  - name: A\n  - B
    const list = /^author:[ \t]*\n((?:[ \t]+.*\n?)*)/m.exec(yaml)?.[1] || ''
    author = [...list.matchAll(/^[ \t]*-[ \t]*(?:name:[ \t]*)?(.+)$/gm)].map(m => m[1].trim().replace(/^(["'])(.*)\1$/, '$2')).join(', ')
  }
  const title = field('title'), subtitle = field('subtitle'), by = [author, field('date')].filter(Boolean).join(' · ')
  return `<header class="qmd-meta"${mb === undefined ? '' : ` data-mb="${mb}"`}>${title ? `<h1 class="qmd-meta-title">${esc(title)}</h1>` : ''}`
    + `${subtitle ? `<p class="qmd-meta-subtitle">${esc(subtitle)}</p>` : ''}${by ? `<p class="qmd-meta-by">${esc(by)}</p>` : ''}`
    + `<details class="qmd-meta-yaml"><summary>문서 설정 (YAML)</summary><pre><code>${esc(yaml)}</code></pre></details></header>\n`
}

// Pandoc attributes after images, links and spans: `![](a.png){width=60%}`.
export function inlineAttrs(html: string): string {
  return html
    .replace(new RegExp(String.raw`(<img\b[^>]*?)>\{(${ATTRS})\}`, 'g'), (_, img: string, spec: string) => {
      const w = /width=(?:&quot;|")?(\d+(?:\.\d+)?)(%|px|em|in)?/.exec(spec)
      return w ? `${img} style="width:${w[1]}${w[2] || 'px'}">` : `${img}>`
    })
    .replace(new RegExp(String.raw`(<\/(?:a|code|span|em|strong)>)\{${ATTRS}\}`, 'g'), '$1')
}

/** `tasks`: task boxes in editable items can be clicked (the caller saves). */
export function renderBlocks(src: string, {filePath, quarto, tasks = true, attachments}: {filePath?: string; quarto: boolean; tasks?: boolean; attachments?: MarkdownAttachments}): MdRender {
  const md = instance(quarto), b = new Builder(src)
  // marked rewrites CRLF, so offsets would drift: such files render read-only.
  const editable = !src.includes('\r')
  const fm = frontMatter(src)
  let head = '', base = 0
  if (fm) {
    const text = src.slice(0, fm.end)
    const tok = {type: 'meta', raw: text} as Tok
    if (editable) b.add(tok, {abs: o => o, local: o => o, cont: ''}, 0, text, 'meta', {multiline: true})
    head = metaHtml(fm.yaml, tok._mb)
    base = fm.end
  }
  const body = src.slice(base), tokens = md.lexer(body) as Tok[]
  if (md.defaults.walkTokens) md.walkTokens(tokens, md.defaults.walkTokens)   // Quarto's smart dashes
  if (editable) walk(b, tokens, body, {abs: o => base + o, local: o => o, cont: ''})
  const html = finishHtml(inlineAttrs(head + md.parser(tokens)), filePath, attachments, root => {
    if (tasks) for (const box of root.querySelectorAll('input[type="checkbox"]')) if (box.closest('li')?.hasAttribute('data-mb')) box.removeAttribute('disabled')
  })
  return {html, blocks: editable ? b.blocks : [], links: (tokens as Token[] & {links?: Links}).links || {}}
}

// ── Edits ──

/** Prefix each line after the first: with its source prefix while it is still
 *  that kind of line (blank or not), else with the block's continuation. */
function indent(text: string, b: Pick<MdBlock, 'text' | 'cont' | 'prefixes'>) {
  const before = b.text.split('\n')
  return text.split('\n').map((l, k) => {
    if (k === 0) return l
    const blank = !l.trim()
    if (k < before.length && blank === !before[k].trim()) return b.prefixes[k - 1] + l
    return (blank ? b.cont.trimEnd() : b.cont) + l
  }).join('\n')
}

/** Where `b` is in `src` now: its own range if untouched, else its only copy. */
export function locateBlock(src: string, b: MdBlock): MdBlock | null {
  if (src.slice(b.start, b.next) === b.full) return b
  const at = src.indexOf(b.full)
  if (at < 0 || src.indexOf(b.full, at + 1) >= 0) return null
  const d = at - b.start
  return {...b, start: b.start + d, end: b.end + d, next: b.next + d}
}

export function replaceBlock(src: string, b: MdBlock, text: string): string {
  return src.slice(0, b.start) + indent(text.trimEnd(), b) + src.slice(b.end)
}

export function deleteBlock(src: string, b: MdBlock): string {
  let from = b.start, to = b.next
  const ls = src.lastIndexOf('\n', from - 1) + 1, nl = src.indexOf('\n', to)
  if (/^[ \t>]*$/.test(src.slice(ls, from)) && !src.slice(to, nl < 0 ? src.length : nl).trim()) {   // the block owns its lines
    // Last block of the file: the blank lines before it go too.
    if (nl < 0) return src.slice(0, ls).replace(/\n(?:[ \t>]*\n)*$/, '')
    from = ls; to = nl + 1
  }
  const before = src.slice(0, from), after = src.slice(to)
  // Removing a block between blank lines would leave two in a row.
  if ((before === '' || /(?:^|\n)[ \t>]*\n$/.test(before)) && /^[ \t>]*\n/.test(after)) return before + after.replace(/^[ \t>]*\n/, '')
  return before + after
}

/** Add `text` as a same-level sibling after `b`; `at` is where it starts. */
export function insertAfter(src: string, b: MdBlock, text: string): {content: string; at: number} {
  const blankLine = '\n' + b.lead.trimEnd()
  const lead = (b.blank ? blankLine : '') + '\n' + b.lead
  const rest = src.slice(b.next)
  // A following line right below would otherwise run into the new block.
  const tail = b.blank && /^\n(?![ \t>]*(?:\n|$))/.test(rest) ? blankLine : ''
  return {content: src.slice(0, b.next) + lead + indent(text.trimEnd(), {text: '', cont: b.cont, prefixes: []}) + tail + rest, at: b.next + lead.length}
}

export function toggleTask(src: string, b: MdBlock): string {
  let line = 0
  for (let i = src.indexOf('\n'); i >= 0 && i < b.start; i = src.indexOf('\n', i + 1)) line++
  return toggleTaskLine(src, line)
}
