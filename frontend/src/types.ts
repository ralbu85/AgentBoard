export interface Session {
  id: string
  sessionName: string
  cwd: string
  cmd: string
  status: 'running' | 'stopped' | 'completed'
  aiState: string | null
  process: string
  createdAt: number
  memKB: number
}

export interface FileEntry {
  name: string
  type: 'dir' | 'file'
  size: number
  mtime: number
}

// WebSocket messages server → client
export type WsMessage =
  | { type: 'spawned'; id: string; cwd: string; cmd: string; status: string; sessionName: string }
  | { type: 'snapshot'; id: string; data: string }
  | { type: 'screen'; id: string; data: string }
  | { type: 'stream'; id: string; data: string }
  | { type: 'status'; id: string; status: string }
  | { type: 'cwd'; id: string; cwd: string }
  | { type: 'aiState'; id: string; state: string }
  | { type: 'info'; id: string; process: string; createdAt: number; memKB: number }
  | { type: 'title'; id: string; title: string }
  | { type: 'titles'; titles: Record<string, string> }
  | { type: 'tunnel'; url: string }
