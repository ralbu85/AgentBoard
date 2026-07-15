# AgentBoard

Browser-based dashboard for managing multiple AI terminal sessions via tmux.

## Architecture

**Backend**: FastAPI + uvicorn (Python 3.12)
**Frontend**: React 19 + xterm.js 5.5 + Zustand + Vite + CodeMirror 6
**Proxy**: nginx on port 12019 → backend on port 3002
**Terminal**: tmux sessions, capture-pane polling (80 ms active, 2 s background)

### Multi-machine (Hub + Agent)
AgentBoard aggregates tmux sessions from several PCs in one dashboard. The existing
backend is the **hub** (serves browsers). Each remote PC runs a lightweight **agent**
(`agent/`) that dials OUTBOUND to the hub (`/agent-ws`) — works behind NAT. The agent
reuses the backend's `tmux`/`sessions`/`streamer`/`state_detector` modules in its own
process, so each agent has its own private module globals (no cross-process sharing).
The hub is a pure relay for remote hosts: it never runs streamer/tmux for a remote id.

- Hub-local sessions keep bare ids (`"3"`), host implicitly `"local"` — unchanged.
- Remote sessions are exposed to browsers as `"<host>:<localId>"` (e.g. `office:3`).
- ID translation happens in exactly two places: ingest (`agent_ws` → `namespace.prefix_msg`)
  and egress (`ws`/`routes_session` → `namespace.split_id`).
- Agent↔hub protocol = the existing browser protocol verbatim; the hub just adds a
  `host` tag on ingest. New control frames: `register`/`register-ack`/`ping`/`pong`.
- Adding a machine: on the remote PC, clone repo + venv, then `agent/start-agent.sh`
  with `AGENT_HUB_URL`, `AGENT_TOKEN`, `AGENT_HOST_ID`, `AGENT_HOST_LABEL`.

### Backend (`backend/`)
- `main.py` — FastAPI app, lifespan, static file serving (no-cache on all assets)
- `agents.py` — AgentRegistry: connected agents + per-host session mirror (hub only)
- `agent_ws.py` — `/agent-ws` endpoint: register/token auth, ingest relay (hub only)
- `commands.py` — `apply_command(store, streamer, tmux, msg)`: single mutation point
  shared by the hub's local path and every agent
- `namespace.py` — `split_id`/`prefix_id`/`prefix_msg` for cross-machine session ids
- `config.py` — .env loading, auth token, project root
- `auth.py` — Cookie-based auth (HMAC-SHA256), per-IP login throttling
- `logger.py` — structured logging (no `print`, no silent `except`)
- `sessions.py` — SessionStore: spawn / kill / remove / recover tmux sessions
- `streamer.py` — pipe-pane FIFO streaming + capture-pane polling + state detection
- `state_detector.py` — idle / working / waiting detection from terminal output
- `tmux.py` — async tmux command wrappers
- `ws.py` — WebSocket endpoint, auth check, message routing, broadcast
- `routes_session.py` — REST: login, workers, spawn, kill, input, key, health
- `routes_file.py` — REST: browse, files, read / write / upload (path-traversal safe)
- `tunnel.py` — Cloudflare tunnel (optional)
- `push.py` — Web Push (VAPID): fires an OS notification when a session goes
  `waiting`/`completed`; subscriptions persisted, deduped per session
- `models.py` — Pydantic request models with length limits

### Frontend (`frontend/src/`)
- `App.tsx` — root, login flow, layout
- `main.tsx` — entry point
- `store.ts` — Zustand state (sessions, activeId, titles, toasts)
- `ws.ts` — WebSocket singleton with exponential-backoff reconnect
- `api.ts` — REST API fetch wrappers
- `markdown.ts` — marked + KaTeX inline rendering
- `sanitize.ts` — DOMPurify wrapper for `dangerouslySetInnerHTML`
- `toasts.ts` — toast helpers
- `types.ts`, `globals.d.ts` — shared types
- `components/Terminal/`
  - `TerminalManager.ts` — xterm.js lifecycle, mobile scroll, snapshot/screen application
  - `TerminalPane.tsx` — terminal container + scroll-to-bottom button
  - `InputCard.tsx` — input textarea + quick keys
- `components/Sidebar/` — session list with filter, mobile overlay
- `components/Viewer/` — split layout, code editor, file content, PDF, Jupyter notebook (read-only render, ✎ → raw JSON), resizer
- `components/SpawnModal/` — new-session dialog
- `components/FilePanel.tsx` — file browser
- `components/PdfViewer.tsx` — PDF rendering (pdfjs-dist, lazy-loaded)
- `components/Header.tsx` — status bar, + New
- `components/Login.tsx` — password login
- `components/Toaster.tsx` — toast container

## Commands

```bash
# Setup
cd /workspace/BALAB_Prof/agentboard
backend/.venv/bin/pip install -r backend/requirements.txt
cd frontend && npm install

# Build + restart (production)
./deploy.sh                                 # builds frontend, restarts server, polls /api/health

# Backend only
./start.sh

# Frontend dev with HMR (proxies API to :3002)
cd frontend && npm run dev
```

## Key Design Decisions

### Terminal Output
- `writeScreen` (capture-pane polling 80 ms) — overwrites visible area in-place with `\x1b[H` + lines + `\x1b[J`
- `writeStream` (pipe-pane FIFO) — **disabled on client** because raw escape sequences destroy scrollback
- `writeSnapshot` (capture-pane -S -2000) — one-time on session switch, **applied atomically** (single `terminal.write` of full payload)
- When user scrolls up: writeScreen still runs but **preserves scroll position** via saved scrollTop
- Adaptive cadence: active session = 80 ms, background sessions = 2 s

### Mobile (CRITICAL)
- xterm.js native touch is disabled via `pointer-events: none` on `.xterm`, `.xterm-viewport`, `.xterm-screen`
- Custom touch scroll on `.xterm-wrap`: `vp.scrollTop += dy` on touchmove
- Momentum: velocity tracking + `requestAnimationFrame` decay (0.93)
- **Direction**: `dy = lastY - y`, then `scrollTop += dy` (finger up → dy positive → scrollTop increases → see earlier content)
- **CDP touch simulation has OPPOSITE direction from real mobile** — trust user feedback over Playwright output
- Scroll-to-bottom button shows when `_userScrolledUp`
- Symmetric font scaling on virtual keyboard show/hide (otherwise viewport jumps)

### Caching
- All assets: `Cache-Control: no-cache, no-store, must-revalidate`
- Fixed filenames (`app.js`, `index.css`) — no content hashes
- Cache-bust via `?v=<timestamp>` injected by `deploy.sh`
- **NEVER add client-side `setTimeout` auto-reload** — loops on slow mobile

### Server Startup
- Always run from project root: `cd /workspace/BALAB_Prof/agentboard && python -m backend.main`
- `start.sh` and `deploy.sh` handle this — use them, don't invent commands
- Module name is `backend.main` (no `v3.` prefix — legacy)
- `deploy.sh` polls `/api/health` for readiness, doesn't `sleep`

### Concurrency
- `spawn()` reserves the session id **synchronously** before the first await — fixes a race that produced duplicate ids
- WebSocket reconnect uses **exponential backoff** — naive reconnect floods on outage
- WebSocket upgrade authenticates the cookie — never trust the connection

### Security
- Pydantic models on every endpoint with explicit length limits
- Path traversal blocked in file API (resolved path must stay under project root)
- tmux `pipe-pane` shell command is **defanged** — session ids/paths are validated, not interpolated raw
- HTML through `dangerouslySetInnerHTML` is sanitized via `sanitize.ts` (DOMPurify)
- Login throttled per IP

## Pitfalls — don't repeat these

> Each entry comes from an actual bug or scope decision. Read before "improving" the relevant area.

### Terminal / rendering
- **Don't apply snapshots incrementally.** Stacks the scrollback every switch. Build the full payload, write once.
- **Don't pipe raw `pipe-pane` output to xterm.** Escape sequences shred the scrollback. We poll `capture-pane` instead.
- **Don't `screen`-broadcast (visible-only) when scrollback grew between polls.** `capture-pane -S 0` only sees the post-burst viewport, so anything that scrolled off during a fast burst (`cat largefile`) vanishes from the client. `_poll_active` re-snapshots when scrollback grows. Stream-style append doesn't work here either — it duplicates already-visible lines and leaves cursor in the wrong row. Atomic snapshot is the only correct option.
- **Don't trust `#{history_size}` as the scrollback-growth signal.** At the history-limit cap tmux trims the oldest lines in *batches*, so the size oscillates and even **shrinks** while new lines keep scrolling in (measured: 1964→1865 right after 500 new lines) — size-only detection silently drops the last burst. `_poll_active` compares the last 5 scrollback lines (`capture-pane -S -5 -E -1`) as the primary signal; trims eat the top, so the bottom only changes on real growth.
- **Don't re-broadcast growth snapshots unthrottled.** While a session streams, history grows on nearly every 80 ms poll — unthrottled that's a full 2000-line ANSI snapshot per poll. `SNAPSHOT_MIN_INTERVAL` (0.5 s) gates them; cheap `screen` frames keep the visible area fresh in between. Keep the growth baseline unchanged while throttled so the growth is retried, not lost.
- **Don't apply a snapshot while the user is scrolled up.** `writeSnapshot` erases the whole buffer (`\x1b[3J`) and pins to bottom — during streaming that yanks the reader to the bottom every snapshot ("scroll is broken"). `TerminalManager` defers the *latest* snapshot while `isScrolledUp` and flushes it when the viewport returns to the bottom (writeScreen / scrollToBottom / TerminalPane's 300 ms poll).
- **`alternate-screen off` blocks the alt-screen *exit* sequence too — a pane already inside gets STUCK.** Restarting the app does NOT help: the old app's leave-alt sequence is ignored, `#{alternate_on}` stays 1, and the relaunched app renders into the alt grid where scrollback never accumulates ("exit하고 재시작해도 스크롤 안 됨"). Fix: while a pane reports alt-screen, the streamer grants a window-*local* `alternate-screen on` so the app's eventual exit is honored, then removes the override once it leaves (re-blocking entry) — see `_update_info` / `tmux.allow_alt_screen_exit`. Every stuck pane converges at its app's next exit.
- **A user's `.bashrc` `cd` overrides the spawn cwd for `bash` sessions.** `tmux new-session -c <folder> bash` starts bash in the folder, then `.bashrc` runs and can `cd` elsewhere — the `-c` flag is fine, don't debug tmux. On this box `/root/.bashrc` had an unconditional `cd /workspace`; it's now guarded with `[ "$PWD" = "$HOME" ]` (machine config, not in this repo). `claude`-profile spawns are unaffected (`sh -c` doesn't read `.bashrc`).
- **Don't fight xterm's touch handlers — disable them.** `pointer-events: none` on `.xterm*` and ride your own.
- **Don't trust Playwright/CDP touch direction.** It's inverted vs real devices. Verify on a phone.
- **Don't tune polling globally.** Adaptive only — active fast, background slow.
- **`capture-pane` carries NO cursor position — send it separately or typing lands wrong.** A frame rendered from capture alone leaves the client cursor at the end of the content, not where tmux's pane cursor is (desktop direct-typing then edits at the wrong column). `tmux.capture_with_cursor` chains `display-message #{cursor_x};#{cursor_y};#{cursor_flag}` onto the SAME capture invocation (no extra subprocess) and `streamer._cursor_suffix` appends a RELATIVE move (`\r`, CUU/CUD, CUF) after the frame — relative so the one suffix is correct for both `screen` frames and snapshots regardless of client row count. A cursor move with no content change still counts as a change (arrowing a prompt).
- **Load `@xterm/addon-unicode11` — it's installed but inert without `unicode.activeVersion='11'`.** xterm's default width table disagrees with tmux on some emoji; every box-drawing border after a mismeasured glyph shifts right (Claude Code UI is emoji-heavy). Two lines in `TerminalManager.create`.
- **Batch liveness checks — one `list-sessions`, not N `has-session`.** `_poll_background` forked `tmux has-session` per session every 2 s (17 sessions = 17 forks/cycle). `list_sessions()` returns all live names in one call; empty set == server down == all dead. (The per-session `display_info`+tail capture for state detection still forks 2×/session/cycle — that's the dominant background cost, a later optimization.)

### Mobile / UI
- **Don't auto-reload from the client.** Slow mobile + reload script = infinite loop. Cache-bust on the server side instead.
- **Don't asymmetrically resize fonts on keyboard show/hide.** Viewport jitters; users lose their place.
- **Don't apply every `visualViewport` resize to `--vvh` (app height).** The keyboard slide fires a burst of resizes (per-frame app reflow = "화면이 보였다 안 보였다" flicker), and the Korean IME suggestion bar toggles ~50px on nearly every keystroke. `main.tsx` debounces to settle-once (120 ms) and ignores <100px wobbles while an input is focused (re-synced on `focusout`).
- **Don't forget to re-fit the terminal on session switch and font change.** Saved scrollTop must be restored after fit.

### Concurrency
- **Don't `await` before reserving a session id in `spawn()`.** Two parallel spawns will collide. Reserve sync, fill async.
- **Don't reconnect the WebSocket on a tight loop.** Backoff exponentially with a cap.
- **Don't `write_text` JSON state in-place.** A SIGTERM between truncate and write leaves a half-written file; on next start `_load_titles` parsed an empty/garbage file, reset `_titles` to `{}`, and the next save committed the wipe to disk. Atomic write (`tmp + os.replace`) + don't auto-overwrite an unparseable file (rename to `.corrupt-<ts>` first) — see `sessions.py`.

### Security
- **Don't accept untyped JSON.** Pydantic + max-length on every model — we got bit by huge payloads.
- **Don't `dangerouslySetInnerHTML` raw markdown output.** Sanitize first.
- **Don't interpolate user values into shell commands** (looking at you, `pipe-pane`). Validate or escape.
- **Don't `os.path.join(root, user_path)` and call it done.** Resolve and re-check `is_relative_to(root)` to block `..`.
- **Don't authenticate only the WS handshake URL.** Verify the cookie on every upgrade.
- **Don't keep silent `except:` blocks.** Use the structured logger.
- **Don't serve static files without containing the resolved path.** `serve_spa` in `main.py` joins the URL onto `dist/`; without `resolve()` + `is_relative_to(dist)` a `/..%2f..%2fetc/passwd` reads arbitrary files **unauthenticated** (this route has no auth dep). Was a live CRITICAL bug — fixed. Mirror the file API's `_safe_path`.
- **Don't bind the backend to `0.0.0.0`.** nginx (same host) is the only ingress; loopback bind (`AGENTBOARD_HOST`, default `127.0.0.1`) keeps `:3002` off the network so nothing bypasses the proxy. Remote agents come in via nginx→`/agent-ws`, not direct.
- **Don't let the default password (`changeme`) boot a real server.** The token is a deterministic hash of it → auth bypass. `main.py` raises unless `AGENTBOARD_ALLOW_DEFAULT_PW=1`.
- **Use `hmac.compare_digest` for every token/cookie compare** (`auth.py`, login, `agent_ws`). Plain `==` is timing-variable.

### Multi-machine (Hub + Agent)
- **Don't run streamer/tmux on the hub for a remote id.** The hub relays remote
  hosts; only the owning agent process touches that machine's tmux. The hub runs
  streamer/tmux *only* for `host="local"`.
- **Don't run an agent on the hub machine.** `host="local"` already covers it; a
  co-located agent would fight over the same tmux server and `/tmp` FIFOs.
- **Don't leak a bare id to the browser.** Every agent→browser frame must pass
  through `namespace.prefix_msg` (one call site in `agent_ws`), or a remote id
  collides with a local one.
- **Don't forget to demote the previous active host.** On session switch the hub
  sends `active:""` to the host that lost its last viewer, else it keeps polling
  at 80 ms forever (`ws._handle_active` / `_release_remote`).
- **Don't cap the agent WS frame size.** A 2000-line ANSI snapshot can exceed the
  `websockets` 1 MB default — the agent connects with `max_size=None`. Relay
  snapshots verbatim; never chunk them (shreds scrollback).
- **Don't bump session-id Pydantic limits back to 64.** Prefixed ids (`host:localId`)
  need `max_length=128` or remote commands 422.
- **Don't let agents talk plaintext.** `ws://` exposes the agent token (full remote
  shell). The agent refuses it unless `AGENT_INSECURE=1`.
- **Reject a re-registering host by evicting the stale conn, not with 4409.** A dropped
  TCP link lingers until uvicorn's ping timeout (~20-30 s); rejecting the reconnect
  blocks recovery that whole time. `agent_ws` closes the old ws and the old handler's
  `finally` no-ops via a conn-identity guard (`registry.get(host) is conn`).
- **Resume `active` on agent reconnect.** The agent starts with empty active state, so
  the hub replays `active` (with each viewer's `wsId`) for sessions in `_ws_remote` —
  else remote terminals silently drop to 2 s background polling after every blip.
- **Key remote `active` by the browser's `wsId`.** The agent tracks viewers per hub
  ws_id; without it, multiple browsers viewing one host collapse onto one poll slot.
- **Mirror remote titles + cap the mirror.** `AgentConn.titles` feeds late-joiner
  replay (`mirror_titles`); `MAX_SESSIONS_PER_HOST` bounds a rogue agent's memory use.
- **Never drop durable agent frames under backpressure.** The agent's send queue sheds
  oldest `screen` frames only; `spawned/removed/status/snapshot/...` must survive or the
  hub mirror desyncs (killed session stuck "running", lost scrollback).
- **Correlate remote spawns with `reqId`.** The browser can't use the REST reply's id
  (the agent assigns it); it matches the `spawned` event's echoed `reqId` — robust to
  concurrent spawns. Spawn failures surface via a `spawn-error` frame.

### Notifications (Web Push)
- **Hook pushes into `ws.broadcast`, not `streamer._detect_state`.** Broadcast is
  the one choke point both local *and* remote (agent-relayed) state changes pass
  through with correct prefixed ids. `push.maybe_push` inspects each frame.
- **Dedup per session or you spam.** `push._last_state` latches waiting/completed
  and resets on working/idle/running, so re-broadcasts don't re-notify.
- **The service worker must NOT cache app assets.** `sw.js` only renders push +
  handles clicks. Caching would serve stale JS — the app is cache-busted server-side.
- **iOS only delivers Web Push to an installed PWA.** Manifest + apple-touch-icon +
  "add to home screen" are required on iPhone; Android/desktop Chrome push in-tab.
- **`.vapid_private.pem` and `.push-subs.json` are secrets/state — gitignored.**
  The VAPID keypair is generated once on first run and must persist (regenerating
  invalidates every existing subscription).

### Out of scope (intentionally removed)
- **Server-side LaTeX rendering.** Heavy, error-prone, slow. Removed in `22238eb`. Use client-side KaTeX.
- **Playwright screenshot loops for visual verification.** User runs visual checks manually. Don't add automated UI screenshot tests — see feedback memory.

### Deployment
- **Don't `sleep` to wait for the server.** Poll `/api/health`. Failed health = exit non-zero from `deploy.sh`.
- **Don't keep nested `v2/`, `v3/` folders.** Repo is now AgentBoard-only at the root. The `/root/TermHub/` directory still exists on the dev box for the legacy `.env` location, but it's not part of this repo.
- **Don't commit `*.png` debug screenshots, `server.log`, `.session-titles.json`, `node_modules/`, or `yarn.lock`.** All gitignored — keep them so.

## Environment

- `.env` at `/root/TermHub/.env` (legacy path; configurable in `backend/config.py`): `DASHBOARD_PASSWORD`, `AGENTBOARD_PORT` (or legacy `V3_PORT`)
  - Multi-machine / security knobs: `AGENT_TOKEN` (remote-agent secret; defaults to `AUTH_TOKEN`), `AGENTBOARD_HOST` (bind addr, default `127.0.0.1`), `AGENTBOARD_COOKIE_SECURE=1` (HTTPS-only cookie), `AGENTBOARD_ALLOW_DEFAULT_PW=1` (allow the `changeme` default — dev only; the server otherwise refuses to start)
  - Terminal knobs: `AGENTBOARD_NO_ALT_SCREEN` (default `1`) — sets tmux `alternate-screen off` globally (on spawn + recover), so full-screen apps (Claude Code, vim, less) render into the normal buffer and xterm gets real scrollback; set to `0` to restore native alt-screen behavior. Panes already inside an alt-screen are auto-unstuck by the streamer at their app's next exit (window-local override — see Pitfalls). `AGENTBOARD_HISTORY_LIMIT` (default `50000`) — tmux scrollback depth for new panes (tmux's own default 2000 fills in minutes). `AGENTBOARD_SNAPSHOT_MIN_INTERVAL` (default `0.5`) — min seconds between history-growth re-snapshots.
- nginx config: `/etc/nginx/gateway.d/port_12019.conf` → proxy to `:3002` (backend binds loopback only; nginx is the sole ingress)
- Python venv: `backend/.venv` (Python 3.12 via conda)
- Node: system node with npm
- Process manager: supervisord (`agentboard` program), falls back to `nohup` in `deploy.sh`

## API Reference

### REST
- `POST /api/login` — `{pw}` → cookie
- `GET  /api/workers` — session list (local sessions only; remote arrive via WS mirror)
- `GET  /api/hosts` — machines available for spawn (`local` + connected agents)
- `POST /api/spawn` — `{cwd, cmd, host}` (host defaults to `local`)
- `POST /api/kill` — `{id}` (id may be `host:localId` for a remote session)
- `POST /api/remove` — `{id}`
- `POST /api/input` — `{id, text}`
- `POST /api/key` — `{id, key}`
- `GET  /api/browse?path=` — directory listing
- `GET  /api/files?path=` — file listing with metadata
- `GET  /api/file?path=` — read file
- `POST /api/file` — `{path, content}` write file
- `GET  /api/push/key` — VAPID public key (applicationServerKey)
- `POST /api/push/subscribe` — `{endpoint, keys, expirationTime}` store a browser push subscription
- `POST /api/push/unsubscribe` — `{endpoint}`
- `GET  /api/health` — readiness probe (used by `deploy.sh`)

### WebSocket (`/ws`)
- Client → server: `resize`, `active`, `resync`, `title`, `key`, `terminal-input`, `input`
- Server → client: `spawned`, `snapshot`, `screen`, `stream`, `status`, `removed`, `cwd`, `aiState`, `info`, `title`, `titles` (remote msgs also carry `host`/`hostLabel`)

### WebSocket (`/agent-ws`) — remote agents only
- Agent → hub: `register` (first frame, `{token, host, label}`), then the same events
  as Server → client above (bare local ids), plus `pong`
- Hub → agent: `register-ack`, the same commands as Client → server above (bare ids),
  plus `spawn`/`kill`/`remove`, `ping`

## Repo state (April 2026)

- GitHub: `https://github.com/ralbu85/AgentBoard.git`
- Default branch: `main` (renamed from `ui-revamp` during cleanup)
- Single source of truth: this directory. Old `v2/`, `v3/`, and stale feature branches were removed from the remote.
- The `/root/TermHub/` directory on the dev box is a stale local clone with the old monorepo layout — **don't push from there**, only this directory pushes.
