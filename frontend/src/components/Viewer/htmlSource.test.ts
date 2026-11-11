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

  it('edits the text of an element page scripts added to, and nothing else', () => {
    // Quarto/anchor.js append a link to every heading; the page shows it, the source doesn't have it.
    const h2 = ordinalOf(deck, 'h2'), anchor = '<a class="anchorjs-link" href="#t" aria-label="Anchor"></a>'
    const heading = applyPreviewOp(deck, {t: 'commit', i: h2, tag: 'h2', before: '목표' + anchor, after: '목적' + anchor, text: '목표', textAfter: '목적'}, normalize)
    if ('error' in heading) throw Error(heading.error)
    expect(heading.content).toBe(deck.replace('<h2 id="t">목표</h2>', '<h2 id="t">목적</h2>'))
    expect(heading.patches).toEqual([])   // the page already shows it, with its anchor
    // A class a script put on a child stays out of the source; entities and typed markup characters are kept as text.
    const li = ordinalOf(deck, 'li', 1)
    const inner = applyPreviewOp(deck, {t: 'commit', i: li, tag: 'li', before: '둘째 <strong class="hl">강조</strong>', after: '둘째 <strong class="hl">a<b & 핵심</strong>',
      text: '둘째 강조', textAfter: '둘째 a<b & 핵심'}, normalize)
    if ('error' in inner) throw Error(inner.error)
    expect(inner.content).toBe(deck.replace('<strong>강조</strong>', '<strong>a&lt;b &amp; 핵심</strong>'))
    const first = applyPreviewOp(deck, {t: 'commit', i: ordinalOf(deck, 'li'), tag: 'li', before: '첫째 &amp; 하나<span class="x"></span>', after: 'x',
      text: '첫째 & 하나', textAfter: '첫째 & 둘'}, normalize)
    if ('error' in first) throw Error(first.error)
    expect(first.content).toBe(deck.replace('첫째 &amp; 하나', '첫째 &amp; 둘'))
  })

  it('removes text across tags but keeps the tags', () => {
    const src = '<p>하나 <b>둘</b> 셋</p>'
    const result = applyPreviewOp(src, {t: 'commit', i: 0, tag: 'p', before: '하나 <b class="s">둘</b> 셋', after: '하 셋', text: '하나 둘 셋', textAfter: '하 셋'}, normalize)
    if ('error' in result) throw Error(result.error)
    expect(result.content).toBe('<p>하<b></b> 셋</p>')
  })

  it('finds the edit by its surroundings when scripts changed some of the text', () => {
    // MathJax replaces \(x^2\) with its own rendering: the page shows other text there.
    const src = '<p>값은 \\(x^2\\) 이고\r\n결과는 크다</p>'
    const before = '값은 <mjx-container>x2</mjx-container> 이고\n결과는 크다'
    const op = (text: string, textAfter: string) => ({t: 'commit' as const, i: 0, tag: 'p', before, after: 'x', text, textAfter})
    const result = applyPreviewOp(src, op('값은 x2 이고\n결과는 크다', '값은 x2 이고\n결과는 작다'), normalize)
    if ('error' in result) throw Error(result.error)
    expect(result.content).toBe('<p>값은 \\(x^2\\) 이고\r\n결과는 작다</p>')
    // A change inside what the script drew has no place in the source.
    expect(applyPreviewOp(src, op('값은 x2 이고\n결과는 크다', '값은 x3 이고\n결과는 크다'), normalize)).toHaveProperty('error')
  })

  it('writes a typed line break as <br> and reloads, since the page has no ordinal for it', () => {
    const src = '<p>앞뒤</p><p>끝</p>'
    const result = applyPreviewOp(src, {t: 'commit', i: 0, tag: 'p', before: '앞뒤<i class="s"></i>', after: 'x', text: '앞뒤', textAfter: '앞\0뒤\0'}, normalize)
    if ('error' in result) throw Error(result.error)
    expect(result.content).toBe('<p>앞<br>뒤</p><p>끝</p>')
    expect(result.patches).toBeNull()
  })

  it('refuses text edits it cannot place safely', () => {
    const changed = {t: 'commit' as const, i: 0, tag: 'p', before: '<span class="s">x</span>', after: 'y'}
    // The preview shows an older source: the ordinal could name another element.
    expect(applyPreviewOp('<p>x</p>', {...changed, text: 'x', textAfter: 'y'}, normalize, true)).toHaveProperty('error')
    // Text a script filled in isn't in the source at all.
    expect(applyPreviewOp('<p></p>', {...changed, text: 'x', textAfter: 'y'}, normalize)).toHaveProperty('error')
  })

  it('falls back to a reload when the edit changes how the rest parses', () => {
    const src = '<p>a</p><p>b</p>'
    const result = applyPreviewOp(src, {t: 'commit', i: 0, tag: 'p', before: 'a', after: 'a<table><tr><td>x</td></tr></table>'}, normalize)
    if ('error' in result) throw Error(result.error)
    expect(result.content).toBe('<p>a<table><tr><td>x</td></tr></table></p><p>b</p>')
    expect(result.patches).toBeNull()
  })
})

describe('preview document', () => {
  it('loads a page\'s own files from its project and nothing else beyond the CDNs', () => {
    const files = {project: 'https://app.test/api/preview/T/', folder: 'https://app.test/api/preview/T/_site/chapters/'}
    const doc = buildDocument('<p>x</p>', {token: 't', edit: false}, files)
    expect(doc).toContain('<base href="https://app.test/api/preview/T/_site/chapters/">')
    const policy = /content="([^"]+)"/.exec(doc)![1]
    expect(policy).toContain("img-src data: blob: https://app.test/api/preview/T/ https://cdn.jsdelivr.net")
    expect(policy).toContain('base-uri https://app.test/api/preview/T/;')
    expect(policy).not.toMatch(/connect-src[^;]*\*|https:;|'self'/)
    const alone = buildDocument('<p>x</p>', {token: 't', edit: false})
    expect(alone).not.toContain('<base')
    expect(alone).toContain("base-uri 'none'")
  })
})

