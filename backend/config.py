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
load_dotenv(PROJECT_ROOT.parent.parent / ".env")  # /workspace/.env when nested under /workspace
load_dotenv(Path("/root/TermHub/.env"))            # legacy fallback location

PORT = int(os.getenv("AGENTBOARD_PORT", os.getenv("V3_PORT", "3002")))
PASSWORD = os.getenv("DASHBOARD_PASSWORD", "changeme")
DISCORD_WEBHOOK = os.getenv("DISCORD_WEBHOOK", "")
AUTH_TOKEN = hmac.new(b"termhub", PASSWORD.encode(), hashlib.sha256).hexdigest()

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
DEFAULT_COMMAND: str = _cfg.get("defaultCommand", "claude")

FIFO_DIR = Path("/tmp")
TITLES_FILE = PROJECT_ROOT / ".session-titles.json"

_default_roots = [str(Path.home()), "/workspace"]
ALLOWED_ROOTS: list[Path] = [
    Path(os.path.expanduser(r)).resolve()
    for r in os.getenv("AGENTBOARD_ALLOWED_ROOTS", ",".join(_default_roots)).split(",")
    if r.strip()
]
