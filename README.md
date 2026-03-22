<p align="center">
  <img src="https://img.shields.io/badge/AgentBoard-Remote_AI_Agent_Dashboard-7c3aed?style=for-the-badge" alt="AgentBoard" />
</p>

<h1 align="center">AgentBoard</h1>

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

Tools like [cmux](https://cmux.com) and [Cursor](https://cursor.com) solve this beautifully — **if you're at your Mac.** But what about:

- 🖥️ Agents running on a **remote server** (AWS, lab machine, home server)?
- 📱 Checking progress from your **phone** during lunch?
- 🤝 **Sharing access** with a teammate who needs to approve something?
- 🐧 Working from a **Linux/Windows** machine with no native terminal app?

**AgentBoard is a web dashboard that runs where your agents run.** Deploy it on your server, open a browser tab, and manage everything from anywhere.

### How It Compares

| | cmux | Cursor | **AgentBoard** |
|---|---|---|---|
| Multi-agent sessions | ✅ | ❌ | ✅ |
| Remote access (browser) | ❌ | ❌ | ✅ |
| Cross-platform | macOS only | Desktop | Any browser |
| File editor + PDF viewer | Via browser | Built-in | Built-in |
| Phone/tablet access | ❌ | ❌ | ✅ |
| Self-hosted | N/A | N/A | ✅ |
| Notifications | macOS native | In-app | Browser + audio |
| Price | Free | $20/mo | Free |

---

## Quick Start

```bash
# Prerequisites: Node.js >= 18, tmux
git clone https://github.com/ralbu85/AgentBoard.git
cd AgentBoard
npm install
echo "DASHBOARD_PASSWORD=yourpassword" > .env
node server.js
```

Open **http://localhost:3000** — done. Click **+** to start a session.

### Run as a Background Service

```bash
# pm2 (recommended)
npm install -g pm2
pm2 start server.js --name agentboard
pm2 save && pm2 startup

# or nohup
nohup node server.js > /tmp/agentboard.log 2>&1 &
```

### Config (Optional)

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

---

## Features

### VS Code-Style Layout

- **Left sidebar**: collapsible Sessions + File Explorer sections
- **Main area**: split panels — terminal, PDF viewer, code editor side by side
- **Resizable**: drag handles between sidebar, panels, and sections

### Multi-Agent Management

Run 10+ AI agents concurrently. Each session gets:
- Live terminal output with full ANSI color support
- Automatic state detection: **Running** / **Waiting** / **Idle** / **Completed**
- Status indicators with color-coded glows and pulse animations

### Smart Notifications

Never miss when an agent needs you:
- Browser notifications on state change
- Audio alerts (different tones for waiting vs. completed)
- Tab title blink when in background
- Sidebar flash for inactive sessions

### Integrated File Management

Browse, edit, and preview files without leaving the dashboard:
- **File Explorer** in the sidebar — browse, upload, create, rename, delete
- **Code Editor** — CodeMirror with syntax highlighting (LaTeX, JS, Python, CSS, YAML, Shell, SQL, Markdown, and more). Ctrl+S to save.
- **PDF Viewer** — pdf.js rendering with page navigation
- **Image Viewer** — inline display for PNG, JPG, SVG, etc.
- **Markdown Preview** — rendered with marked.js + KaTeX math equations

### Split Panels

Open files alongside your terminal:
- Click any file in the explorer → opens in a new panel
- Up to 4 panels side by side with drag-to-resize handles
- **Per-session panel state**: each session remembers its open files
- Switch sessions → file panels save and restore automatically

### Terminal Features

- Full ANSI 256 + RGB color rendering
- In-terminal search (Ctrl+F)
- Autocomplete: `/` for slash commands, `@` for file paths
- Quick keys: Esc, arrows, Enter, Tab, Ctrl+C
- Drag & drop file upload with progress bar
- Paste screenshots directly into sessions

### Performance

- **Tail-diff rendering**: server sends only changed lines, not full snapshots
- **DOM virtualization**: max 300 lines in DOM, lazy-load on scroll up
- **Adaptive polling**: active sessions 500ms, idle 5s
- **tmux scrollback**: 10,000 lines of history per session

---

## Remote Access

The whole point — access your agents from anywhere.

### Tailscale (Recommended)

If you use [Tailscale](https://tailscale.com), access your server's Tailscale IP directly. Zero config, encrypted, no ports to open.

### Cloudflare Tunnel

Install `cloudflared` and AgentBoard auto-starts a tunnel:
```
☁️  Tunnel URL → https://random-name.trycloudflare.com
```
Password-protected. Works behind firewalls. Great for sharing with teammates.

### ngrok

```bash
ngrok http 3000
```

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Cmd/Ctrl+Shift+←/→ | Switch sessions |
| Ctrl+B | Toggle sidebar |
| Ctrl+S | Save file (in editor panel) |
| Ctrl+F | Search in terminal output |
| Esc, Enter, ↑↓, Tab | Forwarded to active session |
| Ctrl+C | Send interrupt to session |

---

## Architecture

```
Browser (any device)
   ↕ WebSocket + REST API
Node.js Server (your machine)
   ├── server.js          — entry, config, WebSocket hub
   ├── server/routes.js   — REST API (login, spawn, files)
   ├── server/workers.js  — session state, polling, tail-diff
   ├── server/tmux.js     — tmux command wrappers
   └── server/tunnel.js   — Cloudflare tunnel management
   ↕ tmux
Terminal sessions (term-1, term-2, ...)
   └─ claude / aider / codex / any CLI tool
```

**Design principles:**
- No frameworks — pure Node.js + vanilla JavaScript
- 2 dependencies — `ws` and `dotenv`
- Sessions are tmux — they persist across server restarts
- Works with any CLI tool, not just Claude

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `DASHBOARD_PASSWORD` | `changeme` | Login password |
| `DISCORD_WEBHOOK` | — | Send tunnel URL to Discord |

---

## Credits

Originally based on [sunmerrr/TermHub](https://github.com/sunmerrr/TermHub). Evolved into a remote AI agent management platform.

## License

MIT
