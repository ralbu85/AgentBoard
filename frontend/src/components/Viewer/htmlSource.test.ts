import {describe, expect, it} from 'vitest'
import {annotate, applyPreviewOp, buildDocument, parseElements, PLACEHOLDER} from './htmlSource'

const normalize = (html: string) => { const t = document.createElement('template'); t.innerHTML = html; return t.innerHTML }
const ordinalOf = (src: string, tag: string, nth = 0) => parseElements(src).map((e, k) => ({e, k})).filter(x => x.e.tag === tag)[nth].k
const strip = (html: string) => html.replace(/ data-ab-i="\d+"/g, '')

const deck = [
  '<!doctype html>',
  '<html lang="ko">',
  '<head><title>발표</title><style>li{color:red}</style></head>',
  '<body>',
  '  <section class="slide">',
  '    <h2 id="t">목표</h2>',
  '    <ul>',
  '      <li class="pt" id="first">첫째 &amp; 하나</li>',
  '      <li class="pt">둘째 <strong>강조</strong></li>',
  '    </ul>',
  '  </section>',
  '</body>',
  '</html>',
].join('\n')

describe('HTML source mapping', () => {
  it('annotates every start tag without touching anything else', () => {
    const els = parseElements(deck)
    const doc = annotate(deck, els)
    expect(strip(doc)).toBe(deck)
    expect(doc).toContain(`<li data-ab-i="${ordinalOf(deck, 'li', 1)}" class="pt">둘째`)
    // <html>/<head> merge into the elements the preview head already opened,
    // exactly as in the iframe, so they get no ordinal of their own.
    expect(els.map(e => e.tag)).toEqual(['title', 'style', 'body', 'section', 'h2', 'ul', 'li', 'li', 'strong'])
  })

  it('builds a sandboxed document whose runtime cannot be closed early', () => {
    const doc = buildDocument(deck, {token: 't', edit: true, restore: {x: 0, y: 0, hash: '#</script><b>', scrolls: []}})
    expect(doc.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"')).toBe(true)
    expect(doc.match(/<\/script/gi)).toHaveLength(1)
    expect(doc).toContain('\\u003c/script>')
  })

  it('replaces only the edited element text', () => {
    const i = ordinalOf(deck, 'li')
    const result = applyPreviewOp(deck, {t: 'commit', i, tag: 'li', before: '첫째 &amp; 하나', after: '첫째 &amp; 바뀜'}, normalize)
    if ('error' in result) throw Error(result.error)
    expect(result.content).toBe(deck.replace('첫째 &amp; 하나', '첫째 &amp; 바뀜'))
    expect(result.patches).toEqual([{kind: 'inner', i, from: i + 1, delta: 0, html: '첫째 &amp; 바뀜'}])
  })

  it('re-annotates inline children and shifts later ordinals when they change', () => {
    const i = ordinalOf(deck, 'li', 1)
    const kept = applyPreviewOp(deck, {t: 'commit', i, tag: 'li', before: '둘째 <strong>강조</strong>', after: '둘째 <strong>핵심</strong>'}, normalize)
    if ('error' in kept) throw Error(kept.error)
    expect(kept.patches?.[0]).toMatchObject({from: i + 2, delta: 0, html: `둘째 <strong data-ab-i="${i + 1}">핵심</strong>`})
    const dropped = applyPreviewOp(deck, {t: 'commit', i, tag: 'li', before: '둘째 <strong>강조</strong>', after: '둘째'}, normalize)
    if ('error' in dropped) throw Error(dropped.error)
    expect(dropped.patches?.[0]).toMatchObject({from: i + 2, delta: -1, html: '둘째'})
  })

  it('adds a same-level sibling on its own line without copying the id', () => {
    const src = deck.replace(/\n/g, '\r\n')
    const i = ordinalOf(src, 'li')
    const result = applyPreviewOp(src, {t: 'add', i, tag: 'li', before: '첫째 &amp; 하나'}, normalize)
    if ('error' in result) throw Error(result.error)
    expect(result.content).toContain(`<li class="pt" id="first">첫째 &amp; 하나</li>\r\n      <li class="pt">${PLACEHOLDER}</li>\r\n      <li class="pt">둘째`)
    expect(result.focus).toBe(i + 1)
    expect(result.patches).toEqual([{kind: 'after', i, from: i + 1, delta: 1, html: `\r\n      <li data-ab-i="${i + 1}" class="pt">${PLACEHOLDER}</li>`}])
    expect(parseElements(result.content)[i + 2].tag).toBe('li')
  })

  it('saves the text and adds the sibling in one step', () => {
    const i = ordinalOf(deck, 'h2')
    const result = applyPreviewOp(deck, {t: 'commit', add: true, i, tag: 'h2', before: '목표', after: '목적'}, normalize)
    if ('error' in result) throw Error(result.error)
    expect(result.content).toContain(`<h2 id="t">목적</h2>\n    <h2>${PLACEHOLDER}</h2>\n    <ul>`)
    expect(result.patches?.map(p => p.kind)).toEqual(['inner', 'after'])
    expect(result.focus).toBe(i + 1)
  })

  it('keeps implied end tags readable when adding', () => {
    const src = '<ul>\n  <li>a\n  <li>b\n</ul>'
    const result = applyPreviewOp(src, {t: 'add', i: 1, tag: 'li', before: 'a\n  '}, normalize)
    if ('error' in result) throw Error(result.error)
    expect(result.content).toBe(`<ul>\n  <li>a\n  <li>${PLACEHOLDER}</li>\n  <li>b\n</ul>`)
    expect(result.focus).toBe(2)
  })

  it('deletes the whole line of an element that sits alone on it', () => {
    const i = ordinalOf(deck, 'li', 1)
    const result = applyPreviewOp(deck, {t: 'delete', i, tag: 'li', before: '둘째 <strong>강조</strong>'}, normalize)
    if ('error' in result) throw Error(result.error)
    expect(result.content).toBe(deck.replace('      <li class="pt">둘째 <strong>강조</strong></li>\n', ''))
    expect(result.patches).toEqual([{kind: 'remove', i, from: i + 2, delta: -2}])
  })

  it('refuses content that scripts changed or elements that moved', () => {
    const i = ordinalOf(deck, 'li')
    expect(applyPreviewOp(deck, {t: 'commit', i, tag: 'li', before: '스크립트가 넣은 글', after: 'x'}, normalize)).toHaveProperty('error')
    expect(applyPreviewOp(deck, {t: 'commit', i, tag: 'p', before: '첫째 &amp; 하나', after: 'x'}, normalize)).toHaveProperty('error')
    expect(applyPreviewOp(deck, {t: 'delete', i: ordinalOf(deck, 'body'), tag: 'body', before: ''}, normalize)).toHaveProperty('error')
  })

  it('falls back to a reload when the edit changes how the rest parses', () => {
    const src = '<p>a</p><p>b</p>'
    const result = applyPreviewOp(src, {t: 'commit', i: 0, tag: 'p', before: 'a', after: 'a<table><tr><td>x</td></tr></table>'}, normalize)
    if ('error' in result) throw Error(result.error)
    expect(result.content).toBe('<p>a<table><tr><td>x</td></tr></table></p><p>b</p>')
    expect(result.patches).toBeNull()
  })
})
