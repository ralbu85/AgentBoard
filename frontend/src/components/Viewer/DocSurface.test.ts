import {act, createElement} from 'react'
import {createRoot, type Root} from 'react-dom/client'
import {afterEach, beforeEach, expect, it, vi} from 'vitest'
import {DocSurface} from './DocSurface'
import {useStore, type ViewerTab} from '../../store'
import {api} from '../../api'

const KEY = JSON.stringify(['local', '/lec'])
const SRC = '# Week 1\n\nIntro **text** here.\n\n- one\n- [ ] two\n'
let root: Root, host: HTMLDivElement, saves: ReturnType<typeof vi.fn>, unsubscribe = () => {}

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('fetch', vi.fn(async () => ({ok: false})))   // the disk watcher sees nothing new
  let n = 0
  saves = vi.fn(async () => ({ok: true, version: `v${++n}`}))
  vi.spyOn(api, 'saveFile').mockImplementation(saves as typeof api.saveFile)
  localStorage.setItem('agentboard.doc.edit', '1')
  localStorage.removeItem('agentboard.doc.mode.markdown')
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { unsubscribe(); act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const tab = () => useStore.getState()._viewerState[KEY].tabs[0]
const content = () => tab().content
function mount(src = SRC, name = 'w1.qmd', type: ViewerTab['type'] = 'markdown') {
  const first: ViewerTab = {id: 'f', name, path: `/lec/${name}`, content: src, type, lang: type === 'markdown' ? 'markdown' : 'python', version: 'v0'}
  useStore.setState({_viewerState: {[KEY]: {tabs: [first], activeTabId: 'f'}}})
  // Like ViewerPane: the surface re-renders from the store.
  const render = () => { const current = useStore.getState()._viewerState[KEY]?.tabs[0]; if (current) root.render(createElement(DocSurface, {tab: current, ownerKey: KEY})) }
  act(render)
  unsubscribe = useStore.subscribe(render)
}
const block = (text: string) => [...host.querySelectorAll<HTMLElement>('[data-mb]')].reverse().find(el => el.textContent?.includes(text))!
const editorText = () => host.querySelector<HTMLTextAreaElement>('.md-block-editor-text')
const type = (value: string) => act(() => { const t = editorText()!; t.value = value; t.dispatchEvent(new Event('input', {bubbles: true})) })
const key = (k: string, init: KeyboardEventInit = {}) => act(() => { editorText()!.dispatchEvent(new KeyboardEvent('keydown', {key: k, bubbles: true, cancelable: true, ...init})) })
// Editing where it is rendered: the contenteditable text and its pieces.
const region = () => host.querySelector<HTMLElement>('.md-inline-edit, .md-inline-new')
const piece = (text: string) => [...host.querySelectorAll<HTMLElement>('.md-inline-edit [data-ms]')].find(s => s.textContent?.includes(text))!
const retype = (from: string, to: string) => act(() => { const s = piece(from); s.textContent = s.textContent!.replace(from, to) })
const press = (k: string, init: KeyboardEventInit = {}) => act(() => { region()!.dispatchEvent(new KeyboardEvent('keydown', {key: k, bubbles: true, cancelable: true, ...init})) })
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes(text))!
const flush = () => act(async () => { for (let k = 0; k < 4; k++) await Promise.resolve() })
const wait = (ms: number) => act(() => new Promise(r => setTimeout(r, ms)))

it('edits a paragraph where it is rendered, keeps its markup, saves at once and undoes', async () => {
  mount()
  expect([...host.querySelectorAll('.doc-modes button')].map(b => b.textContent)).toEqual(['미리보기', '나란히', '소스'])
  act(() => block('Intro').click())
  expect(region()?.localName).toBe('p')
  expect(region()?.getAttribute('contenteditable')).toBe('plaintext-only')
  expect(editorText()).toBeNull()
  retype('text', 'new')
  retype(' here.', ' words.')
  press('Enter')
  await flush()
  expect(content()).toBe('# Week 1\n\nIntro **new** words.\n\n- one\n- [ ] two\n')
  expect(saves).toHaveBeenCalledWith('/lec/w1.qmd', content(), 'v0')
  expect(tab().dirty).toBe(false)
  expect(host.querySelector('.doc-save')?.textContent).toBe('저장됨')
  expect(region()).toBeNull()
  expect(block('Intro').querySelector('strong')?.textContent).toBe('new')
  act(() => button('되돌리기').click())
  await flush()
  expect(content()).toBe(SRC)
  expect(saves).toHaveBeenLastCalledWith('/lec/w1.qmd', SRC, 'v1')
})

it('edits a list item and its heading in place and adds a same-level item with Ctrl+Enter', async () => {
  mount()
  act(() => block('Week').click())
  retype('Week 1', 'Week One')
  press('Escape')
  await flush()
  expect(content()).toBe(SRC.replace('# Week 1', '# Week One'))
  act(() => block('one').click())
  expect(region()?.closest('li')).toBe(block('one'))
  press('Enter', {ctrlKey: true})
  expect(region()?.localName).toBe('li')
  expect(region()?.classList.contains('md-inline-new')).toBe(true)
  act(() => { region()!.textContent = 'three' })
  press('Enter')
  await flush()
  expect(content()).toBe('# Week One\n\nIntro **text** here.\n\n- one\n- three\n- [ ] two\n')
  act(() => block('two').click())
  retype('two', 'second')
  press('Enter')
  await flush()
  expect(content()).toContain('\n- [ ] second\n')
})

it('keeps the text on Escape, drops it only with 취소, deletes and toggles tasks', async () => {
  mount()
  act(() => block('Intro').click())
  retype(' here.', ' kept.')
  press('Escape')
  await flush()
  expect(content()).toContain('\nIntro **text** kept.\n')
  act(() => block('Intro').click())
  retype('Intro', 'dropped')
  act(() => button('취소').click())
  expect(content()).toContain('\nIntro **text** kept.\n')
  expect(region()).toBeNull()
  expect(block('Intro').textContent).toBe('Intro text kept.')
  act(() => block('Intro').click())
  act(() => button('삭제').click())
  await flush()
  expect(content()).toBe('# Week 1\n\n- one\n- [ ] two\n')
  act(() => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
  expect(content()).toBe('# Week 1\n\n- one\n- [x] two\n')
})

it('opens the markdown for 원문 and for blocks that are not text', async () => {
  mount(SRC + '\n```python\nx = 1\n```\n')
  act(() => block('Intro').click())
  retype('Intro', 'Opening')
  act(() => button('원문').click())
  expect(region()).toBeNull()
  expect(editorText()?.value).toBe('Opening **text** here.')
  type('Opening **text** here, with $x$.')
  key('Enter', {shiftKey: true})   // not a save
  expect(editorText()).not.toBeNull()
  key('Enter')
  await flush()
  expect(content()).toContain('\nOpening **text** here, with $x$.\n')
  act(() => block('x = 1').click())
  expect(region()).toBeNull()
  expect(editorText()?.value).toBe('```python\nx = 1\n```')
  act(() => button('취소').click())
})

it('autosaves source typing a second after it stops', async () => {
  mount('x = 1\n', 'a.py', 'code')
  expect(host.querySelector('.doc-modes')).toBeNull()   // code has only its source
  act(() => useStore.getState().updateTab('f', 'x = 2\n', KEY))
  expect(host.querySelector('.doc-save')?.textContent).toBe('수정됨')
  await wait(500)
  expect(saves).not.toHaveBeenCalled()
  await wait(700)
  expect(saves).toHaveBeenCalledWith('/lec/a.py', 'x = 2\n', 'v0')
  expect(tab().dirty).toBe(false)
})

it('follows an agent write on disk, but only once the open editor is closed', async () => {
  const disk = {signature: '', content: ''}
  vi.stubGlobal('fetch', vi.fn(async (url: string) => !disk.signature ? {ok: false}
    : {ok: true, json: async () => url.startsWith('/api/file-stat') ? {signature: disk.signature} : {content: disk.content, version: 'v9'}}))
  mount()
  act(() => block('Intro').click())
  disk.signature = 's1'; disk.content = '# Week 1\n\nAgent rewrote this.\n'
  await wait(1100)
  expect(content()).toBe(SRC)
  expect(region()).not.toBeNull()
  act(() => button('취소').click())
  await wait(1100)
  expect(content()).toBe('# Week 1\n\nAgent rewrote this.\n')
  await wait(10)
  expect(block('Agent rewrote')).toBeTruthy()
})

it('stops autosave and asks when the tab and the file both changed', async () => {
  const disk = {signature: '', content: ''}
  vi.stubGlobal('fetch', vi.fn(async (url: string) => !disk.signature ? {ok: false}
    : {ok: true, json: async () => url.startsWith('/api/file-stat') ? {signature: disk.signature} : {content: disk.content, version: 'v9'}}))
  saves.mockImplementation(async () => ({ok: false, conflict: true, error: 'changed'}))
  vi.stubGlobal('confirm', () => true)
  mount('x = 1\n', 'a.py', 'code')
  act(() => useStore.getState().updateTab('f', 'x = mine\n', KEY))
  disk.signature = 's1'; disk.content = 'x = agent\n'
  await wait(1200)
  expect(host.querySelector('.doc-banner')?.textContent).toContain('둘 다 바뀌어')
  expect(host.querySelector('.doc-save')?.textContent).toBe('저장 멈춤')
  const calls = saves.mock.calls.length
  act(() => useStore.getState().updateTab('f', 'x = mine 2\n', KEY))
  await wait(1200)
  expect(saves.mock.calls.length).toBe(calls)   // no retry loop against the agent's write
  await act(async () => { button('디스크 버전 불러오기').click(); await Promise.resolve(); await Promise.resolve() })
  await flush()
  expect(content()).toBe('x = agent\n')
  expect(host.querySelector('.doc-banner')).toBeNull()
})

it('새로고침 reads an HTML file from disk at once, not the copy the tab holds', async () => {
  localStorage.removeItem('agentboard.doc.mode.html')
  mount('<p>old</p>', 'deck.html', 'code')
  await vi.waitFor(() => expect(host.querySelector('iframe')?.getAttribute('srcdoc')).toContain('old'))
  // The poll has seen nothing (an open editor holds it); only a direct read finds the agent's write.
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.startsWith('/api/file?')
    ? {ok: true, json: async () => ({content: '<p>agent</p>', version: 'v9'})} : {ok: false}))
  await act(async () => { button('새로고침').click() })
  await flush()
  expect(content()).toBe('<p>agent</p>')
  expect(host.querySelector('iframe')?.getAttribute('srcdoc')).toContain('agent')
})

it('previews an HTML page with its project\'s files and opens a linked page in a tab', async () => {
  localStorage.removeItem('agentboard.doc.mode.html')
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.startsWith('/api/preview-base?')
    ? {ok: true, json: async () => ({prefix: '/api/preview/T/', dir: 'decks/', root: '/lec'})}
    : url.startsWith('/api/file?') ? {ok: true, json: async () => ({content: '<p>next</p>', version: 'v3'})} : {ok: false}))
  mount('<img src="fig.png"><a href="next.html">next</a>', 'deck.html', 'code')
  const frame = () => host.querySelector('iframe')!
  await vi.waitFor(() => expect(frame().getAttribute('srcdoc')).toContain(`<base href="${location.origin}/api/preview/T/decks/">`))
  const token = /"token":"([^"]+)"/.exec(frame().getAttribute('srcdoc')!)![1]
  act(() => { window.dispatchEvent(new MessageEvent('message', {source: frame().contentWindow, data: {t: 'open', href: `${location.origin}/api/preview/T/decks/next.html`, __ab: token}})) })
  await vi.waitFor(() => expect(useStore.getState()._viewerState[KEY].tabs.map(t => t.path)).toContain('/lec/decks/next.html'))
})

it('saves a dirty file tab when it closes instead of asking', async () => {
  const ask = vi.fn(() => false)
  vi.stubGlobal('confirm', ask)
  mount('x = 1\n', 'a.py', 'code')
  act(() => useStore.getState().updateTab('f', 'x = 3\n', KEY))
  await act(async () => { useStore.getState().closeTab('f', KEY); await Promise.resolve(); await Promise.resolve() })
  await flush()
  expect(ask).not.toHaveBeenCalled()
  expect(saves).toHaveBeenCalledWith('/lec/a.py', 'x = 3\n', 'v0')
  expect(useStore.getState()._viewerState[KEY].tabs).toEqual([])
})
