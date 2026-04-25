<div align="right">

**English** · [한국어](README.ko.md)

</div>

<h1 align="center">AgentBoard</h1>

<p align="center">
  <strong>Run a fleet of AI coding agents from anywhere — even your phone.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white" alt="Python 3.12">
  <img src="https://img.shields.io/badge/FastAPI-0.115+-009688?logo=fastapi&logoColor=white" alt="FastAPI">
  <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black" alt="React 19">
  <img src="https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white" alt="Vite">
  <img src="https://img.shields.io/badge/xterm.js-5.5-000000" alt="xterm.js">
</p>

---

AgentBoard is a browser-based command center for running many AI coding agents in parallel. Spawn Claude Code, Codex, Aider, or any shell-based agent in its own `tmux` session, switch between them with a tap, and pick up exactly where you left off — from your laptop, your tablet, or your phone.

> Designed for the moment your agents outgrow a single terminal tab.

## Why AgentBoard

Modern coding agents are most useful when they run for **minutes or hours**, not seconds. Soon you're juggling three, five, ten of them — and `tmux` alone gets old fast on mobile. AgentBoard wraps `tmux` in a clean dashboard that:

- **Just works on mobile.** Real touch scroll with momentum, no broken gestures, no pinch traps. Built and tuned on actual devices, not emulators.
- **Knows what each agent is doing.** Each session shows an `idle` / `working` / `waiting` badge derived from its terminal output.
- **Refuses to lose state.** Sessions live in `tmux` — they survive page reloads, server restarts, and flaky networks.
- **Is honestly fast.** 80 ms screen refresh on the session you're looking at, 2 s on the rest. Adaptive, never wasteful.

## Built for these moments

- **Long-running refactors** — kick off an agent at your desk, check its progress from your phone over coffee, tap once to send `y` when it asks for confirmation.
- **Parallel coding** — three agents on three branches, one dashboard, zero context-switching tax.
- **Pair-programming with yourself** — the same `tmux` state, viewed live from any device on the network.
- **Tablet-first development** — file browser, code editor, PDF viewer, and a live terminal — all in one tab.

## Features

| | |
|---|---|
| **Multi-session terminal** | Spawn, kill, rename, and switch between unlimited `tmux` sessions |
| **Mobile-first UI** | Custom touch handlers — momentum scroll, scroll-to-bottom, keyboard-friendly input |
| **Live state detection** | Per-session badges: `idle`, `working`, `waiting-for-input` |
| **Adaptive polling** | 80 ms on the active session, 2 s on background sessions |
| **File browser & editor** | CodeMirror 6 with syntax highlighting for 13+ languages |
| **Markdown + KaTeX** | Inline preview, sanitized, math rendered server-free |
| **PDF viewer** | Zoom (50–300%), fit-to-width, lazy-loaded for instant boot |
| **Cookie auth** | Single password, HMAC-SHA256 signed |
| **Optional Cloudflare tunnel** | Expose the dashboard publicly with one env var |
| **Survives everything** | `tmux`-backed sessions persist across reloads, restarts, and disconnects |

## Quick start

```bash
git clone https://github.com/ralbu85/AgentBoard.git
cd AgentBoard

# Backend (Python 3.12 + FastAPI)
python3.12 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt

# Frontend (React + Vite)
cd frontend && npm install && cd ..

# Configuration — path is set in backend/config.py
mkdir -p /root/TermHub
cat > /root/TermHub/.env <<EOF
DASHBOARD_PASSWORD=changeme
AGENTBOARD_PORT=3002
EOF

# Build the frontend and start the server
./deploy.sh
```

Open `http://localhost:3002`, log in, hit **+ New** — and you're spawning agents.

## Architecture

```
   Browser (xterm.js + React)
            │
            │  HTTPS / WSS
            ▼
     nginx :12019
            │
            ▼
     uvicorn :3002 ──── pipe-pane FIFO
            │           capture-pane polling
            ▼
       tmux sessions
```

| Layer | Stack |
|---|---|
| Frontend | React 19, xterm.js 5.5, Zustand, Vite, CodeMirror 6 |
| Backend | FastAPI, asyncio, `tmux` via async subprocess |
| Auth | HMAC-SHA256 signed cookie |
| Proxy | nginx (optional, recommended for HTTPS) |

## API

### REST

| Method | Path | Body |
|---|---|---|
| `POST` | `/api/login` | `{pw}` |
| `GET`  | `/api/workers` | — |
| `POST` | `/api/spawn` | `{cwd, cmd}` |
| `POST` | `/api/kill` | `{id}` |
| `POST` | `/api/remove` | `{id}` |
| `POST` | `/api/input` | `{id, text}` |
| `POST` | `/api/key` | `{id, key}` |
| `GET`  | `/api/browse?path=` | directory listing |
| `GET`  | `/api/files?path=` | file metadata |
| `GET`  | `/api/file?path=` | read file |
| `POST` | `/api/file` | `{path, content}` |
| `GET`  | `/api/health` | readiness probe |

### WebSocket `/ws`

- **Client → server:** `resize`, `active`, `resync`, `title`, `key`, `terminal-input`, `input`
- **Server → client:** `spawned`, `snapshot`, `screen`, `stream`, `status`, `cwd`, `aiState`, `info`, `title`, `titles`

## Project layout

```
backend/
  main.py            FastAPI app, lifespan, static serving
  config.py          .env loading, auth token, project root
  auth.py            HMAC-SHA256 cookie auth
  sessions.py        SessionStore: spawn / kill / recover tmux
  streamer.py        pipe-pane FIFO + capture-pane polling
  state_detector.py  idle / working / waiting heuristics
  tmux.py            async tmux wrappers
  ws.py              WebSocket routing + broadcast
  routes_session.py  REST: login, workers, spawn, kill, input
  routes_file.py     REST: browse, files, read / write
  tunnel.py          optional Cloudflare tunnel

frontend/
  src/
    App.tsx                       root + login flow
    store.ts                      Zustand state
    ws.ts                         WebSocket singleton
    api.ts                        REST wrappers
    components/Terminal/          xterm.js lifecycle, mobile scroll
    components/Sidebar/           session list, mobile overlay
    components/Viewer/            split layout, code editor, file content
    components/SpawnModal/        new-session dialog
    components/FilePanel.tsx      file browser
    components/PdfViewer.tsx      PDF rendering
    components/Header.tsx         status bar, + New
    components/Login.tsx          password login
    components/Toaster.tsx        toast notifications
```

## Notes for contributors

A few non-obvious decisions that have already burned someone:

- **Static assets are served `no-cache`.** Build outputs use fixed names (`app.js`, `index.css`); cache busting is via a `?v=<timestamp>` query injected by `deploy.sh`. **Never** add a client-side `setTimeout` auto-reload — it loops on slow mobile.
- **xterm.js native touch is disabled** (`pointer-events: none` on `.xterm*`). A custom handler on `.xterm-wrap` drives mobile scroll. Playwright's CDP touch direction is the **opposite** of real devices — trust real-device feedback over emulator output.
- **Raw stream is not applied to the client.** Pipe-pane output contains escape sequences that destroy the scrollback. The client receives `writeScreen` (in-place capture-pane) and a one-time `writeSnapshot` on session switch.
- **Always launch from the project root.** `start.sh` and `deploy.sh` handle this — they `cd` first so `backend.main` resolves correctly.

## License

Private. Not currently licensed for redistribution.
