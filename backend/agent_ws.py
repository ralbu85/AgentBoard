"""Hub-side WebSocket endpoint for remote agents (/agent-ws).

An agent dials in, authenticates with a shared token in its first frame, then
streams its session events. The hub tags each event with the agent's host and
relays it to all browsers (and into the per-session mirror). Browser commands
flow the other way via agents.registry.send().
"""
from __future__ import annotations

import hmac
import json
import re

from fastapi import WebSocket, WebSocketDisconnect

from . import config, ws as ws_mod
from .agents import registry
from .logger import log
from .namespace import LOCAL, prefix_id, prefix_msg
from .ws import broadcast

_HOST_RE = re.compile(r"^[a-z0-9_-]{1,32}$")
_LABEL_MAX = 64
# Reject oversized inbound frames from an agent. A 2000-line ANSI snapshot is
# well under 1 MB; anything past this is malformed or hostile.
_MAX_FRAME = 4 * 1024 * 1024


def _clean_label(raw: str, host: str) -> str:
    label = "".join(ch for ch in str(raw) if ch.isprintable())[:_LABEL_MAX].strip()
    return label or host


async def handle_agent_ws(ws: WebSocket):
    await ws.accept()

    # First frame must be a valid register with the shared token. Authenticate
    # on every connect — an unauthenticated agent never enters the registry.
    try:
        raw = await ws.receive_text()
        if len(raw) > _MAX_FRAME:
            await ws.close(code=4400)
            return
        reg = json.loads(raw)
    except Exception:
        await ws.close(code=4400)
        return

    if reg.get("type") != "register" or not hmac.compare_digest(
        str(reg.get("token", "")), config.AGENT_TOKEN
    ):
        await ws.close(code=4401)
        return

    host = str(reg.get("host", ""))
    label = _clean_label(reg.get("label", ""), host)
    if host == LOCAL or not _HOST_RE.match(host):
        log.warning("agent rejected: invalid host id %r", host)
        await ws.close(code=4403)
        return

    # A re-registering host wins: evict the stale connection instead of rejecting.
    # A dropped TCP link lingers in the registry until uvicorn's ping timeout, so
    # rejecting would block reconnect for ~20-30s. The old ws's finally is made
    # a no-op by the conn-identity guard below.
    old = registry.get(host)
    if old is not None:
        log.info("agent re-register: evicting stale conn for host=%s", host)
        try:
            await old.ws.close(code=4409)
        except Exception:
            pass
        registry.unregister(host)

    conn = registry.register(host, label, ws)
    log.info("agent connected: host=%s label=%s", host, label)
    await ws.send_text(json.dumps({"type": "register-ack"}))

    # Resume fast-polling any sessions browsers are currently viewing on this
    # host (the agent starts with no active state after a reconnect).
    await ws_mod.resume_active_for_host(host)

    try:
        while True:
            raw = await ws.receive_text()
            if len(raw) > _MAX_FRAME:
                log.warning("agent %s sent oversized frame (%d bytes), dropping", host, len(raw))
                continue
            msg = json.loads(raw)
            mt = msg.get("type")
            if mt == "pong":
                continue
            if mt == "ping":
                await ws.send_text(json.dumps({"type": "pong"}))
                continue
            conn.update_from(msg)
            broadcast(prefix_msg(host, label, msg))
    except WebSocketDisconnect:
        pass
    except Exception:
        log.exception("agent ws loop crashed for host=%s", host)
    finally:
        # Only clean up if the registry still points at THIS connection — a
        # newer re-register may have already replaced us (see eviction above).
        if registry.get(host) is conn:
            registry.unregister(host)
            for local_id in list(conn.sessions.keys()):
                broadcast({
                    "type": "status",
                    "id": prefix_id(host, local_id),
                    "status": "stopped",
                    "host": host, "hostLabel": label,
                })
            log.info("agent disconnected: host=%s", host)
