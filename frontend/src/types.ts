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
  altScreen?: boolean     // full-screen app (vim/TUI) active → no scrollback
  host: string            // 'local' for the hub's own machine, else the agent's host id
  hostLabel?: string      // human-friendly machine name
}

export interface HostInfo {
  host: string
  label: string
  online: boolean
}

export interface SpawnProfile {
  id: string
  label: string
  icon: string
  command: string
  default?: boolean
}

export interface FileEntry {
  name: string
  type: 'dir' | 'file'
  size: number
  mtime: number
}

// WebSocket messages server → client.
// Remote (agent) messages additionally carry host/hostLabel, added by the hub.
export type WsMessage =
  | { type: 'spawned'; id: string; cwd: string; cmd: string; status: string; sessionName: string; host?: string; hostLabel?: string; reqId?: string }
  | { type: 'snapshot'; id: string; data: string }
  | { type: 'screen'; id: string; data: string }
  | { type: 'stream'; id: string; data: string }
  | { type: 'status'; id: string; status: string }
  | { type: 'removed'; id: string }
  | { type: 'cwd'; id: string; cwd: string }
  | { type: 'aiState'; id: string; state: string }
  | { type: 'info'; id: string; process: string; createdAt: number; memKB: number; altScreen?: boolean }
  | { type: 'title'; id: string; title: string }
  | { type: 'titles'; titles: Record<string, string> }
  | { type: 'spawn-error'; reqId: string; error: string; host?: string; hostLabel?: string }
  | { type: 'tunnel'; url: string }
