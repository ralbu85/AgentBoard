import {act, createElement} from 'react'
import {createRoot, type Root} from 'react-dom/client'
import {afterEach, beforeEach, expect, it, vi} from 'vitest'
import {NotebookView} from './NotebookView'
import {useNotebooks} from './notebookRuntime'
import type {ViewerTab} from '../../store'

const KEY = JSON.stringify(['local', '/lec'])
const PATH = '/lec/a.ipynb'
const notebook = (cells: object[]) => JSON.stringify({nbformat: 4, nbformat_minor: 5, metadata: {}, cells}, null, 1) + '\n'
const SRC = notebook([
  {id: 'm1', cell_type: 'markdown', metadata: {}, source: ['# Title\n', '\n', 'Some **bold** text.']},
  {id: 'c1', cell_type: 'code', metadata: {}, source: 'x = 1', outputs: [], execution_count: null},
  {id: 'm2', cell_type: 'markdown', metadata: {}, source: '```\nraw\n```'},
])
let root: Root, host: HTMLDivElement, server: Record<string, any>, calls: string[], fileVersion: string

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.setItem('agentboard.doc.edit', '1')
  localStorage.removeItem('agentboard.doc.mode.notebook')
  useNotebooks.setState({records: {}})
  server = {id: 'nb', path: PATH, content: SRC, version: 'v1', revision: 1, dirty: false, state: 'stopped', cell: null, error: '', kernel: false, python: 'python'}
  fileVersion = 'v1'
  calls = []
  const ok = (data: object) => ({ok: true, status: 200, json: async () => data})
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    const body = options?.body ? JSON.parse(options.body as string) : {}
    if (url === '/api/notebooks/open') return ok(server)
    if (url.startsWith('/api/notebooks/nb?since=')) return ok({...server, unchanged: true})
    if (url === '/api/notebooks/nb' && options?.method === 'PUT') { calls.push('PUT'); server = {...server, content: body.content, revision: server.revision + 1, dirty: true}; return ok(server) }
    if (url === '/api/notebooks/nb/action') {
      calls.push(body.action)
      server = {...server, revision: server.revision + 1, dirty: false, ...(body.action === 'save' ? {version: fileVersion = 'v2'} : {version: fileVersion})}
      return ok(server)
    }
    if (url.startsWith('/api/file-stat')) return ok({signature: fileVersion})
    if (url.startsWith('/api/file?')) return ok({content: server.content, version: fileVersion})
    return {ok: false, status: 404, json: async () => ({})}
  }))
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals() })

async function mount() {
  const tab: ViewerTab = {id: PATH, name: 'a.ipynb', path: PATH, content: SRC, type: 'notebook', lang: 'json', version: 'v1'}
  act(() => root.render(createElement(NotebookView, {tab, ownerKey: KEY})))
  await vi.waitFor(() => expect(block('Some')).toBeTruthy())
}
const cells = () => JSON.parse(useNotebooks.getState().records[PATH].content).cells
const source = (k: number) => [cells()[k].source].flat().join('')
const block = (text: string) => [...host.querySelectorAll<HTMLElement>('.nb-markdown-preview [data-mb]')].reverse().find(el => el.textContent?.includes(text))!
const region = () => host.querySelector<HTMLElement>('.md-inline-edit')
const piece = (text: string) => [...host.querySelectorAll<HTMLElement>('.md-inline-edit [data-ms]')].find(s => s.textContent?.includes(text))!
const retype = (from: string, to: string) => act(() => { const s = piece(from); s.textContent = s.textContent!.replace(from, to) })
const press = (k: string) => act(() => { region()!.dispatchEvent(new KeyboardEvent('keydown', {key: k, bubbles: true, cancelable: true})) })
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes(text))!

it('edits a markdown cell where it is rendered, saves at once and undoes', async () => {
  await mount()
  act(() => block('Some').click())
  expect(region()?.localName).toBe('p')
  expect(host.querySelector('.cm-content[aria-label*="마크다운"]')).toBeNull()   // not the cell's source
  retype('bold', 'strong')
  press('Enter')
  expect(source(0)).toBe('# Title\n\nSome **strong** text.')
  await vi.waitFor(() => expect(calls).toEqual(['PUT', 'save']))
  expect(JSON.parse(server.content).cells[0].source).toBe('# Title\n\nSome **strong** text.')
  expect(block('Some').querySelector('strong')?.textContent).toBe('strong')
  act(() => button('되돌리기').click())
  expect(source(0)).toBe('# Title\n\nSome **bold** text.')
  await vi.waitFor(() => expect(calls.slice(-2)).toEqual(['PUT', 'save']))
})

it('opens the markdown of a block that is not text, and of the whole cell with 원문', async () => {
  await mount()
  act(() => block('raw').click())
  expect(host.querySelector<HTMLTextAreaElement>('.md-block-editor-text')?.value).toBe('```\nraw\n```')
  act(() => button('취소').click())
  const cell = host.querySelectorAll<HTMLElement>('.nb-markdown-cell')[0]
  act(() => [...cell.querySelectorAll('button')].find(b => b.textContent === '원문')!.click())
  expect(cell.querySelector('.cm-editor')).not.toBeNull()
  expect(cell.querySelector('.md-rendered')).toBeNull()
})

it('loads an agent write to the notebook only once the open cell editor closes', async () => {
  await mount()
  act(() => block('Some').click())
  fileVersion = 'v9'
  await act(() => new Promise(r => setTimeout(r, 2300)))
  expect(calls).not.toContain('reload')
  expect(region()).not.toBeNull()
  act(() => button('취소').click())
  await vi.waitFor(() => expect(calls).toContain('reload'), {timeout: 2500})
}, 10_000)

it('shows every markdown cell as markdown in 소스 and remembers it', async () => {
  await mount()
  act(() => button('소스').click())
  const cells = [...host.querySelectorAll<HTMLElement>('.nb-markdown-cell')]
  expect(cells.map(c => !!c.querySelector('.cm-editor'))).toEqual([true, true])
  expect(host.querySelector('.nb-markdown-preview')).toBeNull()
  expect(localStorage.getItem('agentboard.doc.mode.notebook')).toBe('source')
  act(() => button('미리보기').click())
  expect(block('Some')).toBeTruthy()
})
