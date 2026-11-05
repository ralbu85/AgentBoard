import {beforeAll, describe, expect, it} from 'vitest'
import {previewRuntime} from './htmlPreviewRuntime'
import {annotate, parseElements} from './htmlSource'

// One runtime per file: it installs window-level listeners for its document.
const sent: Record<string, unknown>[] = []
let deliver: (message: Record<string, unknown>) => void = () => {}
const src = '<section><h2>목표</h2><ul><li>첫째</li><li>둘째 <strong>강조</strong></li></ul></section><p>끝</p>'
const el = (i: number) => document.querySelector(`[data-ab-i="${i}"]`) as HTMLElement
const last = () => sent[sent.length - 1]
const click = (target: Element) => target.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, clientX: 1, clientY: 1}))
const key = (target: Element, init: KeyboardEventInit) => target.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true, cancelable: true, ...init}))

describe('HTML preview runtime', () => {
  beforeAll(() => {
    document.body.innerHTML = annotate(src, parseElements(src))
    previewRuntime({token: 't', edit: true}, {send: message => { sent.push(message) }, listen: handler => { deliver = handler }})
  })

  it('asks before editing a text block and never hands the click to the page', () => {
    let pageSawClick = false
    document.body.addEventListener('click', () => { pageSawClick = true })
    click(el(4).firstChild!.parentElement!)
    expect(last()).toEqual({t: 'begin', i: 4, tag: 'li', before: '둘째 <strong>강조</strong>'})
    expect(pageSawClick).toBe(false)
    expect(el(4).hasAttribute('contenteditable')).toBe(false)
    deliver({t: 'begin-ok', i: 4})
    expect(el(4).getAttribute('contenteditable')).toBe('plaintext-only')
  })

  it('keeps typing keys away from page shortcuts and commits on Enter', () => {
    let pageSawKey = false
    window.addEventListener('keydown', () => { pageSawKey = true })
    el(4).firstChild!.textContent = '둘째! '
    key(el(4), {key: 'ArrowRight'})
    expect(pageSawKey).toBe(false)
    key(el(4), {key: 'Enter', isComposing: true})
    expect(last().t).toBe('begin')
    key(el(4), {key: 'Enter'})
    // Typed spaces arrive as &nbsp; from contenteditable; the source keeps plain spaces.
    expect(last()).toEqual({t: 'commit', i: 4, tag: 'li', before: '둘째 <strong>강조</strong>', after: '둘째! <strong>강조</strong>', add: false})
    expect(el(4).hasAttribute('contenteditable')).toBe(false)
  })

  it('applies patches and keeps later ordinals in step', () => {
    deliver({t: 'patch', patches: [{kind: 'inner', i: 4, from: 6, delta: -1, html: '둘째'}]})
    expect(el(4).innerHTML).toBe('둘째')
    expect(el(5).textContent).toBe('끝')
    deliver({t: 'patch', patches: [{kind: 'after', i: 4, from: 5, delta: 1, html: '<li data-ab-i="5">새 텍스트</li>'}], focus: 5})
    expect(el(6).textContent).toBe('끝')
    expect(el(5).getAttribute('contenteditable')).toBe('plaintext-only')
  })

  it('drops an untouched new sibling instead of saving placeholder text', () => {
    key(el(5), {key: 'Enter'})
    expect(last()).toEqual({t: 'delete', i: 5, tag: 'li', before: '새 텍스트'})
    deliver({t: 'patch', patches: [{kind: 'remove', i: 5, from: 6, delta: -1}]})
    expect(el(5).textContent).toBe('끝')
  })

  it('keeps the text on Escape and ignores containers of other blocks', () => {
    const count = sent.length
    click(el(0))
    expect(sent.length).toBe(count)
    click(el(1))
    deliver({t: 'begin-ok', i: 1})
    el(1).textContent = '바뀜'
    key(el(1), {key: 'Escape'})
    expect(last()).toEqual({t: 'commit', i: 1, tag: 'h2', before: '목표', after: '바뀜', add: false})
    expect(el(1).hasAttribute('contenteditable')).toBe(false)
  })
})
