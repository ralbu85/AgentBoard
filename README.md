# TermHub

[한국어](README.ko.md)

A web dashboard for managing multiple terminal sessions via tmux. Run any command — Claude CLI, bash, python, or anything else — and monitor them all from one place.

If you find it useful, feel free to give it a star on GitHub.

## Features

- **Run any command** — spawn sessions with any CLI tool (default: `claude`)
- **Multiple terminal sessions** — each runs as an independent worker in a tmux session
- **Real-time logs** — captures and displays tmux output in real time
- **AI state detection** — automatically detects AI CLI state from terminal output:
  - 🔵 Working → 🟢 Idle → 🟡 Waiting (permission needed)
- **Two-way mirroring** — view the same session from both the dashboard and your local terminal

### More

- **tmux session scanning** — auto-detect and attach to existing sessions
- **Tab / Split layout** — Tab mode for focus, Split mode for side-by-side
- **Favorites & recent paths** — quick access to frequently used directories
- **Password auth + external tunnels** — Cloudflare (recommended) or ngrok for remote access
- **Adaptive terminal size** — tmux resizes to match your screen
- **Keyboard shortcuts** — Esc, Shift+Tab, Ctrl+C, arrow keys forwarded to active worker

## Prerequisites

- [Node.js](https://nodejs.org)
- [tmux](https://github.com/tmux/tmux) (`brew install tmux`)
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (optional, for external access — recommended)
- [ngrok](https://ngrok.com) (optional, for external access)

## Quick Setup

Run the setup script to install dependencies, create config files, and register TermHub as a background service:

```bash
git clone https://github.com/yourname/termhub.git
cd termhub
npm run setup
```

The setup script will:
1. Check for Node.js and tmux (installs tmux via Homebrew if missing)
2. Run `npm install`
3. Create `.env` — prompts for password and port
4. Create `config.json` — prompts for base path and default command
5. Register as a macOS launchd service — starts automatically on boot, restarts on crash

After setup, TermHub is running in the background. Manage the service with:

```bash
launchctl unload ~/Library/LaunchAgents/com.termhub.server.plist   # Stop
launchctl load ~/Library/LaunchAgents/com.termhub.server.plist     # Start
cat /tmp/termhub.log                                                # View logs
```

## Manual Installation

If you prefer to set up manually instead of using the setup script:

```bash
npm install
cp config.example.json config.json   # Edit basePath, favorites, defaultCommand
echo -e "PORT=8081\nDASHBOARD_PASSWORD=yourpass" > .env
node server.js
```

To run each component manually (without launchd):

```bash
node server.js                                        # Start server
cloudflared tunnel --url http://localhost:8081         # Start tunnel (optional, separate process)
```

## External Access (Cloudflare / ngrok)

To access TermHub from outside your local network (mobile, another PC, etc.), use a tunnel tool.

> **Recommended:** Cloudflare Tunnel (`cloudflared`)  
> Why: it is fast to set up and can expose an temporary `*.trycloudflare.com` URL without account/domain setup.

### Option A. Cloudflare (Recommended)

1. Install

```bash
brew install cloudflared
```

2. That's it — TermHub automatically starts a Cloudflare tunnel on launch. The tunnel URL is:

- Printed in the server log (`☁️  Tunnel URL → https://...`)
- Available via API: `GET /api/tunnel`
- Broadcast to connected clients via WebSocket

3. (Optional) **Discord notification** — add a webhook URL to `.env` to receive the tunnel URL on Discord whenever the server starts:

```env
DISCORD_WEBHOOK=https://discord.com/api/webhooks/your/webhook-url
```

> **Note:** `trycloudflare.com` URLs are temporary. They change on every restart.

### Option B. ngrok

1. Install

```bash
brew install ngrok
```

2. Connect your account

Create a free account at the [ngrok dashboard](https://dashboard.ngrok.com), then register your authtoken:

```bash
ngrok config add-authtoken <your-token>
```

3. Start the tunnel

```bash
ngrok http 8081
```

4. Connect

Open the URL shown in the output (for example, `https://xxxx-xxxx.ngrok-free.app`) in your browser.

> **Note:** The free plan generates a new URL each time you start ngrok. For a fixed domain, use `ngrok http --url=your-domain.ngrok-free.app 8081`.

## Usage

### Start a new session
1. Click the **+** button in the top-right corner to open the spawn toolbar
2. Click 📁 to select a project path (favorites and recent paths supported)
3. Optionally change the command (default: `claude`)
4. Click **+ New** to start the session

### Attach existing tmux sessions
1. Click 🔍 in the header to scan for running tmux sessions
2. Confirm to add them to the dashboard

### View sessions from your local terminal
```bash
tmux attach -t term-1   # Worker #1
tmux attach -t term-2   # Worker #2
```

### Switch layouts
Use the **Tab / Split** buttons in the header. Your choice is saved in the browser.

### Stop and remove workers
- Running: **Stop** button — terminates the tmux session
- Stopped: **Remove** button — removes from the dashboard

## File Structure

```
termhub/
├── server.js              # Node.js server (tmux management, WebSocket)
├── index.html             # Web UI entry point
├── setup.sh               # One-step setup script
├── public/
│   ├── style.css          # Styles
│   └── js/
│       ├── layout.js      # Layout & tab management
│       ├── favorites.js   # Favorites & path management
│       ├── ws.js          # WebSocket & API communication
│       ├── workers.js     # Worker card UI & actions
│       └── app.js         # Init & event binding
├── config.json            # User config (gitignored)
├── config.example.json    # Config template
├── .env                   # Environment variables (gitignored)
├── .gitignore
├── package.json
└── README.md
```

## License

MIT
