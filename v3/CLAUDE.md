# AgentBoard (TermHub v3)

Browser-based dashboard for managing multiple AI terminal sessions via tmux.

## Architecture

**Backend**: FastAPI + uvicorn (Python 3.12)
**Frontend**: React 19 + xterm.js 5.5 + Zustand
**Proxy**: nginx on port 12019 → backend on port 3002
**Terminal**: tmux sessions, capture-pane polling (80ms active, 2s background)

### Backend (`backend/`)
- `main.py` — FastAPI app, lifespan, static file serving (no-cache on all assets)
- `config.py` — .env loading, auth token, project root
- `auth.py` — Cookie-based auth (HMAC-SHA256)
- `sessions.py` — SessionStore: spawn/kill/remove/recover tmux sessions
- `streamer.py` — pipe-pane FIFO streaming + capture-pane polling + state detection
- `state_detector.py` — idle/working/waiting detection from terminal output
- `tmux.py` — async tmux command wrappers
- `ws.py` — WebSocket endpoint, message routing, broadcast
- `routes_session.py` — REST API: login, workers, spawn, kill, input, key
- `routes_file.py` — REST API: browse, files, read/write/upload
- `tunnel.py` — Cloudflare tunnel (optional)
- `models.py` — Pydantic request models

### Frontend (`frontend/`)
- `src/App.tsx` — Root component, login flow, layout
- `src/store.ts` — Zustand state (sessions, activeId, titles)
- `src/ws.ts` — WebSocket singleton, message routing
- `src/api.ts` — REST API fetch wrappers
- `src/components/Terminal/TerminalManager.ts` — xterm.js lifecycle, mobile scroll
- `src/components/Terminal/TerminalPane.tsx` — Terminal container + scroll-to-bottom button
- `src/components/Terminal/InputCard.tsx` — Input textarea + quick keys
- `src/components/Sidebar/` — Session list, sidebar overlay (mobile)
- `src/components/Header.tsx` — Status bar, + New button
- `src/components/Login.tsx` — Password login

## Commands

```bash
# Setup
cd /workspace/BALAB_Prof/agentboard
backend/.venv/bin/pip install -r backend/requirements.txt
cd frontend && npm install

# Deploy (build + restart)
./deploy.sh

# Start only
./start.sh

# Test (mobile emulation via Playwright)
backend/.venv/bin/python test-mobile.py
```

## Key Design Decisions

### Terminal Output
- `writeScreen` (capture-pane polling 80ms) — overwrites visible area in-place with `\x1b[H` + lines + `\x1b[J`
- `writeStream` (pipe-pane FIFO) — disabled on client because raw escape sequences destroy scrollback
- `writeSnapshot` (capture-pane -S -2000) — one-time on session switch
- When user scrolls up: writeScreen still runs but **preserves scroll position** via saved scrollTop

### Mobile Scroll (CRITICAL)
- xterm.js touch handlers are disabled via `pointer-events: none` on `.xterm`, `.xterm-viewport`, `.xterm-screen`
- Custom touch scroll on `.xterm-wrap`: `vp.scrollTop += dy` on touchmove
- Momentum: velocity tracking + requestAnimationFrame decay (0.93)
- **Direction**: `dy = lastY - y`, then `scrollTop += dy` (finger up → dy positive → scrollTop increases → see earlier content)
- CDP touch simulation has OPPOSITE direction from real mobile — trust user feedback over tests
- Scroll-to-bottom button appears when `_userScrolledUp` is true

### Caching
- All assets served with `Cache-Control: no-cache, no-store, must-revalidate` via nginx
- No content-hash filenames (fixed names: app.js, index.css)
- Query string `?v=timestamp` added by deploy.sh for cache busting
- NEVER add client-side setTimeout auto-reload — causes infinite loops on slow mobile

### Server Startup
- Must run from project root: `cd /workspace/BALAB_Prof/agentboard && python -m backend.main`
- Always use `deploy.sh` or `start.sh` — they set correct cwd
- Module resolution: `backend.main` (not `v3.backend.main`)

## Environment

- `.env` at `/root/TermHub/.env`: `DASHBOARD_PASSWORD`, `V3_PORT`/`AGENTBOARD_PORT`
- nginx config: `/etc/nginx/gateway.d/port_12019.conf` → proxy to :3002
- Python venv: `backend/.venv` (Python 3.12 via conda)
- Node: system node with npm

## API Reference

### REST
- `POST /api/login` — `{pw}` → cookie
- `GET /api/workers` — session list
- `POST /api/spawn` — `{cwd, cmd}`
- `POST /api/kill` — `{id}`
- `POST /api/remove` — `{id}`
- `POST /api/input` — `{id, text}`
- `POST /api/key` — `{id, key}`
- `GET /api/browse?path=` — directory listing
- `GET /api/files?path=` — file listing with metadata
- `GET /api/file?path=` — read file
- `POST /api/file` — `{path, content}` write file

### WebSocket (`/ws`)
Client→Server: `resize`, `active`, `resync`, `title`, `key`, `terminal-input`, `input`
Server→Client: `spawned`, `snapshot`, `screen`, `stream`, `status`, `cwd`, `aiState`, `info`, `title`, `titles`

## Test Environment

```bash
# Playwright mobile emulation test
backend/.venv/bin/python test-mobile.py

# Tests: login, UP/DOWN scroll, momentum, position preservation,
#        scroll-to-bottom button, send button
# Note: CDP touch direction is OPPOSITE of real device
```
