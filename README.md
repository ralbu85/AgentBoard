<p align="center">
  <img src="https://img.shields.io/badge/AgentBoard-AI_Session_Dashboard-7c3aed?style=for-the-badge" alt="AgentBoard" />
</p>

<h1 align="center">AgentBoard</h1>

<p align="center">
  <a href="README.ko.md">한국어</a>
</p>

<p align="center">
  <strong>Browser-based dashboard for managing multiple AI coding sessions</strong><br>
  Monitor all your Claude Code sessions in one place. Get notified when they need input.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="#features">Features</a> &bull;
  <a href="#side-panel">Side Panel</a> &bull;
  <a href="#remote-access">Remote Access</a> &bull;
  <a href="#license">License</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/tmux-required-1BB91F?logo=tmux&logoColor=white" alt="tmux" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" />
</p>

---

## The Problem

You're running 3+ Claude Code sessions across different projects. You switch between terminal tabs, lose track, and miss when one is **waiting for input** — wasting minutes (or hours) of idle time.

## The Solution

AgentBoard gives you a **single browser dashboard** for all your AI coding sessions:

- See every session's live output at a glance
- Get **notified instantly** when a session needs your input
- **Edit files, preview markdown, and view PDFs** right next to your terminal
- Works from your phone, another PC, or anywhere with a browser
- No SSH required — just open the URL

---

## Features

### Overview Mode
Card grid showing all sessions with live status and output preview. Click any card to jump in.

### Live Status Detection
Automatically detects AI CLI state from terminal output:
- **Running** (purple glow) — AI is actively working
- **Waiting** (yellow pulse) — needs your input
- **Idle** (green) — finished, waiting for next task
- **Completed** (green glow) — session done, pulses until you check

### Notifications
- Browser notifications when sessions complete or need input
- Audio beep (different tones for waiting vs. completed)
- Tab title blink when browser is in background
- Tab flash when viewing a different session

### Three Layout Modes
- **Overview** — all sessions as cards with preview
- **Tab** — one session at a time, tab bar for switching
- **Split** — side-by-side, drag card headers to reorder

### Autocomplete
- Type `/` — dropdown of Claude Code slash commands (`/help`, `/compact`, `/config`, etc.)
- Type `@` — file path autocomplete with subdirectory navigation (`@src/components/...`)
- Arrow keys to navigate, Tab/Enter to select

---

## Side Panel

Toggle with the **☰** button or **Ctrl+B**. Resizable by dragging the border.

### Files Tab
- Browse session's working directory
- Right-click context menu: Edit, Download, Rename, Delete
- Right-click empty area: New Folder, New File, Refresh
- Drag & drop files to upload (with progress bar)
- Locked to session CWD — can't navigate above project root

### Editor Tab
- **CodeMirror** syntax highlighting for LaTeX, JavaScript, Python, CSS, HTML, YAML, Shell, SQL, Markdown
- Line numbers, bracket matching, auto-close brackets
- Tab indentation, auto-indent after `\begin{...}`
- **Ctrl+S** to save
- Markdown files open in preview mode automatically

### Markdown Preview
- Full rendering via **marked.js**
- Math equations via **KaTeX** (`$inline$` and `$$block$$`)
- LaTeX tables (`\begin{tabular}`) converted to HTML with alignment support
- Tables, code blocks, lists, links — all rendered

### PDF Viewer
- Click any `.pdf` file to view inline (browser native viewer)
- Streaming for large files — no size limit

### History Tab
- All commands you've sent, with timestamps
- Click to reuse a previous command

---

## Terminal Features

- Full ANSI color support (256 + RGB)
- Box-drawing lines (`───`) rendered as clean separators
- In-terminal search (🔍 icon in card header)
- File upload — paste screenshots or drag files to session directory (with progress bar)
- Quick keys: Esc, arrows, Enter, Tab, Ctrl+C
- Adaptive polling: active sessions 500ms, idle 5s — scales to 20+ sessions
- Per-session tmux resize in Split mode

---

## Quick Start

### Prerequisites

- **Node.js** >= 18
- **tmux** (`brew install tmux` on macOS, `apt install tmux` on Ubuntu)

### Install & Run

```bash
git clone https://github.com/ralbu85/AgentBoard.git
cd AgentBoard
npm install
```

Create a `.env` file:
```bash
echo "DASHBOARD_PASSWORD=yourpassword" > .env
```

Start the server:
```bash
node server.js
```

Open **http://localhost:3000** in your browser. That's it.

### Optional: Config File

```bash
cp config.example.json config.json
```

```json
{
  "basePath": "/home/you/projects",
  "defaultCommand": "claude",
  "favorites": ["/home/you/projects/app1", "/home/you/projects/app2"]
}
```

### Optional: Run as Background Service

```bash
# Using nohup
nohup node server.js > /tmp/agentboard.log 2>&1 &

# Or using pm2
npm install -g pm2
pm2 start server.js --name agentboard
pm2 save
pm2 startup  # auto-start on boot
```

---

## Usage

### Create a Session
1. Click **+** in the top-right
2. Browse to your project folder
3. Click **Open here** — a Claude Code session starts in that directory

### Attach Existing Sessions
Click **🔍** in the header to scan for running tmux sessions and add them to the dashboard.

### View from Terminal
Sessions are standard tmux — attach from any terminal:
```bash
tmux attach -t term-1
```

### Keyboard Shortcuts
| Key | Action |
|-----|--------|
| Cmd+Shift+Left/Right | Switch tabs |
| Ctrl+B | Toggle side panel |
| Ctrl+S | Save file (in editor) |
| Ctrl+F | Search in terminal output |
| Esc, Enter, arrows | Forwarded to active session |
| Ctrl+C | Send interrupt to session |

---

## Remote Access

Access AgentBoard from your phone or another computer.

### Tailscale (Most Secure)

If you use [Tailscale](https://tailscale.com), just access your server's Tailscale IP. Only your devices can connect — no ports to open, no URLs to share.

### Cloudflare Tunnel (For Sharing)

No account needed. Install `cloudflared` and AgentBoard auto-starts a tunnel:
```
☁️  Tunnel URL → https://random-name.trycloudflare.com
```

Anyone with the URL can access (password-protected). Great for demos or team sharing. Works behind firewalls — only outbound HTTPS needed.

### ngrok

```bash
ngrok http 3000
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `DASHBOARD_PASSWORD` | `changeme` | Login password |
| `DISCORD_WEBHOOK` | — | Discord webhook for tunnel URL |

---

## Architecture

```
Browser (Vanilla JS)
   ↕ WebSocket + REST API
Node.js HTTP Server
   ├── server.js          — entry point, config, WebSocket
   ├── server/routes.js   — HTTP API routes
   ├── server/workers.js  — session state, polling, AI detection
   ├── server/tmux.js     — tmux command wrappers
   └── server/tunnel.js   — Cloudflare tunnel management
   ↕ tmux commands
tmux sessions (term-1, term-2, ...)
   └─ claude / any CLI
```

- **No frameworks** — pure Node.js + vanilla JavaScript
- **Minimal dependencies** — only `ws` and `dotenv`
- **Modular server** — each concern in its own file
- **tmux native** — sessions persist across server restarts

---

## Credits

Based on [sunmerrr/TermHub](https://github.com/sunmerrr/TermHub). Extended with overview mode, side panel (file browser + editor + PDF viewer), notification system, autocomplete, adaptive polling, modular architecture, and more.

## License

MIT
