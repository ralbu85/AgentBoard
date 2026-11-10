import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const send = vi.hoisted(() => vi.fn())
vi.mock('../../ws', () => ({ send, notifyActive: vi.fn() }))

import * as TM from './TerminalManager'

const made: string[] = []
function display(id: string, width: number, wrap?: (container: HTMLElement) => void) {
  made.push(id)
  const inst = TM.create(id)
  inst.opened = true
  const container = document.createElement('div')
  Object.defineProperty(container, 'clientWidth', { value: width, configurable: true })
  Object.defineProperty(container, 'clientHeight', { value: 600, configurable: true })
  ;(inst.term as any)._core._renderService = { dimensions: { css: { cell: { width: 8, height: 15 } } } }
  container.append(inst.el)
  document.body.append(container)
  wrap?.(container)
  return { inst, container }
}
const lastSharedReport = () => send.mock.calls.map(([m]) => m).filter(m => m.type === 'desktop-width').pop()

beforeEach(() => { send.mockClear(); TM.refreshViewports(); send.mockClear() })
afterEach(() => {
  for (const id of made.splice(0)) TM.destroy(id)
  document.body.replaceChildren()
})

it('reports a full-width pane as the width every session shares', () => {
  const { inst } = display('full', 1344)
  TM.writeSnapshot(inst.id, 'x', 168, 40, true, 1, true)
  expect(lastSharedReport()).toMatchObject({ cols: 168 })
})

it('keeps the full width when the pane is only narrow because of a split', () => {
  const { inst } = display('split', 808, container => {
    const main = document.createElement('main')
    main.className = 'main-area'
    Object.defineProperty(main, 'clientWidth', { value: 1344, configurable: true })
    const split = document.createElement('div')
    split.className = 'workbench-split'
    main.append(split)
    split.append(container)
    document.body.append(main)
  })
  TM.writeSnapshot(inst.id, 'x', 101, 40, true, 1, true)
  expect(lastSharedReport()).toMatchObject({ cols: 168 })
})

it('claims only for a window with recent input', () => {
  const now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 60000)
  try {
    const { inst } = display('forgotten', 1344)
    TM.writeSnapshot(inst.id, 'x', 168, 40, true, 1, true)
    expect(lastSharedReport()).toMatchObject({ claim: false })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    expect(lastSharedReport()).toMatchObject({ claim: true })
  } finally { clock.mockRestore() }
})

it('keeps a session at its width through a small layout change, so the app does not redraw', () => {
  vi.useFakeTimers()
  try {
    const sent = () => send.mock.calls.map(([m]) => m)
    const viewport = (id: string) => sent().filter(m => m.type === 'viewport' && m.id === id).pop()
    const { inst } = display('wide', 1344)   // 168 columns at 8px
    TM.writeSnapshot(inst.id, 'x', 168, 40, true, 1, true)
    expect(lastSharedReport()).toMatchObject({ cols: 168 })
    const { inst: jiggle } = display('jiggle', 1280)   // 160: within 10%, scaled instead
    TM.writeSnapshot(jiggle.id, 'x', 168, 40, true, 1, true)
    vi.advanceTimersByTime(400)
    expect(viewport('jiggle')).toMatchObject({ cols: 168 })
    expect(sent().some(m => m.cols === 160)).toBe(false)
    const { inst: narrow } = display('narrow', 800)   // 100: too small to scale
    TM.writeSnapshot(narrow.id, 'x', 168, 40, true, 1, true)
    vi.advanceTimersByTime(400)
    expect(viewport('narrow')).toMatchObject({ cols: 100 })
    expect(lastSharedReport()).toMatchObject({ cols: 100 })
  } finally { vi.useRealTimers() }
})

it('gives a bigger font its own width instead of scaling it back down', () => {
  vi.useFakeTimers()
  try {
    const viewport = () => send.mock.calls.map(([m]) => m).filter(m => m.type === 'viewport' && m.id === 'font').pop()
    const { inst } = display('font', 1344)   // 168 columns at 8px
    TM.writeSnapshot(inst.id, 'x', 168, 40, true, 1, true)
    vi.advanceTimersByTime(400)
    expect(viewport()).toMatchObject({ cols: 168 })
    ;(inst.term as any)._core._renderService.dimensions.css.cell.width = 8.5   // A+: 158 columns, within 10%
    TM.refit(inst.id)
    vi.advanceTimersByTime(400)
    expect(viewport()).toMatchObject({ cols: 158 })
    expect(lastSharedReport()).toMatchObject({ cols: 158 })
    TM.refit(inst.id)   // still waiting for the new grid: keeps asking for it
    vi.advanceTimersByTime(400)
    expect(viewport()).toMatchObject({ cols: 158 })
  } finally { vi.useRealTimers() }
})
