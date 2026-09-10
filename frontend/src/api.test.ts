import { afterEach, expect, it, vi } from 'vitest'
import { api } from './api'
afterEach(() => vi.unstubAllGlobals())
it('marks HTTP write errors as failures even without an ok field', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 })))
  expect(await api.writeFile('/project/a.py', 'text')).toMatchObject({ ok: false })
})
it('keeps network and malformed responses from looking like successful saves', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
  expect(await api.writeFile('/project/a.py', 'text')).toMatchObject({ ok: false })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>error</html>', { status: 502 })))
  expect(await api.writeFile('/project/a.py', 'text')).toMatchObject({ ok: false })
})
it('rejects failed reads instead of displaying an empty file', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Too large' }), { status: 413 })))
  await expect(api.readFile('/project/a.ipynb')).rejects.toThrow('Too large')
})
