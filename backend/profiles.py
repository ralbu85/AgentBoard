"""Launch profiles for new sessions.

A profile is a named launch command — e.g. plain `claude`, `claude
--dangerously-skip-permissions`, `claude --resume`, `codex`, or a bare shell.
The "+" button and its dropdown are driven by this list; users edit it in-app.
Persisted to a JSON file, atomically (same discipline as session titles).
"""
from __future__ import annotations

import json
import os

from . import config
from .logger import log

_FILE = config.STATE_DIR / ".spawn-profiles.json"

DEFAULT_PROFILES = [
    {"id": "claude", "label": "Claude", "icon": "🤖", "command": "claude", "default": True},
    {"id": "claude-skip", "label": "Claude · 권한 스킵", "icon": "⚡",
     "command": "claude --dangerously-skip-permissions", "default": False},
    {"id": "claude-continue", "label": "Claude · 이어서", "icon": "↩",
     "command": "claude --continue", "default": False},
    {"id": "claude-resume", "label": "Claude · resume 선택", "icon": "⏱",
     "command": "claude --resume", "default": False},
    {"id": "codex", "label": "Codex", "icon": "🧠", "command": "codex", "default": False},
    {"id": "bash", "label": "터미널", "icon": ">_", "command": "bash", "default": False},
]


def load() -> list[dict]:
    if not _FILE.exists():
        return [dict(p) for p in DEFAULT_PROFILES]
    try:
        data = json.loads(_FILE.read_text())
        if isinstance(data, list) and data:
            return data
    except Exception as e:
        log.warning("spawn-profiles unreadable, using defaults: %s", e)
    return [dict(p) for p in DEFAULT_PROFILES]


def save(profiles: list[dict]) -> None:
    # Exactly one default (fall back to the first).
    if profiles and not any(p.get("default") for p in profiles):
        profiles[0]["default"] = True
    seen = False
    for p in profiles:
        if p.get("default") and not seen:
            seen = True
        elif p.get("default"):
            p["default"] = False
    try:
        tmp = _FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(profiles, ensure_ascii=False))
        os.replace(tmp, _FILE)
    except Exception as e:
        log.warning("spawn-profiles save failed: %s", e)
