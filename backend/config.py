"""
AgentBoard config.

Settings come from two sources, by purpose:

  .env (environment variables) — secrets and deployment knobs
    DASHBOARD_PASSWORD          login password (required)
    AGENTBOARD_PORT             listen port (default 3002; legacy: V3_PORT)
    AGENTBOARD_ALLOWED_ROOTS    file API boundary, comma-separated paths
    AGENTBOARD_LOG_LEVEL        DEBUG/INFO/WARNING/ERROR (default INFO)
    DISCORD_WEBHOOK             optional, posts cloudflared tunnel URL

  config.json (committed, optional) — UX preferences
    basePath                    file browser starting directory
    favorites                   pinned directories in the sidebar
    defaultCommand              command to run for new sessions
"""
import hashlib
import hmac
import json
import os
from pathlib import Path

from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent
# First-found wins (load_dotenv never overrides an already-set variable):
# the repo-local .env is the documented location; the other two keep legacy
# dev-box setups working.
load_dotenv(PROJECT_ROOT / ".env")                 # standard: <repo>/.env
load_dotenv(PROJECT_ROOT.parent.parent / ".env")   # legacy: /workspace/.env when nested
load_dotenv(Path("/root/TermHub/.env"))            # legacy dev-box location

PORT = int(os.getenv("AGENTBOARD_PORT", os.getenv("V3_PORT", "3002")))
# Bind to loopback by default: nginx (same host) proxies :12019 → here, and
# remote agents dial in via nginx over wss, so the backend never needs to be
# reachable directly on the network. Override with AGENTBOARD_HOST if needed.
HOST = os.getenv("AGENTBOARD_HOST", "127.0.0.1")
PASSWORD = os.getenv("DASHBOARD_PASSWORD", "changeme")
# Refuse to serve with the shipped default password (auth would be bypassable
# since the token is a deterministic hash of it). Set AGENTBOARD_ALLOW_DEFAULT_PW=1
# only for throwaway local dev.
ALLOW_DEFAULT_PW = os.getenv("AGENTBOARD_ALLOW_DEFAULT_PW", "") == "1"
# Send the auth cookie only over HTTPS. Default off so plain-HTTP access (e.g.
# a LAN dev setup) still works; turn on once you serve over TLS.
COOKIE_SECURE = os.getenv("AGENTBOARD_COOKIE_SECURE", "") == "1"
# Disable tmux alternate-screen so full-screen apps (Claude Code, vim, less)
# render into the normal buffer → xterm gets real scrollback → smooth scroll.
# Default on; set AGENTBOARD_NO_ALT_SCREEN=0 to restore native full-screen apps.
NO_ALT_SCREEN = os.getenv("AGENTBOARD_NO_ALT_SCREEN", "1") == "1"
# tmux scrollback depth per pane. tmux's default (2000) fills up within minutes
# of Claude output; at the cap #{history_size} freezes and older lines are
# silently trimmed. Applies to panes created after this option is set.
HISTORY_LIMIT = int(os.getenv("AGENTBOARD_HISTORY_LIMIT", "50000"))
DISCORD_WEBHOOK = os.getenv("DISCORD_WEBHOOK", "")
AUTH_TOKEN = hmac.new(b"termhub", PASSWORD.encode(), hashlib.sha256).hexdigest()

# Shared secret remote agents present to /agent-ws. Defaults to AUTH_TOKEN for
# zero-config single-secret setups; set a separate AGENT_TOKEN to decouple the
# agent's full-shell access from the dashboard login password.
AGENT_TOKEN = os.getenv("AGENT_TOKEN", AUTH_TOKEN)

_cfg_path = PROJECT_ROOT / "config.json"
_cfg: dict = {}
if _cfg_path.exists():
    try:
        _cfg = json.loads(_cfg_path.read_text())
    except Exception as e:
        import sys
        print(f"warning: config.json unreadable, using defaults: {e}", file=sys.stderr)

BASE_PATH: str = _cfg.get("basePath", "")
FAVORITES: list = _cfg.get("favorites", [])
# Env override first (containers set this to `bash` — `claude` isn't in the
# image), then the committed config.json preference.
DEFAULT_COMMAND: str = os.getenv("AGENTBOARD_DEFAULT_CMD", _cfg.get("defaultCommand", "claude"))

# VAPID "sub" claim for Web Push — a mailto:/https: contact the push service can
# reach if a subscription misbehaves. The value is not user-facing.
VAPID_SUBJECT = os.getenv("AGENTBOARD_VAPID_SUBJECT", "mailto:agentboard@localhost")

FIFO_DIR = Path("/tmp")

# Where mutable state lives (session titles, push subscriptions, VAPID keypair,
# spawn profiles). Defaults to the repo root — containers point this at a
# volume so state survives image rebuilds.
STATE_DIR = Path(os.getenv("AGENTBOARD_STATE_DIR", str(PROJECT_ROOT))).resolve()
STATE_DIR.mkdir(parents=True, exist_ok=True)
TITLES_FILE = STATE_DIR / ".session-titles.json"

_default_roots = [str(Path.home()), "/workspace"]
ALLOWED_ROOTS: list[Path] = [
    Path(os.path.expanduser(r)).resolve()
    for r in os.getenv("AGENTBOARD_ALLOWED_ROOTS", ",".join(_default_roots)).split(",")
    if r.strip()
]
