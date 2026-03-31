import hashlib
import hmac
import json
import os
from pathlib import Path

from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT.parent.parent / ".env")  # /workspace/.env or /root/TermHub/.env
load_dotenv(Path("/root/TermHub/.env"))  # fallback

PORT = int(os.getenv("AGENTBOARD_PORT", os.getenv("V3_PORT", "3002")))
PASSWORD = os.getenv("DASHBOARD_PASSWORD", "changeme")
DISCORD_WEBHOOK = os.getenv("DISCORD_WEBHOOK", "")
AUTH_TOKEN = hmac.new(b"termhub", PASSWORD.encode(), hashlib.sha256).hexdigest()

_cfg_path = PROJECT_ROOT / "config.json"
_cfg: dict = {}
if _cfg_path.exists():
    try:
        _cfg = json.loads(_cfg_path.read_text())
    except Exception:
        pass

BASE_PATH: str = _cfg.get("basePath", "")
FAVORITES: list = _cfg.get("favorites", [])
DEFAULT_COMMAND: str = _cfg.get("defaultCommand", "claude")

FIFO_DIR = Path("/tmp")
TITLES_FILE = PROJECT_ROOT / ".session-titles.json"
