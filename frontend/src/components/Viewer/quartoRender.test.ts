import {afterEach, expect, it, vi} from 'vitest'
import {frozenCells, includedPaths, renderBlocks} from './markdownBlocks'

const FREEZE = [
  '::: {#a1 .cell execution_count=1}', '``` {.python .cell-code}', 'print(1)', '```', '',
  '::: {.cell-output .cell-output-stdout}', '```', '1', '```', ':::', ':::', '',
  '::: {.callout-note}', '::: {#lab-fig .cell execution_count=3}', '``` {.python .cell-code}', 'plot()', '```', '',
  '::: {.cell-output .cell-output-display}', '![](lab_files/figure-html/lab-fig-output-1.png){width=300}', ':::', '',
  '::: {.cell-output .cell-output-display}', '<table class="dataframe"><tr><td>7</td></tr></table>', ':::', ':::', ':::', '',
  '::: {#a3 .cell}', '``` {.python .cell-code}', 'x = 2', '```', ':::',
].join('\n')
const SRC = '# Lab\n\n```{python}\nprint(1)\n```\n\n```{python}\n#| include: false\nsecret()\n```\n\n::: {.callout-note}\n```{python}\n#| label: lab-fig\nplot()\n```\n:::\n\n```{python}\nx = 3\n```\n\n{{< include _kit.qmd >}}\n'
const run = {cells: frozenCells(FREEZE), folder: '/c/_freeze/labs/lab', stem: 'lab'}

it('reads each cell of a frozen run with its code and outputs, inside callouts too', () => {
  expect(run.cells.map(c => c.code)).toEqual(['print(1)', 'plot()', 'x = 2'])
  expect(run.cells.map(c => c.count)).toEqual([1, 3, null])
  expect(run.cells.map(c => c.outputs.map(o => o.kind))).toEqual([['stdout'], ['display', 'display'], []])
  expect(run.cells[1].outputs[0].markdown).toBe('![](lab_files/figure-html/lab-fig-output-1.png){width=300}')
})

it('shows the saved outputs under their cells, skipping cells Quarto leaves out', () => {
  const doc = document.createElement('div')
  doc.innerHTML = renderBlocks(SRC, {filePath: '/c/labs/lab.qmd', quarto: true, sources: {frozen: run}}).html
  const cells = [...doc.querySelectorAll('.qmd-cell, .qmd-cell-group')]
  expect(cells.map(c => c.querySelector('.qmd-outputs')?.textContent?.trim() ?? null)).toEqual(['1', null, '7', null])
  // The figure is the freeze folder's, served as a file.
  expect(doc.querySelector('.qmd-outputs img')?.getAttribute('src')).toBe(`/api/file-raw?path=${encodeURIComponent('/c/_freeze/labs/lab/figure-html/lab-fig-output-1.png')}`)
  // Outputs are no blocks of their own: a click on them opens their cell.
  expect(doc.querySelector('.qmd-outputs [data-mb]')).toBeNull()
})

it('pairs cells by execution count when Quarto dropped one that showed nothing', () => {
  // The run started at 2: cell 1 (a setup cell with its code hidden) printed nothing and was left out.
  const hidden = frozenCells(FREEZE.replace('execution_count=1}', 'execution_count=2}').replace('execution_count=3}', 'execution_count=4}'))
  const doc = document.createElement('div')
  const src = '```{python}\nsetup = 1\n```\n\n' + SRC.replace('#| include: false\n', '')
  doc.innerHTML = renderBlocks(src, {filePath: '/c/labs/lab.qmd', quarto: true, sources: {frozen: {...run, cells: hidden}}}).html
  expect([...doc.querySelectorAll('.qmd-cell')].map(c => c.querySelector('.qmd-outputs')?.textContent?.trim() ?? null)).toEqual([null, '1', null, '7', null])
})

it('says when a cell\'s code changed after the run that saved its output', () => {
  const doc = document.createElement('div')
  doc.innerHTML = renderBlocks(SRC.replace('print(1)', 'print(10)'), {filePath: '/c/labs/lab.qmd', quarto: true, sources: {frozen: run}}).html
  expect(doc.querySelector('.qmd-outputs')?.classList.contains('qmd-outputs-stale')).toBe(true)
})

it('renders an included file in place, read-only, nested includes resolved from it', () => {
  expect(includedPaths(SRC, '/c/labs/lab.qmd')).toEqual(['/c/labs/_kit.qmd'])
  const includes = {'/c/labs/_kit.qmd': '## Kit\n\nUse **this**.\n\n{{< include ../shared/_end.qmd >}}\n', '/c/shared/_end.qmd': 'The end.\n'}
  const doc = document.createElement('div')
  const r = renderBlocks(SRC, {filePath: '/c/labs/lab.qmd', quarto: true, sources: {includes}})
  doc.innerHTML = r.html
  const box = doc.querySelector('.qmd-include')!
  expect(box.querySelector('h2')?.textContent).toBe('Kit')
  expect(box.querySelector('[data-open-file]')?.getAttribute('data-open-file')).toBe('/c/labs/_kit.qmd')
  expect(box.querySelector('.qmd-include .qmd-include')?.textContent).toContain('The end.')
  expect(box.querySelector('[data-mb]')).toBeNull()
  // The include line itself stays one block of the document.
  expect(r.blocks[Number(box.getAttribute('data-mb'))].text).toBe('{{< include _kit.qmd >}}')
})

afterEach(() => { vi.doUnmock('mermaid'); vi.resetModules() })

it('colours code blocks and draws Mermaid diagrams as images, keeping the block clickable', async () => {
  vi.doMock('mermaid', () => ({default: {initialize: () => {}, parse: async (s: string) => !s.includes('bad'), render: async () => ({svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>A</text></svg>'})}}))
  const {enhance} = await import('./markdownEnhance')
  const doc = document.createElement('div')
  doc.innerHTML = renderBlocks('```python\nx = 1\n```\n\n```mermaid\ngraph TD; A-->B\n```\n\n```{mermaid}\nbad\n```\n', {quarto: true}).html
  document.body.append(doc)
  enhance(doc)
  await vi.waitFor(() => expect(doc.querySelector('code.language-python span.hljs-number')?.textContent).toBe('1'))
  await vi.waitFor(() => expect(doc.querySelector('img.md-mermaid')).not.toBeNull())
  const pre = doc.querySelector('img.md-mermaid')!.closest('[data-mb]')!
  expect(pre.querySelector('code')!.hidden).toBe(true)
  await vi.waitFor(() => expect(doc.querySelector('pre[data-note]')).not.toBeNull())   // a diagram that doesn't parse keeps its source
  expect(doc.querySelectorAll('img.md-mermaid').length).toBe(1)
  doc.remove()
})
