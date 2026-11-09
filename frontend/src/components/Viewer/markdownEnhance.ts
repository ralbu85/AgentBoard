import {sanitize} from '../../sanitize'
import {getHljs} from './FileContent'

// Added to a rendered document once it is on screen: colours in code blocks
// and Mermaid diagrams. Neither changes any text or the blocks (data-mb) the
// editor maps, and a diagram's block still opens its source on click.

type Mermaid = typeof import('mermaid').default
let mermaid: Promise<Mermaid> | null = null
const loadMermaid = () => mermaid ||= import('mermaid').then(({default: m}) => {
  m.initialize({startOnLoad: false, securityLevel: 'strict', theme: 'dark', htmlLabels: false, flowchart: {htmlLabels: false}})
  return m
})
// One diagram at a time (Mermaid measures text in a shared scratch element); each source is drawn once.
const drawn = new Map<string, Promise<string | null>>()
let queue: Promise<unknown> = Promise.resolve()
let seq = 0
function draw(source: string): Promise<string | null> {
  let svg = drawn.get(source)
  if (!svg) {
    svg = queue.then(async () => {
      const m = await loadMermaid()
      if (!await m.parse(source, {suppressErrors: true})) return null
      return (await m.render(`md-mermaid-${++seq}`, source)).svg
    }).catch(() => null)
    queue = svg
    drawn.set(source, svg)
  }
  return svg
}

export function enhance(root: HTMLElement) {
  const codes = Array.from(root.querySelectorAll<HTMLElement>('pre > code'))
  const plain = codes.filter(code => !code.classList.contains('language-mermaid') && !code.classList.contains('hljs') && /language-[\w+-]+/.test(code.className))
  if (plain.length) void getHljs().then(hljs => {
    for (const code of plain) {
      const lang = /language-([\w+-]+)/.exec(code.className)![1]
      if (!code.isConnected || !hljs.getLanguage(lang)) continue
      code.innerHTML = sanitize(hljs.highlight(code.textContent || '', {language: lang, ignoreIllegals: true}).value)
      code.classList.add('hljs')
    }
  }).catch(() => {})
  for (const code of codes) {
    if (!code.classList.contains('language-mermaid') || code.dataset.drawn) continue
    code.dataset.drawn = '1'
    const pre = code.parentElement!
    void draw(code.textContent || '').then(svg => {
      if (!code.isConnected) return
      if (!svg) { pre.dataset.note = 'Mermaid 문법을 읽지 못해 원문을 보여 줍니다'; return }
      // As an image: an SVG loaded by <img> can't run scripts or reach the page.
      const img = document.createElement('img')
      img.className = 'md-mermaid'
      img.alt = 'Mermaid 다이어그램'
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
      code.hidden = true
      pre.classList.add('md-mermaid-pre')
      pre.append(img)
    })
  }
}
