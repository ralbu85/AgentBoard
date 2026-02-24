#!/bin/bash
set -e

echo "🚀 TermHub Setup"
echo "================"
echo

# 1. Check Node.js
if ! command -v node &> /dev/null; then
  echo "❌ Node.js is not installed. Please install Node.js first."
  echo "   https://nodejs.org/ or: brew install node"
  exit 1
fi
echo "✅ Node.js $(node -v)"

# 2. Check tmux
if ! command -v tmux &> /dev/null; then
  echo "⚠️  tmux is not installed."
  if [[ "$(uname)" == "Darwin" ]] && command -v brew &> /dev/null; then
    read -p "   Install tmux via Homebrew? [Y/n] " yn
    yn=${yn:-Y}
    if [[ "$yn" =~ ^[Yy]$ ]]; then
      brew install tmux
      echo "✅ tmux installed"
    else
      echo "❌ tmux is required. Install it manually: brew install tmux"
      exit 1
    fi
  else
    echo "❌ tmux is required. Install it with your package manager."
    echo "   macOS: brew install tmux"
    echo "   Ubuntu/Debian: sudo apt install tmux"
    exit 1
  fi
else
  echo "✅ tmux $(tmux -V)"
fi

# 3. Install npm dependencies
echo
echo "📦 Installing dependencies..."
npm install
echo "✅ Dependencies installed"

# 4. Setup .env
echo
if [ -f .env ]; then
  echo "⏭️  .env already exists, skipping"
else
  read -p "🔑 Dashboard password (default: changeme): " password
  password=${password:-changeme}

  read -p "🌐 Port (default: 8080): " port
  port=${port:-8080}

  cat > .env << EOF
PORT=$port
DASHBOARD_PASSWORD=$password
EOF
  echo "✅ .env created"
fi

# 5. Setup config.json
if [ -f config.json ]; then
  echo "⏭️  config.json already exists, skipping"
else
  default_path="$HOME"
  read -p "📂 Base path for terminals (default: $default_path): " base_path
  base_path=${base_path:-$default_path}

  read -p "⚡ Default command (default: claude): " default_cmd
  default_cmd=${default_cmd:-claude}

  cat > config.json << EOF
{
  "basePath": "$base_path",
  "favorites": [],
  "defaultCommand": "$default_cmd"
}
EOF
  echo "✅ config.json created"
fi

# 6. Setup launchd (background service)
echo
PLIST_NAME="com.termhub.server"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"
TERMHUB_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_PATH="$(which node)"

# Unload if already loaded
launchctl unload "$PLIST_PATH" 2>/dev/null || true

cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_NAME}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>${TERMHUB_DIR}/server.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${TERMHUB_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/termhub.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/termhub.err</string>
</dict>
</plist>
EOF

launchctl load "$PLIST_PATH"
echo "✅ TermHub service registered & started"

echo
echo "🎉 Setup complete! TermHub is running in the background."
echo
echo "   Management commands:"
echo "   launchctl unload $PLIST_PATH   # Stop"
echo "   launchctl load $PLIST_PATH     # Start"
echo "   cat /tmp/termhub.log           # Logs"
echo
