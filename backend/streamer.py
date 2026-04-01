"""
Terminal output streaming via pipe-pane → FIFO → asyncio.

Each session gets:
  - A named FIFO at /tmp/agentboard-fifo-{session_name}
  - An asyncio task that reads the FIFO and broadcasts output
  - A ring buffer (last 8KB) for state detection

Snapshot (session switch): one-shot capture-pane with full history.
Background poll (2s): metadata + state detection for inactive sessions.
"""
from __future__ import annotations

import asyncio
import os
from typing import Callable

from . import tmux, config
from .state_detector import detect_state

_broadcast: Callable | None = None
_active_ids: dict[int, str] = {}             # ws_id → session id (per-client)
_tasks: dict[str, asyncio.Task] = {}         # id → FIFO reader task
_buffers: dict[str, bytearray] = {}          # id → ring buffer
_last_screen: dict[str, str] = {}            # id → last capture for diffing
_last_broadcast_time: dict[str, float] = {}  # id → last broadcast monotonic time
_last_change_at: dict[str, float] = {}       # id → monotonic time of last output change
_last_state_check: dict[str, float] = {}     # id → monotonic time of last state check

import re as _re
import time as _time

STATE_CHECK_INTERVAL = 0.5  # check state every 500ms even if output unchanged

RING_SIZE = 8192
ACTIVE_POLL_MS = 80
BG_POLL_MS = 2000
MIN_BROADCAST_INTERVAL = 0.08  # 80ms min between broadcasts per session

# Strip cursor visibility/position codes that cause false diffs (cursor blink)
_CURSOR_RE = _re.compile(r'\x1b\[\??(25[hl]|\d*[ABCDHJ])')

def _strip_cursor(s: str) -> str:
    return _CURSOR_RE.sub('', s)

def set_broadcast(fn: Callable):
    global _broadcast
    _broadcast = fn

_last_active_id: str | None = None  # most recently activated session

def set_active(id: str | None, ws_id: int = 0):
    """Track active session per client (ws_id)."""
    global _last_active_id
    if id:
        _active_ids[ws_id] = id
        _last_active_id = id
    else:
        _active_ids.pop(ws_id, None)

def remove_client(ws_id: int):
    """Clean up when a WS client disconnects."""
    _active_ids.pop(ws_id, None)

def get_active_session_ids() -> set[str]:
    """Return all session IDs that any client is actively viewing."""
    return set(_active_ids.values())

def broadcast(msg: dict):
    if _broadcast:
        _broadcast(msg)


# ── FIFO lifecycle ──

def _fifo_path(session_name: str) -> str:
    return str(config.FIFO_DIR / f"agentboard-fifo-{session_name}")


async def start_stream(id: str, session_name: str):
    if id in _tasks:
        return
    fifo = _fifo_path(session_name)

    # Clean stale FIFO
    try:
        os.unlink(fifo)
    except FileNotFoundError:
        pass
    os.mkfifo(fifo)

    await tmux.pipe_pane_start(session_name, fifo)
    _buffers[id] = bytearray()
    _tasks[id] = asyncio.create_task(_read_fifo(id, session_name, fifo))


async def stop_stream(id: str, session_name: str):
    task = _tasks.pop(id, None)
    if task:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
    await tmux.pipe_pane_stop(session_name)
    fifo = _fifo_path(session_name)
    try:
        os.unlink(fifo)
    except FileNotFoundError:
        pass
    _buffers.pop(id, None)
    _last_screen.pop(id, None)
    _last_change_at.pop(id, None)
    _last_state_check.pop(id, None)


async def _read_fifo(id: str, session_name: str, fifo: str):
    loop = asyncio.get_event_loop()
    fd = None
    try:
        # Open FIFO in non-blocking mode
        fd = os.open(fifo, os.O_RDONLY | os.O_NONBLOCK)
        reader = asyncio.StreamReader()
        transport, _ = await loop.connect_read_pipe(
            lambda: asyncio.StreamReaderProtocol(reader), os.fdopen(fd, 'rb', 0)
        )
        fd = None  # transport owns the fd now

        while True:
            data = await reader.read(4096)
            if not data:
                # FIFO writer closed — check if session still alive
                transport.close()
                from .sessions import store
                s = store.get(id)
                if not s or s.status in ("stopped", "completed"):
                    break
                if not await tmux.is_alive(session_name):
                    break
                await asyncio.sleep(0.5)
                fd = os.open(fifo, os.O_RDONLY | os.O_NONBLOCK)
                reader = asyncio.StreamReader()
                transport, _ = await loop.connect_read_pipe(
                    lambda: asyncio.StreamReaderProtocol(reader), os.fdopen(fd, 'rb', 0)
                )
                fd = None
                continue

            # Update ring buffer (used for state detection only)
            buf = _buffers.get(id)
            if buf is not None:
                buf.extend(data)
                if len(buf) > RING_SIZE:
                    del buf[:len(buf) - RING_SIZE]

    except asyncio.CancelledError:
        pass
    except Exception:
        pass
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass


# ── Snapshots ──

async def get_snapshot(id: str, session_name: str, cols: int = 80, rows: int = 50) -> str:
    from .sessions import store
    s = store.get(id)
    if not s:
        return ""

    await tmux.resize_window(session_name, cols, rows)

    raw, info_str = await asyncio.gather(
        tmux.capture_pane(session_name, lines=2000, ansi=True),
        tmux.display_info(session_name),
    )

    _update_info(id, s, info_str)
    _detect_state(id, s, raw)
    # Cache visible-area capture (same format as _poll_active uses)
    # so the next poll doesn't see a diff and overwrite the snapshot
    try:
        visible = await tmux.capture_pane(session_name, lines=0, ansi=True)
        _last_screen[id] = _strip_cursor(visible)
    except Exception:
        _last_screen[id] = _strip_cursor(raw)

    return raw.replace("\n", "\r\n")


async def poll_now(id: str):
    from .sessions import store
    s = store.get(id)
    if not s or s.status in ("stopped", "completed"):
        return
    try:
        output = await tmux.capture_pane(s.session_name, lines=s.rows or 50, ansi=True)
        if output != _last_screen.get(id):
            _last_screen[id] = output
            broadcast({"type": "screen", "id": id, "data": output.replace("\n", "\r\n")})
    except Exception:
        pass


# ── Background polling ──

async def _poll_active():
    _rr_index = 0
    while True:
        await asyncio.sleep(ACTIVE_POLL_MS / 1000)
        active_ids = list(get_active_session_ids())
        if not active_ids:
            continue

        # Prioritize the most recently activated session
        # Poll it every cycle, others round-robin on alternating cycles
        primary = _last_active_id if _last_active_id in active_ids else active_ids[0]
        others = [sid for sid in active_ids if sid != primary]

        to_poll = [primary]
        if others and _rr_index % 3 == 0:
            to_poll.append(others[(_rr_index // 3) % len(others)])
        _rr_index += 1

        from .sessions import store
        now = _time.monotonic()
        for sid in to_poll:
            s = store.get(sid)
            if not s or s.status in ("stopped", "completed"):
                continue
            try:
                output = await tmux.capture_pane(s.session_name, lines=0, ansi=True)
                stripped = _strip_cursor(output)
                changed = stripped != _last_screen.get(sid)

                if changed:
                    _last_screen[sid] = stripped
                    _last_change_at[sid] = now
                    broadcast({"type": "screen", "id": sid, "data": output.replace("\n", "\r\n")})

                # Check state periodically (not just on change)
                if changed or (now - _last_state_check.get(sid, 0) > STATE_CHECK_INTERVAL):
                    _last_state_check[sid] = now
                    stable_for = now - _last_change_at.get(sid, 0)
                    _detect_state(sid, s, output, stable_for)
            except Exception:
                pass


async def _poll_background():
    while True:
        await asyncio.sleep(BG_POLL_MS / 1000)
        from .sessions import store
        for id, s in list(store.sessions.items()):
            if s.status == "stopped":
                continue

            alive = await tmux.is_alive(s.session_name)
            if not alive:
                if s.status != "completed":
                    s.status = "completed"
                    s.ai_state = None
                    broadcast({"type": "status", "id": id, "status": "completed"})
                continue

            if id in get_active_session_ids():
                continue

            try:
                info, tail = await asyncio.gather(
                    tmux.display_info(s.session_name),
                    tmux.capture_pane(s.session_name, lines=20),
                )
                _update_info(id, s, info)
                _detect_state(id, s, tail)
            except Exception:
                pass


async def _poll_active_info():
    while True:
        await asyncio.sleep(2)
        active_ids = get_active_session_ids()
        if not active_ids:
            continue
        from .sessions import store
        for sid in active_ids:
            s = store.get(sid)
            if not s or s.status in ("stopped", "completed"):
                continue
            try:
                info, tail = await asyncio.gather(
                    tmux.display_info(s.session_name),
                    tmux.capture_pane(s.session_name, lines=20),
                )
                _update_info(sid, s, info)
                _detect_state(sid, s, tail)
            except Exception:
                pass


# ── Helpers ──

def _update_info(id: str, s, info: dict):
    cwd = info.get("cwd", "")
    process = info.get("process", "")
    created_at = info.get("created_at", 0)

    if cwd and cwd != s.cwd:
        s.cwd = cwd
        broadcast({"type": "cwd", "id": id, "cwd": cwd})
    if process != s.process or created_at != s.created_at:
        s.process = process
        s.created_at = created_at
        broadcast({"type": "info", "id": id, "process": process, "createdAt": created_at, "memKB": s.mem_kb})


_pending_idle: dict[str, float] = {}  # id → monotonic time when idle was first detected
IDLE_DEBOUNCE = 1.0  # wait 1s before broadcasting idle (prevents flicker)

def _detect_state(id: str, s, output: str, stable_seconds: float = -1.0):
    new_state = detect_state(output, s.process, stable_seconds)
    if new_state == s.ai_state:
        _pending_idle.pop(id, None)
        return

    # Debounce: delay idle transitions to prevent working↔idle flicker
    if new_state == "idle" and s.ai_state == "working":
        now = _time.monotonic()
        first_seen = _pending_idle.get(id)
        if first_seen is None:
            _pending_idle[id] = now
            return  # don't broadcast yet
        if now - first_seen < IDLE_DEBOUNCE:
            return  # still within debounce window
        # Debounce passed — commit the transition
        _pending_idle.pop(id, None)
    else:
        _pending_idle.pop(id, None)

    s.ai_state = new_state
    broadcast({"type": "aiState", "id": id, "state": new_state})


# ── Lifecycle ──

_bg_tasks: list[asyncio.Task] = []

def start_polling():
    _bg_tasks.append(asyncio.create_task(_poll_active()))
    _bg_tasks.append(asyncio.create_task(_poll_background()))
    _bg_tasks.append(asyncio.create_task(_poll_active_info()))


async def stop_all():
    for t in _bg_tasks:
        t.cancel()
    for id in list(_tasks):
        from .sessions import store
        s = store.get(id)
        if s:
            await stop_stream(id, s.session_name)
    _bg_tasks.clear()
