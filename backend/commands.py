"""Command application shared by the hub (local sessions) and remote agents.

`apply_command` is the single mutation point for session commands. The hub's
WebSocket handler and REST endpoints call it for local sessions; each agent
calls it for its own sessions. store/streamer/tmux are passed in explicitly so
the hub and each agent process bind their own module instances (no global
cross-import, no shared state between processes).
"""
from __future__ import annotations

import asyncio
from typing import Awaitable, Callable, Optional

from .logger import log
from .sessions import CANONICAL_COLS, CANONICAL_ROWS

# Single bytes/sequences from xterm mapped to tmux key names.
SEQ_MAP = {
    "\r": "Enter", "\x1b": "Escape", "\t": "Tab",
    "\x1b[A": "Up", "\x1b[B": "Down", "\x1b[C": "Right", "\x1b[D": "Left",
    "\x7f": "BSpace", "\x08": "BSpace",
    "\x03": "C-c", "\x04": "C-d", "\x1a": "C-z",
    "\x1b[H": "Home", "\x1b[F": "End",
    "\x1b[5~": "PageUp", "\x1b[6~": "PageDown",
    "\x1b[3~": "DC",
}

Reply = Callable[[dict], Awaitable[None]]


async def apply_command(store, streamer, tmux, msg: dict,
                        reply: Optional[Reply] = None, ws_id: int = 0):
    """Apply one command against the given store/streamer/tmux.

    `reply` sends a message back to the requester (the browser ws, on the hub).
    When None — the case inside an agent — requester-directed replies fall back
    to a global broadcast, which is correct because the hub fans the snapshot
    out to all browsers. Returns the new session id for `spawn`, a bool for
    `kill`, otherwise None.
    """
    mtype = msg.get("type", "")
    mid = msg.get("id", "")

    async def _reply(m: dict):
        if reply:
            await reply(m)
        else:
            streamer.broadcast(m)

    if mtype == "spawn":
        req_id = msg.get("reqId")
        try:
            s = await store.spawn(msg.get("cwd", ""), msg.get("cmd", ""), req_id=req_id)
        except Exception as e:
            # Surface the failure to the requester instead of dying silently.
            streamer.broadcast({"type": "spawn-error", "reqId": req_id or "", "error": str(e)})
            return None
        await streamer.start_stream(s.id, s.session_name)
        return s.id

    if mtype == "kill":
        s = store.get(mid)
        if s:
            await streamer.stop_stream(mid, s.session_name)
        return await store.kill(mid)

    if mtype == "remove":
        s = store.get(mid)
        if s:
            await streamer.stop_stream(mid, s.session_name)
        store.remove(mid)
        streamer.broadcast({"type": "removed", "id": mid})
        return None

    if mtype == "resize":
        rows = msg.get("rows")
        if isinstance(rows, int) and CANONICAL_ROWS <= rows <= 200:
            s = store.get(mid)
            if s and rows != s.display_rows:
                s.display_rows = rows
                await tmux.resize_window(s.session_name, CANONICAL_COLS, rows)
                # Give the TUI time to handle SIGWINCH and redraw.
                await asyncio.sleep(0.15)
                output = await streamer.get_snapshot(mid, s.session_name)
                if output:
                    streamer.broadcast({"type": "snapshot", "id": mid, "data": output})
        return None

    if mtype == "active":
        streamer.set_active(mid or None, ws_id=ws_id)
        if mid:
            s = store.get(mid)
            if s:
                await tmux.resize_window(s.session_name, CANONICAL_COLS, s.display_rows)
                output = await streamer.get_snapshot(mid, s.session_name)
                if output:
                    await _reply({"type": "snapshot", "id": mid, "data": output})
        return None

    if mtype == "resync":
        s = store.get(mid)
        if s:
            output = await streamer.get_snapshot(mid, s.session_name)
            if output:
                await _reply({"type": "snapshot", "id": mid, "data": output})
        return None

    if mtype == "title":
        store.set_title(mid, msg.get("title"))
        return None

    if mtype == "key":
        s = store.get(mid)
        if s:
            await tmux.send_keys(s.session_name, msg.get("key", ""))
            await streamer.poll_now(mid)
        return None

    if mtype == "terminal-input":
        s = store.get(mid)
        data = msg.get("data", "")
        if s and data:
            mapped = SEQ_MAP.get(data)
            if mapped:
                await tmux.send_keys(s.session_name, mapped)
            else:
                await tmux.send_keys(s.session_name, data, literal=True)
            await streamer.poll_now(mid)
        return None

    if mtype == "input":
        s = store.get(mid)
        if s:
            for line in msg.get("text", "").split("\n"):
                await tmux.send_keys(s.session_name, line, literal=True)
                await tmux.send_keys(s.session_name, "Enter")
            await streamer.poll_now(mid)
        return None

    if mtype == "paste":
        s = store.get(mid)
        if s:
            await tmux.paste_text(s.session_name, msg.get("text", ""))
            await streamer.poll_now(mid)
        return None

    log.debug("apply_command: unknown type %r", mtype)
    return None
