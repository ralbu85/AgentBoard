<p align="center">
  <img src="https://img.shields.io/badge/AgentBoard-Remote_AI_Agent_Dashboard-7c3aed?style=for-the-badge" alt="AgentBoard" />
</p>

<h1 align="center">AgentBoard v3</h1>

<p align="center">
  <a href="README.ko.md">한국어</a>
</p>

<p align="center">
  <strong>Run AI agents on your server. Monitor from any browser, anywhere.</strong><br>
  No install. No desktop app. Just open a URL — from your laptop, phone, or tablet.<br>
  A self-hosted web dashboard for managing multiple AI coding agents remotely.
</p>

<p align="center">
  <a href="#why-agentboard">Why</a> &bull;
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="#features">Features</a> &bull;
  <a href="#remote-access">Remote Access</a> &bull;
  <a href="#architecture">Architecture</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/python-%3E%3D3.12-3776AB?logo=python&logoColor=white" alt="Python" />
  <img src="https://img.shields.io/badge/react-19-61DAFB?logo=react&logoColor=white" alt="React" />
  <img src="https://img.shields.io/badge/tmux-required-1BB91F?logo=tmux&logoColor=white" alt="tmux" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" />
</p>

---

## Why AgentBoard?

AI coding agents are getting powerful enough to run autonomously for hours. But you still need to:

- **Approve actions** when they hit permission checks
- **Monitor progress** across multiple concurrent sessions
- **Review files** the agent is working on

The problem: **you can't sit in front of the terminal all day.**

Other tools (cmux, Cursor, Superset) require a desktop app and only work locally. **What if your agents run on a remote server?**

**AgentBoard is a pure web app — no install, no desktop client.** Deploy it on any server with Python and tmux, open a browser from any device, and you're in.

### How It Compares

| | cmux | Cursor | Superset | **AgentBoard** |
|---|---|---|---|---|
| **No install (just a URL)** | - | - | - | Yes |
| **Remote server access** | - | - | - | Yes |
| **Phone/tablet** | - | - | - | Yes |
| Multi-agent sessions | Yes | - | Yes | Yes |
| AI state detection | - | - | - | Yes |
| File browser + preview | - | Built-in | Diff view | Built-in |
| Self-hosted | N/A | N/A | N/A | Yes |
| Price | Free | $20/mo | Paid | Free |

---

## What's New in v3

Complete rewrite from Node.js/vanilla JS to **FastAPI + React**.

- **FastAPI backend** — async Python, uvicorn, structured API
- **React 19 + Zustand** — component-based UI, proper state management
- **xterm.js 5.5** — GPU-accelerated terminal on desktop and mobile
- **80ms polling** — near real-time terminal updates (was 500ms)
- **Per-client active tracking** — multiple browser tabs work independently
- **File browser** — navigate, preview code/markdown/PDF/images, upload
- **Syntax highlighting** — highlight.js with 14 languages, lazy loaded
- **PDF viewer** — pdf.js canvas rendering, works on mobile
- **Mobile-first** — custom touch scroll, fullscreen file viewer, native-feel UX
- **Lazy loading** — app.js 217KB initial (pdf.js/hljs loaded on demand)
- **Cursor blink filtering** — no more WS flooding from idle terminals

---

## Quick Start

```bash
# Prerequisites: Python >= 3.12, tmux, Node.js (for frontend build)
git clone https://github.com/ralbu85/AgentBoard.git
cd AgentBoard

# Setup
echo "DASHBOARD_PASSWORD=yourpassword" > .env
cd v3/backend && python -m venv .venv && .venv/bin/pip install -r requirements.txt
cd ../frontend && npm install && npx vite build

# Run
cd ../.. && v3/deploy.sh
```

Open **http://localhost:3002** — done. Click **+ New** to start a session.

### Run as a Background Service

```bash
# Using deploy.sh (recommended)
cd AgentBoard && v3/deploy.sh

# Manual
cd AgentBoard/v3
nohup ./start.sh > server.log 2>&1 &
```

---

## Features

### Multi-Agent Terminal

- **xterm.js** with GPU rendering, full ANSI color, 10000-line scrollback
- **80ms capture-pane polling** — near real-time screen updates
- **AI state detection**: Idle / Thinking / Asking / Done
- **Per-client active tracking** — each browser tab polls its own session
- **Cursor blink filtering** — no false screen updates from blinking cursors
- **Direct keyboard input** on desktop (click terminal, type)
- **Quick keys**: Esc, arrows, Enter, Tab, Ctrl+C

### File Browser & Viewer

- **Directory navigation** — browse from session's working directory
- **Code preview** — syntax highlighting via highlight.js (Python, JS/TS, Go, Rust, Java, SQL, etc.)
- **Markdown preview** — headings, bold, lists, code blocks with highlighting, blockquotes
- **PDF viewer** — pdf.js canvas rendering, page-by-page with progress
- **Image viewer** — inline display with checkerboard background
- **JSON prettify** — auto-formatted display
- **File upload** — upload to current directory
- **Fullscreen preview** on mobile, panel on desktop

### Mobile Optimized

- **Custom touch scroll** — disabled xterm.js touch handlers, native-feel momentum scroll
- **Fullscreen file viewer** — file preview takes entire screen on mobile
- **Scroll-to-bottom button** — appears when scrolled up
- **Touch-optimized buttons** — 34px+ touch targets
- **Responsive layout** — sidebar overlay, compact input card

### Session Management

- **Spawn** sessions with custom working directory and command
- **Kill / Remove** — stop running sessions, remove completed ones
- **Remove button visible** on mobile (no hover needed for stopped sessions)
- **Session recovery** — reconnects to existing tmux sessions on server restart
- **Session titles** — custom names, persisted across restarts

### Performance

- **Initial load: 217KB** (app.js) + 301KB (xterm.js) — gzip ~150KB total
- **Lazy loaded**: pdf.js (357KB), highlight.js languages — only when opening files
- **PDF worker as Blob URL** — no separate network request for worker
- **Adaptive polling**: 80ms active, 2s background
- **Per-session broadcast throttling** — prevents WS flooding

---

## Remote Access

### Tailscale (Recommended)

Access your server's Tailscale IP directly. Zero config, encrypted, no ports to open.

### Cloudflare Tunnel

Set `DISCORD_WEBHOOK` in `.env` and AgentBoard auto-starts a tunnel, posting the URL to Discord.

### nginx Reverse Proxy

```nginx
server {
    listen 443 ssl;
    location / {
        proxy_pass http://127.0.0.1:3002;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_buffering off;
        proxy_read_timeout 86400;
    }
}
```

---

## Architecture

```
v3/
├── backend/
│   ├── main.py           — FastAPI app, lifespan, static file serving
│   ├── config.py         — .env loading, auth token, project root
│   ├── auth.py           — Cookie-based auth (HMAC-SHA256)
│   ├── sessions.py       — SessionStore: spawn/kill/remove/recover tmux sessions
│   ├── streamer.py       — capture-pane polling + cursor filtering + per-client tracking
│   ├── state_detector.py — idle/working/waiting detection from terminal output
│   ├── tmux.py           — async tmux command wrappers
│   ├── ws.py             — WebSocket endpoint, message routing, broadcast
│   ├── routes_session.py — REST API: login, workers, spawn, kill, input
│   ├── routes_file.py    — REST API: browse, read/write/upload files
│   └── tunnel.py         — Cloudflare tunnel (optional)
├── frontend/
│   ├── src/
│   │   ├── App.tsx                     — Root component, login, layout
│   │   ├── store.ts                    — Zustand state management
│   │   ├── ws.ts                       — WebSocket singleton
│   │   ├── api.ts                      — REST API client
│   │   ├── components/
│   │   │   ├── Terminal/TerminalPane.tsx    — Terminal container + state badge
│   │   │   ├── Terminal/TerminalManager.ts — xterm.js lifecycle, mobile scroll
│   │   │   ├── Terminal/InputCard.tsx      — Input + quick keys + file toggle
│   │   │   ├── FilePanel.tsx               — File browser + code/md viewer
│   │   │   ├── PdfViewer.tsx               — pdf.js canvas renderer
│   │   │   ├── Sidebar/SessionList.tsx     — Session list + remove
│   │   │   └── Header.tsx                  — Status bar, + New button
│   │   └── types.ts
│   └── vite.config.ts    — Build config, chunk splitting
├── deploy.sh             — Build + restart
└── start.sh              — Server entry point
```

**Stack:**
- Backend: FastAPI + uvicorn (Python 3.12)
- Frontend: React 19 + xterm.js 5.5 + Zustand
- Terminal: tmux capture-pane polling (80ms active, 2s background)
- Highlighting: highlight.js (lazy loaded, 14 languages)
- PDF: pdfjs-dist (lazy loaded, Blob URL worker)

---

## API Reference

### REST

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/login` | Login with password |
| GET | `/api/workers` | List all sessions |
| POST | `/api/spawn` | Create new session |
| POST | `/api/kill` | Stop a session |
| POST | `/api/remove` | Remove stopped session |
| POST | `/api/input` | Send text to session |
| POST | `/api/key` | Send special key |
| GET | `/api/files?path=` | List directory |
| GET | `/api/file?path=` | Read file |
| GET | `/api/file-raw?path=` | Stream binary file |
| POST | `/api/file` | Write file |
| POST | `/api/upload` | Upload file |
| POST | `/api/delete` | Delete file/directory |

### WebSocket (`/ws`)

**Client to Server:** `resize`, `active`, `resync`, `title`, `key`, `terminal-input`, `input`

**Server to Client:** `spawned`, `snapshot`, `screen`, `status`, `cwd`, `aiState`, `info`, `title`, `titles`

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENTBOARD_PORT` or `V3_PORT` | `3002` | Server port |
| `DASHBOARD_PASSWORD` | `changeme` | Login password |
| `DISCORD_WEBHOOK` | — | Post tunnel URL to Discord |

---

## License

MIT
