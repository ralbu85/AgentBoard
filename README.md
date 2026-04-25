# AgentBoard

Browser-based dashboard for managing multiple AI coding terminal sessions through `tmux`. Spawn, switch, and interact with long-running agent shells (Claude Code, Codex, Aider, etc.) from any device — including mobile.

## Features

- **Multi-session terminal** — spawn and manage multiple `tmux` sessions in one browser tab
- **Mobile-first** — custom touch scroll with momentum, works on iOS Safari and Android Chrome
- **Live state detection** — idle / working / waiting-for-input badges per session, derived from terminal output
- **Adaptive polling** — 80 ms refresh on the active session, 2 s on background sessions
- **Scrollback preserved** — capture-pane snapshots; user scroll position is kept across redraws
- **File browser** — read, edit, and upload files within the project root
- **Session persistence** — sessions survive page reloads and server restarts via `tmux`
- **Cookie auth** — single password, HMAC-signed cookie

## Architecture

```
Browser (xterm.js + React)
        │  HTTPS / WSS
        ▼
nginx :12019  ──►  uvicorn :3002
                        │
                        ▼
                  tmux sessions
```

- **Backend** — FastAPI (Python 3.12), `tmux` via async subprocess, `pipe-pane` FIFO + `capture-pane` polling
- **Frontend** — React 19, xterm.js 5.5, Zustand, Vite, CodeMirror 6, marked + KaTeX for previews
- **State detection** — heuristic parser over the latest visible buffer (`backend/state_detector.py`)

## Setup

Requirements: Python 3.12, Node 18+, `tmux`, `nginx` (optional, for reverse proxy).

```bash
# Backend
python3.12 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt

# Frontend
cd frontend && npm install && cd ..
```

Create `.env` (path is configurable in `backend/config.py`; default is `/root/TermHub/.env`):

```
DASHBOARD_PASSWORD=your-password
AGENTBOARD_PORT=3002
```

## Run

```bash
# Build frontend + restart server (preferred)
./deploy.sh

# Run backend only (dev)
./start.sh

# Frontend dev server with HMR
cd frontend && npm run dev
```

The server must be launched from the project root so `backend.main` resolves correctly — `start.sh` and `deploy.sh` handle this.

## API

### REST

| Method | Path                | Body                     |
|--------|---------------------|--------------------------|
| POST   | `/api/login`        | `{pw}`                   |
| GET    | `/api/workers`      | —                        |
| POST   | `/api/spawn`        | `{cwd, cmd}`             |
| POST   | `/api/kill`         | `{id}`                   |
| POST   | `/api/remove`       | `{id}`                   |
| POST   | `/api/input`        | `{id, text}`             |
| POST   | `/api/key`          | `{id, key}`              |
| GET    | `/api/browse?path=` | directory listing        |
| GET    | `/api/files?path=`  | file metadata listing    |
| GET    | `/api/file?path=`   | read file                |
| POST   | `/api/file`         | `{path, content}` write  |
| GET    | `/api/health`       | readiness probe          |

### WebSocket `/ws`

- Client → server: `resize`, `active`, `resync`, `title`, `key`, `terminal-input`, `input`
- Server → client: `spawned`, `snapshot`, `screen`, `stream`, `status`, `cwd`, `aiState`, `info`, `title`, `titles`

## Project Layout

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
    components/Header.tsx         status bar, + New
    components/Login.tsx          password login
```

## Notes for Contributors

- Static assets are served with `Cache-Control: no-cache`. Build outputs use fixed names (`app.js`, `index.css`); cache busting is via a `?v=<timestamp>` query injected by `deploy.sh`.
- xterm.js native touch handlers are disabled (`pointer-events: none` on `.xterm*`); a custom touch handler on `.xterm-wrap` drives mobile scroll. The CDP touch direction in Playwright is **opposite** of real devices — trust real-device feedback.
- `writeStream` (raw `pipe-pane` output) is not applied to the client; raw escape sequences shred the scrollback. The client uses in-place `writeScreen` (capture-pane) plus a one-time `writeSnapshot` on session switch.
- Never add client-side `setTimeout` auto-reload — it loops on slow mobile.

## License

Private. Not currently licensed for redistribution.
