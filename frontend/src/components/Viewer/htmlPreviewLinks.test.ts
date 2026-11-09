import {beforeAll, expect, it} from 'vitest'
import {previewRuntime} from './htmlPreviewRuntime'

// The page's folder is its <base>, as when its own files are served.
const FOLDER = 'https://app.test/api/preview/T/lectures/week10/'
const sent: Record<string, unknown>[] = []
const opened = () => sent.filter(m => m.t === 'open').map(m => m.href)
const click = (id: string) => { const e = new MouseEvent('click', {bubbles: true, cancelable: true}); document.getElementById(id)!.dispatchEvent(e); return e }

beforeAll(() => {
  document.head.innerHTML = `<base href="${FOLDER}">`
  document.body.innerHTML = '<a id="frag" href="#s2">2</a><a id="self" href="slides.html#s3">3</a><a id="next" href="../week11/slides.html">다음 주</a>'
    + '<a id="site" href="https://example.org/a">site</a><a id="deck" href="#s4">deck</a><h2 id="s2">two</h2>'
  document.getElementById('deck')!.addEventListener('click', e => e.preventDefault())   // the page's own navigation
  previewRuntime({token: 't', edit: false, self: FOLDER + 'slides.html'}, {send: m => { sent.push(m) }, listen: () => {}})
})

it('moves the fragment for a link within the page instead of loading its folder', () => {
  expect(click('frag').defaultPrevented).toBe(true)
  expect(location.hash).toBe('#s2')
  click('self')
  expect(location.hash).toBe('#s3')
  expect(opened()).toEqual([])
})

it('hands other pages and sites to the app, and leaves links the page handles alone', () => {
  click('next'); click('site'); click('deck')
  expect(opened()).toEqual(['https://app.test/api/preview/T/lectures/week11/slides.html', 'https://example.org/a'])
  expect(location.hash).toBe('#s3')
})
