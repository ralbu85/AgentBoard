<p align="center">
  <img src="https://img.shields.io/badge/AgentBoard-AI_Session_Dashboard-7c3aed?style=for-the-badge" alt="AgentBoard" />
</p>

<h1 align="center">AgentBoard</h1>

<p align="center">
  <strong>Browser-based dashboard for managing multiple AI coding sessions</strong><br>
  Monitor all your Claude Code sessions in one place. Get notified when they need input.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="#features">Features</a> &bull;
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
- Works from your phone, another PC, or anywhere with a browser
- No SSH required for monitoring — just open the URL

---

## Features

### Overview Mode
Card grid showing all sessions with live status and output preview. Click any card to jump in.

### Live Status Detection
Automatically detects AI CLI state from terminal output:
- **Running** (purple) — AI is actively working
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
- **Split** — side-by-side, drag headers to reorder

### Terminal Features
- Full ANSI color support (256 + RGB)
- Box-drawing lines rendered as clean separators
- In-terminal search (click the magnifying glass icon)
- File upload — paste screenshots or drag files to session directory
- Quick keys: Esc, arrows, Enter, Tab, Ctrl+C

### More
- Auto-detect and attach existing tmux sessions
- Folder browser with bookmarks
- Mobile responsive UI
- Process info (command, uptime, memory)
- Password authentication
- Cloudflare tunnel for remote access

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

Copy the example config for custom settings:
```bash
cp config.example.json config.json
```

Edit `config.json`:
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
Click **magnifying glass icon** in the header to scan for running tmux sessions and add them to the dashboard.

### View from Terminal
Sessions are standard tmux — attach from any terminal:
```bash
tmux attach -t term-1
```

### Keyboard Shortcuts
| Key | Action |
|-----|--------|
| Cmd+Shift+Left/Right | Switch tabs |
| Ctrl+F | Search in terminal output |
| Esc, Enter, arrows | Forwarded to active session |
| Ctrl+C | Send interrupt to session |

---

## Remote Access

Access AgentBoard from your phone or another computer.

### Cloudflare Tunnel (Recommended)

```bash
brew install cloudflared  # or download from cloudflare.com
```

AgentBoard auto-starts a tunnel if `cloudflared` is installed. The URL appears in the server log:
```
☁️  Tunnel URL → https://random-name.trycloudflare.com
```

Optional: Get the URL on Discord by adding to `.env`:
```env
DISCORD_WEBHOOK=https://discord.com/api/webhooks/your/webhook-url
```

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
Node.js HTTP Server (server.js)
   ↕ tmux commands
tmux sessions (term-1, term-2, ...)
   └─ claude / any CLI
```

- **No frameworks** — pure Node.js server + vanilla JavaScript frontend
- **Minimal dependencies** — only `ws` and `dotenv`
- **tmux native** — sessions persist across server restarts

---

## Credits

Based on [sunmerrr/TermHub](https://github.com/sunmerrr/TermHub). Extended with overview mode, notification system, Claude-focused UI, mobile support, and more.

## License

MIT
