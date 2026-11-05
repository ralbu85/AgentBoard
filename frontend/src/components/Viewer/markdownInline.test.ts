import {describe, expect, it} from 'vitest'
import {renderBlocks, type MdBlock} from './markdownBlocks'
import {inlineModel, normalize, readInline} from './markdownInline'

/** Render `src`, edit block `k` where it is shown (`edit` changes the DOM), read the markdown back. */
function edit(src: string, k: number, change: (root: HTMLElement) => void, quarto = false) {
  const {blocks} = renderBlocks(src, {quarto})
  const block = blocks[k] as MdBlock
  const model = inlineModel(block, {quarto})
  if (!model) return null
  const root = document.createElement('p')
  root.innerHTML = model.html
  change(root)
  return readInline(model, root)
}
const piece = (root: HTMLElement, text: string) => [...root.querySelectorAll<HTMLElement>('[data-ms]')].find(s => s.textContent?.includes(text))!
const retype = (root: HTMLElement, from: string, to: string) => { const s = piece(root, from); s.textContent = s.textContent!.replace(from, to) }

describe('editing rendered markdown in place', () => {
  it('changes only the edited text and keeps the markup around it', () => {
    const src = 'Intro **bold text** and [a link](https://x.y "t") with $x^2$ and `code` here.\n'
    expect(edit(src, 0, () => {})).toBe(src.trimEnd())
    expect(edit(src, 0, r => retype(r, 'bold', 'strong'))).toBe('Intro **strong text** and [a link](https://x.y "t") with $x^2$ and `code` here.')
    expect(edit(src, 0, r => retype(r, 'a link', 'the site'))).toBe('Intro **bold text** and [the site](https://x.y "t") with $x^2$ and `code` here.')
    expect(edit(src, 0, r => retype(r, ' here.', ' now.'))).toBe('Intro **bold text** and [a link](https://x.y "t") with $x^2$ and `code` now.')
    expect(edit(src, 0, r => retype(r, 'code', 'run()'))).toBe('Intro **bold text** and [a link](https://x.y "t") with $x^2$ and `run()` here.')
  })

  it('drops emptied formatting and deleted atoms, and keeps typed spaces outside the markers', () => {
    const src = 'Say **loud** with $x$ now\n'
    expect(edit(src, 0, r => { piece(r, 'loud').textContent = '' })).toBe('Say  with $x$ now')
    expect(edit(src, 0, r => r.querySelector('[data-ma]')!.remove())).toBe('Say **loud** with  now')
    expect(edit(src, 0, r => { piece(r, 'loud').textContent = 'loud ' })).toBe('Say **loud**  with $x$ now')
  })

  it('keeps escapes, entities and Quarto dashes that sit next to an edit', () => {
    expect(edit('A \\*star\\* &amp; more\n', 0, r => retype(r, ' more', ' less'))).toBe('A \\*star\\* &amp; less')
    expect(edit('a &nbsp;|&nbsp; b\n', 0, () => {})).toBe('a &nbsp;|&nbsp; b')
    expect(edit('a &nbsp;|&nbsp; b\n', 0, r => retype(r, 'b', 'c d'))).toBe('a &nbsp;|&nbsp; c d')
    expect(edit('Space (` `) or `;`\n', 0, () => {})).toBe('Space (` `) or `;`')
    expect(edit('Pages 3--5 --- done\n', 0, r => retype(r, 'done', 'finished'), true)).toBe('Pages 3--5 --- finished')
    expect(edit('Pages 3--5 --- done\n', 0, r => retype(r, '3–5', '3–7'), true)).toBe('Pages 3--7 --- done')
  })

  it('edits headings and list items without touching their markers or attributes', () => {
    expect(edit('## Intro {#sec-intro}\n', 0, r => retype(r, 'Intro', 'Overview'), true)).toBe('## Overview {#sec-intro}')
    expect(edit('- [ ] buy milk\n- next\n', 0, r => retype(r, 'milk', 'bread'))).toBe('- [ ] buy bread')
    expect(edit('1. first **one**\n', 0, r => retype(r, 'first', 'only'))).toBe('1. only **one**')
    expect(edit('See [@knuth84] and @fig-plot.\n', 0, r => retype(r, 'See', 'Read'), true)).toBe('Read [@knuth84] and @fig-plot.')
  })

  it('reads nothing back when every word is gone, and leaves raw HTML to the markdown editor', () => {
    expect(edit('Only **this**\n', 0, r => { r.textContent = '' })).toBe('')
    expect(edit('x<sup>2</sup> y\n', 0, () => {})).toBeNull()
  })

  it('shows exactly what the document shows', () => {
    const src = '# T\n\nA [@cite] **b** $y$ ![i](a.png){width=50%} [s]{.mark} c--d\n'
    const {html, blocks} = renderBlocks(src, {quarto: true})
    const shown = document.createElement('div'); shown.innerHTML = html
    for (const block of blocks) {
      const model = inlineModel(block, {quarto: true})
      const el = shown.querySelector(`[data-mb="${blocks.indexOf(block)}"]`)!
      expect(model && normalize(model.text)).toBe(normalize(el.textContent!))
    }
  })
})
