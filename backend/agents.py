"""Hub-side registry of connected remote agents.

The hub serves browsers and manages its own ("local") tmux directly. Each
remote PC dials in over /agent-ws; this module tracks those connections and a
lightweight per-session mirror so a browser connecting *after* an agent can be
replayed the agent's current sessions without round-tripping.

The hub never runs streamer/tmux for a remote host — it is a pure relay. All
remote terminal work happens inside that host's own agent process.
"""
from __future__ import annotations

import json

from fastapi import WebSocket

from .logger import log
from .namespace import prefix_id


# Cap the per-host mirror so a buggy/compromised agent can't exhaust hub memory
# by streaming unlimited unique session ids. Far above any real machine's count.
MAX_SESSIONS_PER_HOST = 500

# Monotonic connection counter so a re-registering host's stale ws handler can
# tell whether the registry still points at its own connection (see agent_ws).
_conn_seq = 0


def _next_conn_id() -> int:
    global _conn_seq
    _conn_seq += 1
    return _conn_seq


class AgentConn:
    def __init__(self, host: str, label: str, ws: WebSocket):
        self.host = host
        self.label = label
        self.ws = ws
        self.conn_id = _next_conn_id()
        # local_id -> merged browser-facing session dict (metadata only, no
        # terminal buffers — those flow on demand via active/resync).
        self.sessions: dict[str, dict] = {}
        # local_id -> title (mirrored so late-joining browsers see remote titles).
        self.titles: dict[str, str] = {}

    def update_from(self, msg: dict):
        """Fold an ingested agent message into the per-session mirror."""
        mtype = msg.get("type", "")
        mid = msg.get("id", "")
        if mtype == "spawned":
            if mid not in self.sessions and len(self.sessions) >= MAX_SESSIONS_PER_HOST:
                return  # mirror full — drop (agent misbehaving); do not grow unbounded
            self.sessions[mid] = {
                "sessionName": msg.get("sessionName", ""),
                "cwd": msg.get("cwd", ""),
                "cmd": msg.get("cmd", ""),
                "status": msg.get("status", "running"),
                "aiState": None,
                "process": "",
                "createdAt": 0,
                "memKB": 0,
            }
        elif mtype == "removed":
            self.sessions.pop(mid, None)
            self.titles.pop(mid, None)
        elif mtype == "title":
            title = msg.get("title", "")
            if title:
                self.titles[mid] = title
            else:
                self.titles.pop(mid, None)
        elif mtype == "titles":
            incoming = msg.get("titles", {})
            if isinstance(incoming, dict):
                for k, v in incoming.items():
                    if v:
                        self.titles[str(k)] = v
        elif mid in self.sessions:
            s = self.sessions[mid]
            if mtype == "status":
                s["status"] = msg.get("status", s["status"])
            elif mtype == "cwd":
                s["cwd"] = msg.get("cwd", s["cwd"])
            elif mtype == "aiState":
                s["aiState"] = msg.get("state")
            elif mtype == "info":
                s["process"] = msg.get("process", s["process"])
                s["createdAt"] = msg.get("createdAt", s["createdAt"])
                s["memKB"] = msg.get("memKB", s["memKB"])


class AgentRegistry:
    def __init__(self):
        self._agents: dict[str, AgentConn] = {}

    def register(self, host: str, label: str, ws: WebSocket) -> AgentConn:
        conn = AgentConn(host, label, ws)
        self._agents[host] = conn
        return conn

    def unregister(self, host: str) -> AgentConn | None:
        return self._agents.pop(host, None)

    def get(self, host: str) -> AgentConn | None:
        return self._agents.get(host)

    def is_connected(self, host: str) -> bool:
        return host in self._agents

    def all_hosts(self) -> list[dict]:
        return [{"host": c.host, "label": c.label, "online": True}
                for c in self._agents.values()]

    def mirror(self) -> list[dict]:
        """All known remote sessions as browser-facing dicts (prefixed ids)."""
        out: list[dict] = []
        for c in self._agents.values():
            for local_id, s in c.sessions.items():
                d = dict(s)
                d["id"] = prefix_id(c.host, local_id)
                d["host"] = c.host
                d["hostLabel"] = c.label
                out.append(d)
        return out

    def mirror_titles(self) -> dict[str, str]:
        """All known remote session titles, keyed by prefixed id."""
        out: dict[str, str] = {}
        for c in self._agents.values():
            for local_id, title in c.titles.items():
                out[prefix_id(c.host, local_id)] = title
        return out

    async def send(self, host: str, msg: dict) -> bool:
        conn = self._agents.get(host)
        if not conn:
            log.warning("registry.send: no agent for host %r", host)
            return False
        try:
            await conn.ws.send_text(json.dumps(msg))
            return True
        except Exception as e:
            log.debug("registry.send failed for host %s: %s", host, e)
            return False


registry = AgentRegistry()
