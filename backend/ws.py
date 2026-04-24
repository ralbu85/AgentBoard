from __future__ import annotations

import asyncio
import json
from typing import Set

from fastapi import WebSocket, WebSocketDisconnect

from . import tmux, streamer
from .sessions import store, CANONICAL_COLS, CANONICAL_ROWS

clients: Set[WebSocket] = set()
_lock = asyncio.Lock()

SEQ_MAP = {
    "\r": "Enter", "\x1b": "Escape", "\t": "Tab",
    "\x1b[A": "Up", "\x1b[B": "Down", "\x1b[C": "Right", "\x1b[D": "Left",
    "\x7f": "BSpace", "\x08": "BSpace",
    "\x03": "C-c", "\x04": "C-d", "\x1a": "C-z",
    "\x1b[H": "Home", "\x1b[F": "End",
    "\x1b[5~": "PageUp", "\x1b[6~": "PageDown",
    "\x1b[3~": "DC",
}


def broadcast(msg: dict):
    data = json.dumps(msg)
    dead = []
    for ws in clients:
        try:
            if ws.client_state.name == "CONNECTED":
                asyncio.create_task(_safe_send(ws, data))
        except Exception:
            dead.append(ws)
    for ws in dead:
        clients.discard(ws)


async def _safe_send(ws: WebSocket, data: str):
    try:
        await ws.send_text(data)
    except Exception:
        clients.discard(ws)


async def handle_ws(ws: WebSocket):
    await ws.accept()
    async with _lock:
        clients.add(ws)

    # Send current state
    try:
        for s in store.all():
            await ws.send_text(json.dumps({
                "type": "spawned",
                "id": s.id, "cwd": s.cwd, "cmd": s.cmd,
                "status": s.status, "sessionName": s.session_name,
            }))
            if s.status != "stopped":
                await ws.send_text(json.dumps({"type": "status", "id": s.id, "status": s.status}))
            if s.ai_state:
                await ws.send_text(json.dumps({"type": "aiState", "id": s.id, "state": s.ai_state}))
            if s.cwd:
                await ws.send_text(json.dumps({"type": "cwd", "id": s.id, "cwd": s.cwd}))
            if s.process or s.created_at:
                await ws.send_text(json.dumps({
                    "type": "info", "id": s.id,
                    "process": s.process, "createdAt": s.created_at, "memKB": s.mem_kb,
                }))

        titles = store.titles
        if titles:
            await ws.send_text(json.dumps({"type": "titles", "titles": titles}))
    except Exception:
        pass

    # Message loop
    try:
        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)
            await _handle_msg(msg, ws)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        async with _lock:
            clients.discard(ws)
        streamer.remove_client(id(ws))


async def _handle_msg(msg: dict, ws: WebSocket):
    msg_type = msg.get("type", "")
    msg_id = msg.get("id", "")

    if msg_type == "resize":
        rows = msg.get("rows")
        if isinstance(rows, int) and CANONICAL_ROWS <= rows <= 200:
            s = store.get(msg_id)
            if s and rows != s.display_rows:
                s.display_rows = rows
                await tmux.resize_window(s.session_name, CANONICAL_COLS, rows)
                # Give the TUI time to handle SIGWINCH and redraw
                await asyncio.sleep(0.15)
                # Full snapshot with history so the viewport fills via scrollback
                output = await streamer.get_snapshot(msg_id, s.session_name)
                if output:
                    broadcast({"type": "snapshot", "id": msg_id, "data": output})

    elif msg_type == "active":
        streamer.set_active(msg_id or None, ws_id=id(ws))
        if msg_id:
            s = store.get(msg_id)
            if s:
                # Apply the session's current display size (last client's resize wins)
                await tmux.resize_window(s.session_name, CANONICAL_COLS, s.display_rows)
                output = await streamer.get_snapshot(msg_id, s.session_name)
                if output:
                    await ws.send_text(json.dumps({"type": "snapshot", "id": msg_id, "data": output}))

    elif msg_type == "resync":
        s = store.get(msg_id)
        if s:
            output = await streamer.get_snapshot(msg_id, s.session_name)
            if output:
                await ws.send_text(json.dumps({"type": "snapshot", "id": msg_id, "data": output}))

    elif msg_type == "title":
        store.set_title(msg_id, msg.get("title"))

    elif msg_type == "key":
        s = store.get(msg_id)
        if s:
            await tmux.send_keys(s.session_name, msg.get("key", ""))
            await streamer.poll_now(msg_id)

    elif msg_type == "terminal-input":
        s = store.get(msg_id)
        data = msg.get("data", "")
        if s and data:
            mapped = SEQ_MAP.get(data)
            if mapped:
                await tmux.send_keys(s.session_name, mapped)
            else:
                await tmux.send_keys(s.session_name, data, literal=True)
            await streamer.poll_now(msg_id)

    elif msg_type == "input":
        s = store.get(msg_id)
        if s:
            lines = msg.get("text", "").split("\n")
            for line in lines:
                await tmux.send_keys(s.session_name, line, literal=True)
                await tmux.send_keys(s.session_name, "Enter")
            await streamer.poll_now(msg_id)
