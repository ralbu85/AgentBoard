import {act, createElement} from 'react'
import {createRoot} from 'react-dom/client'
import {afterEach, expect, it, vi} from 'vitest'
import {useFileChanges} from './docSync'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('counts a disk change once the file has stopped changing (no half-written PDFs)', async () => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  const signatures = ['a', 'a', 'b', 'c', 'c', 'c']
  let k = 0
  vi.stubGlobal('fetch', vi.fn(async () => ({ok: true, json: async () => ({signature: signatures[Math.min(k++, signatures.length - 1)]})})))
  const seen: number[] = []
  const Probe = () => { seen.push(useFileChanges('/lec/slides.pdf')); return null }
  const host = document.createElement('div'), root = createRoot(host)
  await act(async () => { root.render(createElement(Probe)) })
  for (let tick = 0; tick < 6; tick++) await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  // a (first) → a → b (moving) → c (moving again) → c (settled: 1 change) → c
  expect(seen[seen.length - 1]).toBe(1)
  expect(seen.filter((n, i) => i && n !== seen[i - 1])).toEqual([1])
  act(() => root.unmount())
})
