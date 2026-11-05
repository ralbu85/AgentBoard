import {describe, expect, it} from 'vitest'
import {deleteBlock, insertAfter, locateBlock, renderBlocks, replaceBlock, toggleTask, type MdBlock} from './markdownBlocks'

const SAMPLE = `---
title: "LIME 소개"
author:
  - name: 이지환
date: 2026
---

# Motivation {#sec-motivation}
Why **local** explanations, with $x_0$ and [@ribeiro2016].

- item one
- [ ] task two
  continuation
  - nested a
  - nested b

1. first
2. second

> quote line
>
> - quoted item

::: {.callout-note appearance="minimal"}
## Learning Objectives

- Articulate why
:::

:::: {.columns}
::: {.column width="48%"}
Left text
:::
::: {.column width="48%"}
Right text
:::
::::

\`\`\`{python}
#| echo: false
print(1)
\`\`\`

\`\`\`{ojs}
viewof x = Inputs.range([0, 1])
\`\`\`

| a | b |
|---|---|
| 1 | 2 |

$$
f(x)=1
$$

<div class="note">raw</div>

Last paragraph.
`

const render = (src: string, quarto = true) => renderBlocks(src, {quarto})
const find = (blocks: MdBlock[], text: string) => {
  const hit = [...blocks].reverse().find(b => b.text.includes(text))   // innermost: parents come first
  if (!hit) throw new Error(`no block with ${text}`)
  return hit
}
const dom = (html: string) => { const root = document.createElement('div'); root.innerHTML = html; return root }

describe('markdown blocks', () => {
  it('maps every rendered block to its exact source and back', () => {
    const {html, blocks} = render(SAMPLE)
    const root = dom(html)
    expect(blocks.length).toBeGreaterThan(20)
    blocks.forEach((b, k) => {
      expect(SAMPLE.slice(b.start, b.end)).toBe(b.raw)
      expect(replaceBlock(SAMPLE, b, b.text)).toBe(SAMPLE)
      expect(root.querySelectorAll(`[data-mb="${k}"]`).length, `${b.kind}: ${b.text}`).toBe(1)
    })
    expect(find(blocks, 'nested a')).toMatchObject({kind: 'item', text: '- nested a', lead: '  ', cont: '    ', sibling: '- '})
    // An item edits its own lines; its sub-items are blocks of their own.
    expect(find(blocks, 'task two').text).toBe('- [ ] task two\ncontinuation')
    expect(find(blocks, 'quoted item')).toMatchObject({text: '- quoted item', lead: '> ', cont: '>   '})
    expect(find(blocks, 'Left text')).toMatchObject({kind: 'paragraph', cont: ''})
    expect(find(blocks, 'title:')).toMatchObject({kind: 'meta', start: 0})
  })

  it('renders Quarto callouts, columns, cells, citations and front matter', () => {
    const root = dom(render(SAMPLE).html)
    expect(root.querySelector('.qmd-meta-title')?.textContent).toBe('LIME 소개')
    expect(root.querySelector('.qmd-meta-by')?.textContent).toBe('이지환 · 2026')
    expect(root.querySelector('h1:not(.qmd-meta-title)')?.textContent).toBe('Motivation')
    const callout = root.querySelector('.qmd-callout-note.qmd-callout-minimal')!
    expect(callout.querySelector('.qmd-callout-title')?.textContent).toBe('Learning Objectives')
    expect(callout.querySelector('.qmd-callout-heading')?.hasAttribute('data-mb')).toBe(true)
    expect([...root.querySelectorAll<HTMLElement>('.qmd-column')].map(c => c.style.flex)).toEqual(['0 1 48%', '0 1 48%'])
    expect(root.querySelector('.qmd-cite')?.textContent).toBe('[@ribeiro2016]')
    const cells = [...root.querySelectorAll('details.qmd-cell summary')].map(s => s.textContent)
    expect(cells).toEqual(['python 셀 · 코드 숨김', 'OJS 대화형 셀 · 결과는 Quarto 렌더에서 보입니다'])
    expect(root.querySelector('.katex')).not.toBeNull()
    // Task boxes inside editable items can be toggled.
    expect(root.querySelector('input[type="checkbox"]')?.hasAttribute('disabled')).toBe(false)
  })

  it('writes nested lines back with their container prefix', () => {
    const {blocks} = render(SAMPLE)
    const out = replaceBlock(SAMPLE, find(blocks, 'nested a'), '- nested a\nsecond line')
    expect(out).toContain('  - nested a\n    second line\n  - nested b')
    const quote = replaceBlock(SAMPLE, find(blocks, 'quoted item'), '- quoted item\n\nmore')
    expect(quote).toContain('> - quoted item\n>\n>   more\n')
  })

  it('adds same-level siblings with the right separator and marker', () => {
    const src = '# Title\nIntro line\n\n- a\n- b\n\n1. one\n2. two\n\n> q\n'
    const {blocks} = render(src, false)
    const afterHeading = insertAfter(src, find(blocks, '# Title'), '## Next')
    expect(afterHeading.content).toBe('# Title\n\n## Next\n\nIntro line\n\n- a\n- b\n\n1. one\n2. two\n\n> q\n')
    expect(afterHeading.content.slice(afterHeading.at)).toMatch(/^## Next/)
    const item = find(blocks, '- a')
    expect(item.sibling).toBe('- ')
    expect(insertAfter(src, item, '- new').content).toContain('- a\n- new\n- b')
    expect(find(blocks, '2. two').sibling).toBe('3. ')
    const quoted = blocks.find(b => b.text === 'q')!
    expect(insertAfter(src, quoted, 'r').content).toBe(src.replace('> q\n', '> q\n>\n> r\n'))
  })

  it('deletes a block with its lines and one blank line', () => {
    const src = 'para one\n\npara two\n\n- a\n  - sub\n- b\n\nlast'
    const {blocks} = render(src)
    expect(deleteBlock(src, find(blocks, 'para two'))).toBe('para one\n\n- a\n  - sub\n- b\n\nlast')
    expect(deleteBlock(src, find(blocks, '- a'))).toBe('para one\n\npara two\n\n- b\n\nlast')
    expect(deleteBlock(src, find(blocks, 'last'))).toBe('para one\n\npara two\n\n- a\n  - sub\n- b')
    expect(deleteBlock(src, find(blocks, 'para one'))).toBe('para two\n\n- a\n  - sub\n- b\n\nlast')
  })

  it('finds a block that moved and refuses an ambiguous one', () => {
    const src = 'alpha\n\nbeta\n\nbeta\n'
    const {blocks} = render(src)
    const alpha = find(blocks, 'alpha')
    expect(locateBlock('new\n\n' + src, alpha)).toMatchObject({start: 5, raw: 'alpha'})
    expect(locateBlock(src.replace('alpha', 'gamma'), blocks[1])).toBe(blocks[1])
    expect(locateBlock('x\n\n' + src, blocks[1])).toBeNull()
  })

  it('toggles the task on the item line and stays read-only for CRLF files', () => {
    const src = 'intro\n\n- [ ] first\n- [x] second\n'
    const {blocks} = render(src)
    expect(toggleTask(src, find(blocks, 'first'))).toBe('intro\n\n- [x] first\n- [x] second\n')
    expect(render('a\r\n\r\nb\r\n').blocks).toEqual([])
  })
})
