import { useToasts } from './toasts'
import type { Memo } from './components/Viewer/FileContent'

const BASE = ''
// Endpoints whose failures the caller handles (we do not auto-toast).
const SILENT = new Set(['/api/login', '/api/workers', '/api/config'])

function reportFailure(url: string, body: unknown, status: number) {
  if (SILENT.has(url)) return
  const b = body as { error?: unknown; detail?: unknown } | null
  const detail = b?.error ?? b?.detail ?? (status >= 400 ? `HTTP ${status}` : 'request failed')
  const label = url.replace(/^\/api\//, '')
  useToasts.getState().push(`${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}

async function post(url: string, body: object = {}) {
  const res = await fetch(BASE + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data?.ok === false) reportFailure(url, data, res.status)
  return data
}

async function get(url: string) {
  const res = await fetch(BASE + url, { credentials: 'include' })
  if (res.status === 401) throw new Error('Unauthorized')
  const data = await res.json().catch(() => ({}))
  if (!res.ok) reportFailure(url, data, res.status)
  return data
}

export const api = {
  login: (pw: string) => post('/api/login', { pw }),
  workers: () => get('/api/workers'),
  spawn: (cwd: string, cmd = '') => post('/api/spawn', { cwd, cmd }),
  kill: (id: string) => post('/api/kill', { id }),
  remove: (id: string) => post('/api/remove', { id }),
  reconnect: (id: string) => post('/api/reconnect', { id }),
  attach: (sessionName: string, cwd: string) => post('/api/attach', { sessionName, cwd }),
  scan: () => get('/api/scan'),
  input: (id: string, text: string) => post('/api/input', { id, text }),
  paste: (id: string, text: string) => post('/api/paste', { id, text }),
  key: (id: string, key: string) => post('/api/key', { id, key }),
  config: () => get('/api/config'),
  browse: (path: string) => get(`/api/browse?path=${encodeURIComponent(path)}`),
  files: (path: string) => get(`/api/files?path=${encodeURIComponent(path)}`),
  readFile: (path: string) => get(`/api/file?path=${encodeURIComponent(path)}`),
  writeFile: (path: string, content: string) => post('/api/file', { path, content }),
  rename: (from: string, to: string) => post('/api/rename', { from, to }),
  delete: (path: string) => post('/api/delete', { path }),
  mkdir: (path: string) => post('/api/mkdir', { path }),
  loadNotes: (path: string) => get(`/api/notes?path=${encodeURIComponent(path)}`),
  saveNotes: (path: string, notes: Memo[]) => post('/api/notes', { path, notes }),
  deleteNote: (path: string, startLine: number, endLine: number) => post('/api/notes/delete', { path, startLine, endLine }),
  upload: async (dir: string, file: File) => {
    const url = `/api/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}`
    const res = await fetch(url, { method: 'POST', credentials: 'include', body: file })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data?.ok === false) reportFailure('/api/upload', data, res.status)
    return data
  },
  uploadMany: async (dir: string, files: File[] | FileList): Promise<string[]> => {
    const arr = Array.from(files)
    const results: string[] = []
    for (const f of arr) {
      const url = `/api/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(f.name)}`
      const res = await fetch(url, { method: 'POST', credentials: 'include', body: f })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json?.ok === false) {
        reportFailure('/api/upload', json, res.status)
        continue
      }
      if (json.path) results.push(json.path)
    }
    return results
  },
}
