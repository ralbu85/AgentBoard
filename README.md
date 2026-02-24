# TermHub

A web dashboard for managing multiple terminal sessions via tmux. Run any command — Claude CLI, bash, python, or anything else — and monitor them all from one place.

## Features

- **Run any command** — spawn sessions with any CLI tool (default: `claude`)
- **Manage multiple terminal sessions** — each runs as an independent worker in a tmux session
- **Real-time logs** — captures and displays tmux session output in real time
- **Two-way mirroring** — view the same session from both the dashboard and your local terminal
- **Tab / Split layout** — switch between views as needed
  - Tab mode: focus on one worker at a time
  - Split mode: view multiple workers side by side (up to 3 columns, grid for 4+)
- **Favorites & recent paths** — quick access to frequently used project directories
- **tmux session scanning** — auto-detect and attach to existing tmux sessions
- **Live status** — running / stopped status updated in real time
- **Password authentication** — protect external access
- **ngrok support** — access from mobile or other external devices
- **Adaptive terminal size** — tmux resizes to match your device's screen
- **Multiline input** — Shift+Enter for newlines, Enter to send
- **Keyboard shortcuts** — Esc, Shift+Tab, Ctrl+C, arrow keys forwarded to active worker

## Prerequisites

- [Node.js](https://nodejs.org)
- [tmux](https://github.com/tmux/tmux) (`brew install tmux`)
- [ngrok](https://ngrok.com) (optional, for external access — `brew install ngrok`)

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
echo -e "PORT=8080\nDASHBOARD_PASSWORD=yourpass" > .env
node server.js
```

## External Access (ngrok)

To access TermHub from outside your local network (mobile, another PC, etc.), use [ngrok](https://ngrok.com).

### 1. Install ngrok

```bash
brew install ngrok
```

### 2. Connect your account

Create a free account at the [ngrok dashboard](https://dashboard.ngrok.com), then register your authtoken:

```bash
ngrok config add-authtoken <your-token>
```

### 3. Start the tunnel

```bash
ngrok http 8080
```

You'll see a forwarding URL like:

```
Forwarding  https://xxxx-xxxx.ngrok-free.app -> http://localhost:8080
```

### 4. Connect

Open the `https://xxxx-xxxx.ngrok-free.app` URL in your browser. If `DASHBOARD_PASSWORD` is set in `.env`, you'll see a login screen.

> **Note:** The free plan generates a new URL each time you start ngrok. For a fixed domain, use `ngrok http --url=your-domain.ngrok-free.app 8080`.

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
