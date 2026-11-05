import type {Links, Token} from 'marked'
import {finishHtml} from '../../markdown'
import {ATTRS, esc, inlineAttrs, instance, type MdBlock} from './markdownBlocks'

// Editing a paragraph, heading or list item where it is rendered. The block's
// inline markdown is lexed again into pieces that each know their source:
//   text    edited in place, written back through a character map (so an
//           entity, an escape or a smart dash next to the edit survives)
//   wraps   bold, italics, links, code: their markers stay around whatever
//           text is left inside them
//   atoms   math, citations, images, line breaks: kept whole or deleted whole
// The pieces are rendered with the document's own renderer; when they don't
// reproduce the text on screen, the block opens as markdown instead.

type Tok = Token & {[key: string]: any}
interface Seg { raw: string; text: string; map: number[] | null }
interface Wrap { open: string; close: string; code: boolean }
export interface InlineModel {
  prefix: string   // block source before the inline text: '## ', '- [ ] '
  suffix: string   // after it: ' {#sec-intro}', a setext underline
  html: string     // the editing markup (data-ms text, data-mw wraps, data-ma atoms)
  text: string     // what it shows
  segs: Seg[]; wraps: Wrap[]; atoms: string[]
  nbsp: boolean    // the source has non-breaking spaces of its own
}

export const INLINE_KINDS = new Set(['paragraph', 'heading', 'item'])
const MARK = '\uE000'
const ATTR_HEAD = new RegExp(String.raw`^\{${ATTRS}\}`)
const ATTR_AFTER = new Set(['link', 'image', 'codespan', 'qspan', 'em', 'strong'])

const plain = (html: string) => { const t = document.createElement('template'); t.innerHTML = html; return t.content.textContent || '' }
const decode = (entity: string) => { const t = document.createElement('textarea'); t.innerHTML = entity; return t.value }
export const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()

/** Rendered offset → source offset for one text piece (length text.length + 1),
 *  or null when the two can't be lined up character by character. */
function align(raw: string, text: string): number[] | null {
  if (raw === text) return Array.from({length: text.length + 1}, (_, k) => k)
  const map: number[] = []
  let i = 0
  for (let j = 0; j < text.length; j++) {
    map.push(i)
    const entity = raw[i] === '&' ? /^&(?:#\d+|#x[\da-f]+|\w+);/i.exec(raw.slice(i)) : null
    if (entity && decode(entity[0]) === text[j]) { i += entity[0].length; continue }
    if (raw[i] === text[j]) i++
    else if (raw[i] === '\\' && raw[i + 1] === text[j]) i += 2
    else if (text[j] === '—' && raw.startsWith('---', i)) i += 3
    else if (text[j] === '–' && raw.startsWith('--', i)) i += 2
    else return null
  }
  if (i !== raw.length) return null
  map.push(i)
  return map
}

/** The block's source around its inline text. */
function frame(b: MdBlock): {prefix: string; content: string; suffix: string} | null {
  const t = b.text
  if (b.kind === 'paragraph') return {prefix: '', content: t, suffix: ''}
  if (b.kind === 'item') {
    const m = /^ *(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/.exec(t)
    return m && t.slice(m[0].length).trim() ? {prefix: m[0], content: t.slice(m[0].length), suffix: ''} : null
  }
  if (b.kind !== 'heading') return null
  let prefix = '', content = '', suffix = ''
  const atx = /^( {0,3}#{1,6}[ \t]+)(.*?)((?:[ \t]+#+)?[ \t]*)$/.exec(t)
  if (atx && !t.includes('\n')) [prefix, content, suffix] = [atx[1], atx[2], atx[3]]
  else {
    const setext = /^([\s\S]+?)(\n[ \t]*(?:=+|-+)[ \t]*)$/.exec(t)
    if (!setext) return null
    content = setext[1]; suffix = setext[2]
  }
  const attrs = new RegExp(String.raw`[ \t]*\{${ATTRS}\}[ \t]*$`).exec(content)
  if (attrs) { suffix = content.slice(attrs.index) + suffix; content = content.slice(0, attrs.index) }
  return content.trim() ? {prefix, content, suffix} : null
}

export function inlineModel(b: MdBlock, {quarto, filePath, links}: {quarto: boolean; filePath?: string; links?: Links}): InlineModel | null {
  const f = frame(b)
  if (!f) return null
  const md = instance(quarto), lexer = new md.Lexer(md.defaults)
  Object.assign(lexer.tokens.links, links)   // [text][ref] resolves against the whole document
  const tokens = lexer.inlineTokens(f.content) as Tok[]
  if (tokens.map(t => t.raw).join('') !== f.content) return null
  if (md.defaults.walkTokens) md.walkTokens(tokens, md.defaults.walkTokens)
  const render = (toks: Tok[]) => md.Parser.parseInline(toks, md.defaults) as string
  const segs: Seg[] = [], wraps: Wrap[] = [], atoms: string[] = []
  const seg = (raw: string, text: string) => { segs.push({raw, text, map: align(raw, text)}); return `<span data-ms="${segs.length - 1}">${esc(text)}</span>` }
  const atom = (raw: string, html: string) => { atoms.push(raw); return `<span data-ma="${atoms.length - 1}">${html}</span>` }
  const wrap = (open: string, close: string, code: boolean, shell: string, inner: string) => {
    wraps.push({open, close, code})
    return shell.replace(MARK, () => inner).replace(/^(<[a-zA-Z][\w-]*)/, `$1 data-mw="${wraps.length - 1}"`)
  }

  function pieces(toks: Tok[]): string | null {
    let out = ''
    for (let k = 0; k < toks.length; k++) {
      let tok = toks[k]
      // Pandoc attributes after a link, span or image: `[a](b){.x}` shows nothing of them.
      if (tok.type === 'text' && k > 0 && ATTR_AFTER.has(toks[k - 1].type)) {
        const attrs = ATTR_HEAD.exec(tok.raw)
        if (attrs) {
          const shown = plain(render([tok]))
          if (!shown.startsWith(attrs[0])) return null
          if (toks[k - 1].type !== 'image') out += atom(attrs[0], '')
          if (tok.raw === attrs[0]) continue
          tok = {...tok, raw: tok.raw.slice(attrs[0].length), text: tok.text.slice(attrs[0].length)}
        }
      }
      switch (tok.type) {
        case 'text': case 'escape':
          if (tok.tokens) { const inner = pieces(tok.tokens); if (inner === null) return null; out += inner; break }
          out += seg(tok.raw, plain(render([tok])))
          break
        case 'strong': case 'em': case 'del': case 'link': case 'qspan': {
          const inner = tok.tokens as Tok[], joined = inner.map(t => t.raw).join(''), at = joined ? tok.raw.indexOf(joined, 1) : -1
          const shell = render([{...tok, tokens: [{type: 'text', raw: MARK, text: MARK}]} as Tok])
          const children = at < 0 ? null : pieces(inner)
          if (children === null || !shell.startsWith('<') || shell.split(MARK).length !== 2) { out += atom(tok.raw, render([tok])); break }
          out += wrap(tok.raw.slice(0, at), tok.raw.slice(at + joined.length), false, shell, children)
          break
        }
        case 'codespan': {
          const tick = /^`+/.exec(tok.raw)![0].length, at = tok.text ? tok.raw.indexOf(tok.text, tick) : -1
          if (at < 0) { out += atom(tok.raw, render([tok])); break }
          segs.push({raw: tok.text, text: tok.text, map: align(tok.text, tok.text)})
          out += wrap(tok.raw.slice(0, at), tok.raw.slice(at + tok.text.length), true, `<code>${MARK}</code>`, `<span data-ms="${segs.length - 1}">${esc(tok.text)}</span>`)
          break
        }
        case 'image': {
          const next = toks[k + 1], attrs = next?.type === 'text' ? ATTR_HEAD.exec(next.raw) : null
          out += atom(tok.raw + (attrs?.[0] || ''), attrs ? inlineAttrs(render([tok]) + attrs[0]) : render([tok]))
          break
        }
        case 'html': return null   // raw tags pair up across pieces; leave such a block to the markdown editor
        default: out += atom(tok.raw, render([tok]))   // math, citations, cross-references, line breaks
      }
    }
    return out
  }

  const body = pieces(tokens)
  if (body === null) return null
  const html = finishHtml(body, filePath)
  const model: InlineModel = {prefix: f.prefix, suffix: f.suffix, html, text: plain(html), segs, wraps, atoms, nbsp: f.content.includes('\u00a0')}
  // Opened and closed untouched, the block must read back as its own source, byte for byte.
  const probe = document.createElement('div')
  probe.innerHTML = html
  return readInline(model, probe) === b.text.replace(/\s+$/, '') ? model : null
}

/** `typed` cleans what was typed (the browser's non-breaking spaces). */
function segOut(s: Seg, now: string, typed: (text: string) => string): string {
  if (now === s.text) return s.raw
  if (!s.map) return typed(now)
  const n = now.length, m = s.text.length
  let p = 0, q = 0
  while (p < n && p < m && now[p] === s.text[p]) p++
  while (q < n - p && q < m - p && now[n - 1 - q] === s.text[m - 1 - q]) q++
  return s.raw.slice(0, s.map[p]) + typed(now.slice(p, n - q)) + s.raw.slice(s.map[m - q])
}

/** The edited markup back to the block's markdown: '' when no text is left. */
export function readInline(model: InlineModel, root: HTMLElement): string {
  const seen = new Set<string>()
  const space = (text: string) => model.nbsp ? text : text.replace(/\u00a0/g, ' ')
  const walk = (node: Node): string => {
    let out = ''
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) { out += space((child as Text).data); continue }
      if (!(child instanceof HTMLElement)) continue
      const {ms, ma, mw} = child.dataset
      // A piece the browser split in two: the second half is plain typed text.
      const first = (key: string) => !seen.has(key) && !!seen.add(key)
      if (ms !== undefined && first('s' + ms)) out += segOut(model.segs[+ms], child.textContent || '', space)
      else if (ma !== undefined) { if (first('a' + ma)) out += model.atoms[+ma] }
      else if (mw !== undefined && first('w' + mw)) {
        const w = model.wraps[+mw], inner = walk(child)
        // Bold around nothing goes; spaces typed at its edges move outside it. Code keeps its spaces.
        const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner)!
        out += w.code ? inner && w.open + inner + w.close : !inner.trim() ? inner : m[1] + w.open + m[2] + w.close + m[3]
      }
      else if (child.localName === 'br') out += '\n'
      else out += walk(child)
    }
    return out
  }
  const body = walk(root)
  return body.trim() ? model.prefix + body.replace(/\s+$/, '') + model.suffix : ''
}

/** Text typed into a new block. */
export function readTyped(root: HTMLElement): string {
  let out = ''
  for (const node of Array.from(root.childNodes)) out += node.nodeType === Node.TEXT_NODE ? (node as Text).data : node instanceof HTMLElement && node.localName === 'br' ? '\n' : readTyped(node as HTMLElement)
  return out.replace(/\u00a0/g, ' ')
}
