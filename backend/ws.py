from __future__ import annotations

import asyncio
import json
from typing import Set

from fastapi import WebSocket, WebSocketDisconnect

from . import tmux, streamer, commands
from .agents import registry
from .auth import verify_ws
from .logger import log
from .namespace import LOCAL, split_id
from .sessions import store, CANONICAL_COLS, CANONICAL_ROWS

clients: Set[WebSocket] = set()
_lock = asyncio.Lock()

# Which remote (host, local_id) each browser ws is currently viewing. Lets us
# tell an agent to drop back to background polling once its last viewer leaves.
_ws_remote: dict[int, tuple[str, str]] = {}


def broadcast(msg: dict):
    data = json.dumps(msg)
    dead = []
    for ws in clients:
        try:
            if ws.client_state.name == "CONNECTED":
                asyncio.create_task(_safe_send(ws, data))
        except Exception as e:
            log.debug("broadcast: dropping dead client: %s", e)
            dead.append(ws)
    for ws in dead:
        clients.discard(ws)


async def _safe_send(ws: WebSocket, data: str):
    try:
        await ws.send_text(data)
    except Exception as e:
        log.debug("ws send failed (client dropped): %s", e)
        clients.discard(ws)


async def handle_ws(ws: WebSocket):
    await ws.accept()
    if not verify_ws(ws):
        # Accept-then-close so the client sees the 4401 application close code
        # (closing pre-accept becomes an HTTP 403 the browser can't read).
        await ws.close(code=4401)
        return
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

        # Replay remote sessions from connected agents (mirror) so a browser
        # connecting after an agent sees its sessions. ids are already prefixed.
        for d in registry.mirror():
            await ws.send_text(json.dumps({
                "type": "spawned",
                "id": d["id"], "cwd": d["cwd"], "cmd": d["cmd"],
                "status": d["status"], "sessionName": d["sessionName"],
                "host": d["host"], "hostLabel": d["hostLabel"],
            }))
            if d["status"] != "stopped":
                await ws.send_text(json.dumps({"type": "status", "id": d["id"], "status": d["status"]}))
            if d.get("aiState"):
                await ws.send_text(json.dumps({"type": "aiState", "id": d["id"], "state": d["aiState"]}))
            if d.get("cwd"):
                await ws.send_text(json.dumps({"type": "cwd", "id": d["id"], "cwd": d["cwd"]}))
            if d.get("process") or d.get("createdAt"):
                await ws.send_text(json.dumps({
                    "type": "info", "id": d["id"],
                    "process": d["process"], "createdAt": d["createdAt"], "memKB": d["memKB"],
                }))
        remote_titles = registry.mirror_titles()
        if remote_titles:
            await ws.send_text(json.dumps({"type": "titles", "titles": remote_titles}))
    except Exception as e:
        log.debug("ws initial state send failed: %s", e)

    # Message loop
    try:
        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)
            await _handle_msg(msg, ws)
    except WebSocketDisconnect:
        pass
    except Exception:
        log.exception("ws message loop crashed")
    finally:
        async with _lock:
            clients.discard(ws)
        streamer.remove_client(id(ws))
        await _release_remote(id(ws))


async def _handle_msg(msg: dict, ws: WebSocket):
    msg_type = msg.get("type", "")
    host, local_id = split_id(msg.get("id", ""))

    # `active` needs cross-host coordination (only one fast-polled session per
    # machine), so it's handled specially rather than blindly forwarded.
    if msg_type == "active":
        await _handle_active(host, local_id, ws)
        return

    if host != LOCAL:
        # Remote session — forward the command to its agent with the bare id.
        m = dict(msg)
        m["id"] = local_id
        await registry.send(host, m)
        return

    async def reply(m: dict):
        try:
            await ws.send_text(json.dumps(m))
        except Exception as e:
            log.debug("ws reply failed: %s", e)

    m = dict(msg)
    m["id"] = local_id
    await commands.apply_command(store, streamer, tmux, m, reply=reply, ws_id=id(ws))


async def _handle_active(host: str, local_id: str, ws: WebSocket):
    """Switch the active (fast-polled) session, coordinating across machines.

    Each browser ws is tracked independently on the owning agent via its hub
    ws_id (sent as `wsId`), so two browsers viewing different sessions on the
    same host each get their own 80 ms poll instead of clobbering one slot.
    """
    ws_id = id(ws)

    async def reply(m: dict):
        try:
            await ws.send_text(json.dumps(m))
        except Exception as e:
            log.debug("ws reply failed: %s", e)

    prev = _ws_remote.pop(ws_id, None)
    new_remote = (host, local_id) if (host != LOCAL and local_id) else None

    # Demote this browser's previous remote view on its owning agent (per-ws).
    if prev and prev != new_remote:
        await registry.send(prev[0], {"type": "active", "id": "", "wsId": ws_id})

    if host == LOCAL:
        # Local session (or deactivate when local_id == ""). set_active + snapshot.
        await commands.apply_command(
            store, streamer, tmux,
            {"type": "active", "id": local_id}, reply=reply, ws_id=ws_id,
        )
    else:
        # Viewing a remote session: this ws has no local active session.
        streamer.set_active(None, ws_id=ws_id)
        if new_remote:
            _ws_remote[ws_id] = new_remote
            await registry.send(host, {"type": "active", "id": local_id, "wsId": ws_id})


async def _release_remote(ws_id: int):
    """A browser disconnected — deactivate the remote session it was viewing."""
    prev = _ws_remote.pop(ws_id, None)
    if prev:
        await registry.send(prev[0], {"type": "active", "id": "", "wsId": ws_id})


async def resume_active_for_host(host: str):
    """After an agent (re)connects, resume fast-polling the sessions browsers are
    currently viewing on it — the agent starts with no active state."""
    for ws_id, (h, local_id) in list(_ws_remote.items()):
        if h == host:
            await registry.send(host, {"type": "active", "id": local_id, "wsId": ws_id})
