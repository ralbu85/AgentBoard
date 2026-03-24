<p align="center">
  <img src="https://img.shields.io/badge/AgentBoard-Remote_AI_Agent_Dashboard-7c3aed?style=for-the-badge" alt="AgentBoard" />
</p>

<h1 align="center">AgentBoard v2</h1>

<p align="center">
  <a href="README.ko.md">한국어</a>
</p>

<p align="center">
  <strong>Run AI agents on your server. Monitor from anywhere.</strong><br>
  A self-hosted, browser-based dashboard for managing multiple AI coding agents remotely.
</p>

<p align="center">
  <a href="#why-agentboard">Why</a> &bull;
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="#features">Features</a> &bull;
  <a href="#remote-access">Remote Access</a> &bull;
  <a href="#architecture">Architecture</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/tmux-required-1BB91F?logo=tmux&logoColor=white" alt="tmux" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" />
  <img src="https://img.shields.io/badge/dependencies-2_(ws%2C_dotenv)-green" alt="deps" />
</p>

---

## Why AgentBoard?

AI coding agents are getting powerful enough to run autonomously for hours. But you still need to:

- **Approve actions** when they hit permission checks
- **Monitor progress** across multiple concurrent sessions
- **Review files** the agent is working on

The problem: **you can't sit in front of the terminal all day.**

**AgentBoard is a web dashboard that runs where your agents run.** Deploy it on your server, open a browser tab, and manage everything from anywhere — desktop or phone.

### How It Compares

| | cmux | Cursor | Superset | **AgentBoard** |
|---|---|---|---|---|
| Multi-agent sessions | ✅ | ❌ | ✅ | ✅ |
| Remote access (browser) | ❌ | ❌ | ❌ | ✅ |
| Cross-platform | macOS | Desktop | Desktop | Any browser |
| File editor + PDF viewer | ❌ | Built-in | Diff view | Built-in |
| Phone/tablet access | ❌ | ❌ | ❌ | ✅ |
| Self-hosted | N/A | N/A | N/A | ✅ |
| Price | Free | $20/mo | Paid | Free |

---

## Quick Start

```bash
# Prerequisites: Node.js >= 18, tmux
git clone https://github.com/ralbu85/AgentBoard.git
cd AgentBoard/v2
npm install
echo "DASHBOARD_PASSWORD=yourpassword" > ../.env
node server/index.js
```

Open **http://localhost:3001** — done. Click **+** to start a session.

### Run as a Background Service

```bash
# pm2 (recommended)
npm install -g pm2
pm2 start v2/server/index.js --name agentboard
pm2 save && pm2 startup

# or nohup
nohup node v2/server/index.js > /tmp/agentboard.log 2>&1 &
```

### Config (Optional)

```bash
cp config.example.json config.json
```

```json
{
  "basePath": "/home/you/projects",
  "defaultCommand": "claude",
  "favorites": ["/home/you/projects/app1"]
}
```

---

## Features

### Two-Pane Layout

- **Left**: fixed terminal pane with xterm.js (GPU-accelerated, full ANSI color)
- **Right**: splittable viewer pane — drag files to edges to split, center to tab
- **Resizable**: drag the divider between terminal and viewer
- **Desktop**: direct keyboard input to terminal (click terminal, type)

### Multi-Agent Management

Run 10+ AI agents concurrently. Each session gets:
- Live terminal output via **xterm.js** with GPU rendering
- Automatic state detection: **Running** / **Waiting** / **Idle** / **Completed**
- Status animations with color-coded glows
- "esc to interrupt" based detection — no hardcoded patterns

### Smart Notifications

- Browser notifications on state change
- Audio alerts (different tones for waiting vs. completed)
- Tab title blink when in background
- Sidebar session flash

### Integrated File Management

- **File Explorer** — browse, upload, create, rename, delete
- **Code Editor** — CodeMirror with syntax highlighting, save button, refresh from disk
- **PDF Viewer** — zoom controls (+/-), page navigation, refresh
- **Image Viewer** — inline display
- **Markdown Preview** — rendered with marked.js
- **Drag & drop** files into viewer for split layout
- **Tab system** — multiple files per cell, drag tabs between cells

### Split Viewer (VS Code-style)

- Drag a file to the edge of a cell → creates a split (horizontal or vertical)
- Drag a file to the center → adds as a tab
- Drag tabs between cells to reorganize
- Drop shield prevents CodeMirror from stealing drag events
- Per-session viewer state: splits and tabs save/restore on session switch

### Mobile Optimized

- **Responsive layout** — terminal takes full screen
- **Session pills** in sidebar — compact list with status dots
- **HTML rendering** — lightweight ANSI-to-HTML instead of xterm.js canvas (fixes CJK spacing)
- **No tmux resize** from mobile — doesn't interfere with desktop dimensions
- **Touch optimized** — `touchend` for instant response, no click delay
- **Conditional loading** — CDN scripts (xterm.js, CodeMirror, pdf.js) only load on desktop

### Terminal Features

- Full ANSI 256 + RGB color rendering
- Direct keyboard input (click terminal to type)
- In-terminal search (xterm.js SearchAddon)
- Quick keys: Esc, arrows, Enter, Tab, Ctrl+C
- File drag & drop upload with progress bar
- Paste screenshots directly into sessions
- Reconnect button for stopped sessions
- Session delete from sidebar (× button)

### Performance

- **Desktop**: xterm.js GPU rendering, `\x1b[2J\x1b[3J\x1b[H` rewrite (no flicker)
- **Mobile**: ANSI-stripped dedup — skip render if content unchanged
- **Server**: sequential tmux resize → capture (no race condition)
- **Adaptive polling**: active sessions 500ms, idle 5s
- **Mobile data**: server sends last 200 lines only to mobile clients

---

## Remote Access

### Tailscale (Recommended)

Access your server's Tailscale IP directly. Zero config, encrypted, no ports to open.

### Cloudflare Tunnel

Install `cloudflared` and AgentBoard auto-starts a tunnel:
```
Tunnel URL → https://random-name.trycloudflare.com
```

### ngrok

```bash
ngrok http 3001
```

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Cmd/Ctrl+Shift+←/→ | Switch sessions |
| Ctrl+B | Toggle sidebar |
| Ctrl+S | Save file (in editor panel) |
| Ctrl+F | Search in terminal |
| Click terminal + type | Direct input to tmux |
| Esc, Enter, ↑↓, Tab | Forwarded to active session |

---

## Architecture

```
v2/
├── server/
│   ├── index.js      — HTTP + WS server, auth, broadcast
│   ├── sessions.js   — session CRUD, tmux lifecycle, state detection
│   ├── poller.js     — output polling (sequential resize → capture)
│   ├── routes.js     — REST API (login, files, sessions)
│   ├── tmux.js       — tmux command wrappers
│   └── tunnel.js     — Cloudflare tunnel
├── public/
│   ├── index.html    — conditional CDN loading (desktop only)
│   ├── style.css     — GitHub dark theme, mobile responsive
│   └── js/
│       ├── store.js     — SessionStore (EventTarget, central state)
│       ├── api.js       — fetch wrappers
│       ├── terminal.js  — xterm.js (desktop) / HTML pre (mobile)
│       ├── ws.js        — WebSocket, resize management
│       ├── sidebar.js   — session list, mobile tabs, drag reorder
│       ├── panels.js    — two-pane layout, viewer splits, drag-to-split
│       ├── editor.js    — CodeMirror, PDF.js, image viewer
│       ├── files.js     — file browser, context menu, upload
│       ├── notify.js    — audio, title blink, browser notifications
│       ├── favorites.js — bookmarks, spawn panel
│       └── app.js       — entry point, login, input, keyboard
└── package.json
```

**Design principles:**
- No frameworks — pure Node.js + vanilla JavaScript
- 2 dependencies — `ws` and `dotenv`
- IIFE + `AB` namespace — no build step, script tag loading
- Sessions are tmux — persist across server restarts
- Desktop/mobile split at render layer, shared server

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` or `V2_PORT` | `3001` | Server port |
| `DASHBOARD_PASSWORD` | `changeme` | Login password |
| `DISCORD_WEBHOOK` | — | Send tunnel URL to Discord |

---

## Credits

Originally based on [sunmerrr/TermHub](https://github.com/sunmerrr/TermHub). Evolved into a remote AI agent management platform.

## License

MIT
