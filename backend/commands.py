"""Command application shared by the hub (local sessions) and remote agents.

`apply_command` is the single mutation point for session commands. The hub's
WebSocket handler and REST endpoints call it for local sessions; each agent
calls it for its own sessions. store/streamer/tmux are passed in explicitly so
the hub and each agent process bind their own module instances (no global
cross-import, no shared state between processes).
"""
from __future__ import annotations

import asyncio
import uuid
from typing import Awaitable, Callable, Optional

from .logger import log
from .terminal_geometry import viewports, frame_meta
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
        ok = await store.kill(mid)
        if ok and s:
            await streamer.stop_stream(mid, s.session_name)
        return ok

    if mtype == "remove":
        s = store.get(mid)
        if s and getattr(s, "status", "running") == "running":
            return False  # Hide a live session in the UI; do not orphan its process.
        if s:
            await streamer.stop_stream(mid, s.session_name)
        store.remove(mid)
        streamer.broadcast({"type": "removed", "id": mid})
        return None

    if mtype == 'viewport-release':
        viewports.release(ws_id, mid or None)
        return None

    if mtype == 'viewport':
        s = store.get(mid)
        device, cols = msg.get('device'), msg.get('cols')
        if not s or not ws_id or device not in ('desktop', 'mobile'):
            return None
        if device == 'desktop' and (type(cols) is not int or not 80 <= cols <= 240):
            return None
        requested = cols if device == 'desktop' else None
        viewports.update(mid, ws_id, requested)
        cols = viewports.target_columns(mid)
        if (cols is None or cols == s.display_cols) and getattr(s, 'geometry_verified', True):
            return None
        if not hasattr(s, 'resize_lock'):
            s.resize_lock = asyncio.Lock()
        async with s.resize_lock:
            viewports.update(mid, ws_id, requested)
            cols = viewports.target_columns(mid)
            if (cols is None or cols == s.display_cols) and getattr(s, 'geometry_verified', True):
                return None
            s.resizing = True
            s.geometry_verified = False
            s.grid_revision = getattr(s, 'grid_revision', 0) + 1
            try:
                if cols is not None:
                    await tmux.resize_window(s.session_name, cols, CANONICAL_ROWS)
                actual = await tmux.pane_size(s.session_name)
                if actual and 30 <= actual[0] <= 240 and 1 <= actual[1] <= 200:
                    s.display_cols, s.display_rows = actual
                    s.geometry_verified = True
                else:
                    log.warning('Cannot verify terminal dimensions for %s', s.session_name)
            except Exception as exc:
                log.warning('Terminal resize failed for %s: %s', s.session_name, exc)
            finally:
                s.resizing = False
            if not s.geometry_verified:
                # The next viewport heartbeat retries. Never label a frame
                # with guessed dimensions after a partial resize failure.
                return None
            output = await streamer.get_snapshot(mid, s.session_name)
            if output:
                # Every viewer must replace its old-width history together.
                streamer.broadcast({'type':'snapshot', 'id':mid, 'data':output, **frame_meta(s, output)})
        return None

    if mtype == "resize":
        # Old browsers may request rows/columns. They cannot take ownership.
        rows = msg.get('rows')
        s = store.get(mid)
        if type(rows) is int and CANONICAL_ROWS <= rows <= 200 and s:
            output = await streamer.get_snapshot(mid, s.session_name)
            if output:
                await _reply({'type':'snapshot', 'id':mid, 'data':output, **frame_meta(s, output)})
        return None

    if mtype == "active":
        streamer.set_active(mid or None, ws_id=ws_id)
        if mid:
            s = store.get(mid)
            if s:
                output = await streamer.get_snapshot(mid, s.session_name)
                if output:
                    await _reply({'type':'snapshot', 'id':mid, 'data':output, **frame_meta(s, output)})
        return None

    if mtype == "resync":
        s = store.get(mid)
        if s:
            output = await streamer.get_snapshot(mid, s.session_name)
            if output:
                await _reply({'type':'snapshot', 'id':mid, 'data':output, **frame_meta(s, output)})
        return None

    if mtype == "title":
        store.set_title(mid, msg.get("title"))
        return None

    if mtype == "key":
        s = store.get(mid)
        if s:
            if msg.get("key") == "Enter":
                s.submission_id = uuid.uuid4().hex
            await tmux.send_keys(s.session_name, msg.get("key", ""))
            await streamer.poll_now(mid)
        return None

    if mtype == "terminal-input":
        s = store.get(mid)
        data = msg.get("data", "")
        if s and data:
            mapped = SEQ_MAP.get(data)
            if mapped == "Enter":
                s.submission_id = uuid.uuid4().hex
            if mapped:
                await tmux.send_keys(s.session_name, mapped)
            else:
                await tmux.send_keys(s.session_name, data, literal=True)
            await streamer.poll_now(mid)
        return None

    if mtype in ('input', 'paste'):
        s = store.get(mid)
        if not s or getattr(s, 'status', 'running') in ('stopped', 'completed'):
            raise ValueError('세션이 종료되어 입력을 전달하지 못했습니다.')
        lock = getattr(s, 'input_lock', None)
        if lock is None:
            s.input_lock = lock = asyncio.Lock()
        # A Send is one message, including empty lines and trailing newlines.
        # Keep paste + final Enter together when devices send concurrently.
        async with lock:
            s.submission_id = uuid.uuid4().hex
            text = msg.get('text', '').replace('\r\n', '\n').replace('\r', '\n')
            if '\n' in text or mtype == 'paste':
                await tmux.paste_text(s.session_name, text)
            elif text:
                await tmux.send_keys(s.session_name, text, literal=True)
            await tmux.send_keys(s.session_name, 'Enter')
        await streamer.poll_now(mid)
        return None

    log.debug("apply_command: unknown type %r", mtype)
    return None
