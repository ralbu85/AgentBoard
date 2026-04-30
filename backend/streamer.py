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
from .logger import log
from .state_detector import detect_state

_broadcast: Callable | None = None
_active_ids: dict[int, str] = {}             # ws_id → session id (per-client)
_tasks: dict[str, asyncio.Task] = {}         # id → FIFO reader task
_buffers: dict[str, bytearray] = {}          # id → ring buffer
_last_screen: dict[str, str] = {}            # id → last capture for diffing
_last_broadcast_time: dict[str, float] = {}  # id → last broadcast monotonic time
_last_change_at: dict[str, float] = {}       # id → monotonic time of last output change
_last_state_check: dict[str, float] = {}     # id → monotonic time of last state check
_last_history_size: dict[str, int] = {}      # id → tmux #{history_size} at last poll

import re as _re
import time as _time

STATE_CHECK_INTERVAL = 0.5  # check state every 500ms even if output unchanged

RING_SIZE = 8192
ACTIVE_POLL_MS = 80
BG_POLL_MS = 2000
MIN_BROADCAST_INTERVAL = 0.08  # 80ms min between broadcasts per session

# Active poll dynamically slows when the primary session has been quiet.
# Saves CPU on idle dashboards while staying responsive when output is flowing.
_ACTIVE_POLL_TIERS = (
    (1.0, 0.08),    # output within last 1s → 80ms
    (5.0, 0.20),    # 1–5s quiet → 200ms
    (30.0, 0.50),   # 5–30s quiet → 500ms
)
_ACTIVE_POLL_IDLE_S = 1.0  # >30s quiet → 1000ms

def _active_sleep_for(primary_id: str | None) -> float:
    if not primary_id:
        return ACTIVE_POLL_MS / 1000
    last_change = _last_change_at.get(primary_id)
    if last_change is None:
        return ACTIVE_POLL_MS / 1000
    idle_for = _time.monotonic() - last_change
    for threshold, sleep_s in _ACTIVE_POLL_TIERS:
        if idle_for < threshold:
            return sleep_s
    return _ACTIVE_POLL_IDLE_S

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
    _last_history_size.pop(id, None)


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
        log.exception("FIFO reader crashed for session id=%s name=%s", id, session_name)
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass


# ── Snapshots ──

async def get_snapshot(id: str, session_name: str) -> str:
    from .sessions import store
    s = store.get(id)
    if not s:
        return ""

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
    except Exception as e:
        log.debug("snapshot fallback (visible capture failed) for %s: %s", session_name, e)
        _last_screen[id] = _strip_cursor(raw)

    # Sync history baseline so the next active poll doesn't re-broadcast
    # scrollback already included in this snapshot
    try:
        _last_history_size[id] = await tmux.history_size(session_name)
    except Exception as e:
        log.debug("history_size sync failed for %s: %s", session_name, e)

    return raw.rstrip("\n").replace("\n", "\r\n")


async def poll_now(id: str):
    from .sessions import store
    s = store.get(id)
    if not s or s.status in ("stopped", "completed"):
        return
    try:
        output = await tmux.capture_pane(s.session_name, lines=0, ansi=True)
        if output != _last_screen.get(id):
            _last_screen[id] = output
            broadcast({"type": "screen", "id": id, "data": output.rstrip("\n").replace("\n", "\r\n")})
    except Exception as e:
        log.debug("poll_now capture failed for %s: %s", s.session_name, e)


# ── Background polling ──

async def _poll_active():
    _rr_index = 0
    primary: str | None = None
    while True:
        await asyncio.sleep(_active_sleep_for(primary))
        active_ids = list(get_active_session_ids())
        if not active_ids:
            primary = None
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
                # Detect scrollback growth: lines that scrolled off visible since
                # the last poll. capture-pane(lines=0) only sees the post-burst
                # viewport, so a fast burst (e.g. `cat largefile`) loses everything
                # above it. When history grew, re-snapshot atomically — writeSnapshot
                # rebuilds scrollback + visible in one write and preserves the
                # ordering, sidestepping the cursor games that an append-style stream
                # would require.
                current_hist = await tmux.history_size(s.session_name)
                last_hist = _last_history_size.get(sid)
                if last_hist is not None and current_hist > last_hist:
                    snapshot_raw = await tmux.capture_pane(s.session_name, lines=2000, ansi=True)
                    if snapshot_raw:
                        broadcast({
                            "type": "snapshot",
                            "id": sid,
                            "data": snapshot_raw.rstrip("\n").replace("\n", "\r\n"),
                        })
                        _last_broadcast_time[sid] = now
                    visible = await tmux.capture_pane(s.session_name, lines=0, ansi=True)
                    _last_screen[sid] = _strip_cursor(visible)
                    _last_history_size[sid] = current_hist
                    _last_change_at[sid] = now
                    _last_state_check[sid] = now
                    _detect_state(sid, s, visible, 0.0)
                    continue

                _last_history_size[sid] = current_hist

                output = await tmux.capture_pane(s.session_name, lines=0, ansi=True)
                stripped = _strip_cursor(output)
                changed = stripped != _last_screen.get(sid)

                if changed:
                    _last_screen[sid] = stripped
                    _last_change_at[sid] = now
                    # Throttle: skip if last broadcast was too recent
                    if now - _last_broadcast_time.get(sid, 0) >= MIN_BROADCAST_INTERVAL:
                        _last_broadcast_time[sid] = now
                        broadcast({"type": "screen", "id": sid, "data": output.rstrip("\n").replace("\n", "\r\n")})

                # Check state periodically (not just on change)
                if changed or (now - _last_state_check.get(sid, 0) > STATE_CHECK_INTERVAL):
                    _last_state_check[sid] = now
                    stable_for = now - _last_change_at.get(sid, 0)
                    _detect_state(sid, s, output, stable_for)
            except Exception as e:
                log.debug("active poll failed for %s: %s", s.session_name, e)


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
            except Exception as e:
                log.debug("background poll failed for %s: %s", s.session_name, e)


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
                info = await tmux.display_info(s.session_name)
                _update_info(sid, s, info)
                # State detection already handled by _poll_active — skip here
            except Exception as e:
                log.debug("active info poll failed for %s: %s", s.session_name, e)


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
