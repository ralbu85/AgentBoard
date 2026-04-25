from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

from . import config, tmux
from .logger import log

# Tmux pane size is FIXED at these values for every session.
# Clients (desktop + mobile) never resize — they always render this canonical size.
CANONICAL_COLS = 80
CANONICAL_ROWS = 40

@dataclass
class Session:
    id: str
    session_name: str
    cwd: str
    cmd: str
    status: str = "running"      # running | stopped | completed
    ai_state: str | None = None  # idle | working | waiting
    process: str = ""
    created_at: int = 0
    mem_kb: int = 0
    cols: int = CANONICAL_COLS
    rows: int = CANONICAL_ROWS
    display_rows: int = CANONICAL_ROWS

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "sessionName": self.session_name,
            "cwd": self.cwd,
            "cmd": self.cmd,
            "status": self.status,
            "aiState": self.ai_state,
            "process": self.process,
            "createdAt": self.created_at,
            "memKB": self.mem_kb,
        }


class SessionStore:
    def __init__(self):
        self.sessions: dict[str, Session] = {}
        self._next_id = 1
        self._titles: dict[str, str] = {}
        self._broadcast: Callable | None = None
        self._load_titles()

    def set_broadcast(self, fn: Callable):
        self._broadcast = fn

    def broadcast(self, msg: dict):
        if self._broadcast:
            self._broadcast(msg)

    # ── Titles ──

    def _load_titles(self):
        if config.TITLES_FILE.exists():
            try:
                self._titles = json.loads(config.TITLES_FILE.read_text())
            except Exception as e:
                log.warning("titles file unreadable, resetting: %s", e)
                self._titles = {}

    def _save_titles(self):
        try:
            config.TITLES_FILE.write_text(json.dumps(self._titles))
        except Exception as e:
            log.warning("titles file save failed: %s", e)

    def set_title(self, id: str, title: str | None):
        if title:
            self._titles[id] = title
        else:
            self._titles.pop(id, None)
        self._save_titles()
        self.broadcast({"type": "title", "id": id, "title": title or ""})

    @property
    def titles(self) -> dict:
        return dict(self._titles)

    # ── Session CRUD ──

    def get(self, id: str) -> Session | None:
        return self.sessions.get(id)

    def all(self) -> list[Session]:
        return list(self.sessions.values())

    def add(self, session_name: str, cwd: str, cmd: str, status: str = "running") -> Session:
        id_str = str(self._next_id)
        self._next_id += 1
        s = Session(id=id_str, session_name=session_name, cwd=cwd, cmd=cmd, status=status)
        self.sessions[id_str] = s
        return s

    def remove(self, id: str):
        self.sessions.pop(id, None)
        self._titles.pop(id, None)
        self._save_titles()

    async def spawn(self, cwd: str, cmd: str = "") -> Session:
        cmd = cmd or config.DEFAULT_COMMAND
        cwd = cwd or os.path.expanduser("~")
        id_str = str(self._next_id)
        session_name = f"term-{id_str}"

        await tmux.new_session(session_name, cwd, cmd)
        await tmux.resize_window(session_name, CANONICAL_COLS, CANONICAL_ROWS)

        s = self.add(session_name, cwd, cmd)
        self.broadcast({
            "type": "spawned",
            "id": s.id, "cwd": s.cwd, "cmd": s.cmd,
            "status": s.status, "sessionName": s.session_name,
        })
        return s

    async def kill(self, id: str) -> bool:
        s = self.get(id)
        if not s:
            return False
        await tmux.kill_session(s.session_name)
        s.status = "stopped"
        s.ai_state = None
        self.broadcast({"type": "status", "id": id, "status": "stopped"})
        return True

    async def reconnect(self, id: str) -> bool:
        s = self.get(id)
        if not s:
            return False
        alive = await tmux.is_alive(s.session_name)
        if alive:
            s.status = "running"
            self.broadcast({"type": "status", "id": id, "status": "running"})
            return True
        return False

    async def recover(self):
        tmux_sessions = await tmux.list_sessions()
        for ts in tmux_sessions:
            name = ts["sessionName"]
            # Force every recovered session to canonical size
            await tmux.resize_window(name, CANONICAL_COLS, CANONICAL_ROWS)
            if name.startswith("term-"):
                try:
                    num = int(name.split("-", 1)[1])
                except (ValueError, IndexError):
                    continue
                if self._next_id <= num:
                    self._next_id = num + 1
                s = self.add(name, ts["cwd"], config.DEFAULT_COMMAND)
                self.sessions.pop(s.id)
                s.id = str(num)
                self.sessions[s.id] = s
            else:
                # Non-term sessions (attached externally)
                s = self.add(name, ts["cwd"], name)
                s.cmd = name


store = SessionStore()
