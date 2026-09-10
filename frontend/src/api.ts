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

async function mutate(method: string, url: string, body: object) {
  try {
    const res = await fetch(BASE + url, {
      method, headers: { 'Content-Type': 'application/json' },
      credentials: 'include', body: JSON.stringify(body),
    })
    const data = await res.json()
    if (!res.ok || data?.ok === false || data?.error) {
      reportFailure(url, data, res.status)
      return { ...data, ok: false }
    }
    return data
  } catch {
    reportFailure(url, { error: '연결 실패. 변경사항을 저장하지 못했습니다.' }, 0)
    return { ok: false }
  }
}
const post = (url: string, body: object = {}) => mutate('POST', url, body)
const put = (url: string, body: object = {}) => mutate('PUT', url, body)

async function get(url: string) {
  const res = await fetch(BASE + url, { credentials: 'include' })
  const data = await res.json()
  if (!res.ok || data?.ok === false) {
    reportFailure(url, data, res.status)
    throw new Error(data?.error || `HTTP ${res.status}`)
  }
  return data
}

export const api = {
  login: (pw: string) => post('/api/login', { pw }),
  workers: () => get('/api/workers'),
  hosts: () => get('/api/hosts'),
  spawn: (cwd: string, cmd = '', host = 'local', reqId = '') => post('/api/spawn', { cwd, cmd, host, reqId }),
  kill: (id: string) => post('/api/kill', { id }),
  remove: (id: string) => post('/api/remove', { id }),
  reconnect: (id: string) => post('/api/reconnect', { id }),
  attach: (sessionName: string, cwd: string) => post('/api/attach', { sessionName, cwd }),
  scan: () => get('/api/scan'),
  input: (id: string, text: string) => post('/api/input', { id, text }),
  paste: (id: string, text: string) => post('/api/paste', { id, text }),
  key: (id: string, key: string) => post('/api/key', { id, key }),
  config: () => get('/api/config'),
  profiles: () => get('/api/profiles'),
  saveProfiles: (profiles: object[]) => put('/api/profiles', { profiles }),
  pushKey: () => get('/api/push/key'),
  pushSubscribe: (sub: object) => post('/api/push/subscribe', sub),
  pushUnsubscribe: (endpoint: string) => post('/api/push/unsubscribe', { endpoint }),
  browse: (path: string) => get(`/api/browse?path=${encodeURIComponent(path)}`),
  files: (path: string) => get(`/api/files?path=${encodeURIComponent(path)}`),
  readFile: (path: string) => get(`/api/file?path=${encodeURIComponent(path)}`),
  gitDiff: (path: string) => get(`/api/git/diff?path=${encodeURIComponent(path)}`),
  capture: (id: string) => get(`/api/capture?id=${encodeURIComponent(id)}`),
  writeFile: (path: string, content: string, expectedVersion?: string) => post('/api/file', { path, content, expectedVersion }),
  rename: (from: string, to: string) => post('/api/rename', { from, to }),
  delete: (path: string) => post('/api/delete', { path }),
  mkdir: (path: string) => post('/api/mkdir', { path }),
  loadNotes: (path: string) => get(`/api/notes?path=${encodeURIComponent(path)}`),
  saveNotes: (path: string, notes: Memo[]) => post('/api/notes', { path, notes }),
  deleteNote: (path: string, startLine: number, endLine: number) => post('/api/notes/delete', { path, startLine, endLine }),
  upload: (dir: string, file: File, signal?: AbortSignal, onProgress?: (percent: number) => void): Promise<{ ok: boolean; path?: string; error?: string }> => new Promise(resolve => {
    const xhr = new XMLHttpRequest()
    const abort = () => xhr.abort()
    const finish = (result: { ok: boolean; path?: string; error?: string }) => {
      signal?.removeEventListener('abort', abort)
      resolve(result)
    }
    if (signal?.aborted) { finish({ ok: false, error: '취소됨' }); return }
    xhr.open('POST', `/api/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}`)
    xhr.withCredentials = true
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress?.(Math.round(e.loaded / e.total * 100)) }
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText)
        finish(xhr.status >= 200 && xhr.status < 300 && data.ok === true ? data : { ok: false, error: data.error || `HTTP ${xhr.status}` })
      } catch { finish({ ok: false, error: '서버 응답을 읽을 수 없습니다.' }) }
    }
    xhr.onerror = () => finish({ ok: false, error: '연결 실패' })
    xhr.onabort = () => finish({ ok: false, error: '취소됨' })
    signal?.addEventListener('abort', abort, { once: true })
    xhr.send(file)
  }),
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
