import {expect, it, vi} from 'vitest'
import {uiId} from './uiId'
import {newLeaf} from './components/Viewer/layout'

it('creates panes on LAN HTTP where randomUUID is unavailable', () => {
  vi.stubGlobal('crypto', {getRandomValues: crypto.getRandomValues.bind(crypto)})
  try {
    const a = newLeaf(['terminal:1'])
    const b = newLeaf(['terminal:2'])
    expect(a.id).toMatch(/^[a-f0-9]{32}$/)
    expect(b.id).not.toBe(a.id)
    expect(uiId()).not.toBe(b.id)
  } finally { vi.unstubAllGlobals() }
})
