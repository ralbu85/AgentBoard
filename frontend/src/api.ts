const BASE = ''

async function post(url: string, body: object = {}) {
  const res = await fetch(BASE + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  })
  return res.json()
}

async function get(url: string) {
  const res = await fetch(BASE + url, { credentials: 'include' })
  if (res.status === 401) throw new Error('Unauthorized')
  return res.json()
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
  saveNotes: (path: string, notes: any[]) => post('/api/notes', { path, notes }),
  deleteNote: (path: string, startLine: number, endLine: number) => post('/api/notes/delete', { path, startLine, endLine }),
  latex: (path: string) => get(`/api/latex?path=${encodeURIComponent(path)}`),
  upload: async (dir: string, file: File) => {
    const res = await fetch(`/api/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      credentials: 'include',
      body: file,
    })
    return res.json()
  },
  uploadMany: async (dir: string, files: File[] | FileList): Promise<string[]> => {
    const arr = Array.from(files)
    const results: string[] = []
    for (const f of arr) {
      const res = await fetch(`/api/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(f.name)}`, {
        method: 'POST',
        credentials: 'include',
        body: f,
      })
      const json = await res.json()
      if (json.ok && json.path) results.push(json.path)
    }
    return results
  },
}
