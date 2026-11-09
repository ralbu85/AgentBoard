import {afterEach, expect, it, vi} from 'vitest'
import {checkForUpdate, useAppUpdate} from './appUpdate'

const serve = (entry: string) => vi.stubGlobal('fetch', vi.fn(async () => ({ok: true, text: async () => `<script type="module" crossorigin src="${entry}"></script>`})))
afterEach(() => { vi.unstubAllGlobals(); document.head.innerHTML = ''; useAppUpdate.setState({outdated: false}) })

it('notices a deploy when the served page names another build', async () => {
  document.head.innerHTML = '<script type="module" src="/assets/app-OLD.js"></script>'
  serve('/assets/app-OLD.js')
  expect(await checkForUpdate(true)).toBe(false)
  serve('/assets/app-NEW.js')
  expect(await checkForUpdate(true)).toBe(true)
  expect(useAppUpdate.getState().outdated).toBe(true)
})

it('stays quiet on the dev server and when the server is down', async () => {
  serve('/assets/app-NEW.js')
  expect(await checkForUpdate(true)).toBe(false)   // no built entry chunk on the page
  document.head.innerHTML = '<script type="module" src="/assets/app-OLD.js"></script>'
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline') }))
  expect(await checkForUpdate(true)).toBe(false)
})
