"""Outbound WebSocket client: dials the hub, relays events, applies commands.

Reuses the backend's command layer (commands.apply_command) and module globals
(store/streamer/tmux) — this process owns its own copies, so there is no shared
state with the hub or with other agents.
"""
from __future__ import annotations

import asyncio
import json
from collections import deque

import websockets

from backend import commands, streamer, tmux
from backend.sessions import store

from . import config

# Fallback viewer id when the hub doesn't tag a frame with a browser ws_id.
AGENT_WS_ID = 1

KEEPALIVE_S = 15
MAX_BACKOFF_S = 30
QUEUE_MAX = 2000

# Durable frames must not be dropped under backpressure — losing one desyncs the
# hub mirror (a killed session staying "running") or loses scrollback (snapshot).
# Only transient `screen` (visible-area overwrite, replaced by the next poll) is
# safe to shed.
_DURABLE = {"spawned", "removed", "status", "snapshot", "aiState",
            "cwd", "info", "title", "titles", "pong"}


class AgentClient:
    def __init__(self):
        self._ws = None
        self._buf: deque = deque()
        self._ev = asyncio.Event()

    # ── broadcast sink (called synchronously by store/streamer) ──

    def enqueue(self, msg: dict):
        if self._ws is None:
            return  # disconnected: drop; full state is replayed on reconnect
        if len(self._buf) >= QUEUE_MAX:
            # Make room by shedding the OLDEST transient (screen) frame.
            for i, m in enumerate(self._buf):
                if m.get("type") == "screen":
                    del self._buf[i]
                    break
            else:
                # No transient to drop — queue is all durable frames.
                if msg.get("type") not in _DURABLE:
                    return  # incoming is transient; drop it rather than a durable one
                self._buf.popleft()  # last resort: sacrifice the oldest durable
        self._buf.append(msg)
        self._ev.set()

    # ── connection lifecycle ──

    def _validate(self):
        if not config.HUB_URL:
            raise SystemExit("AGENT_HUB_URL is required")
        if not config.TOKEN:
            raise SystemExit("AGENT_TOKEN is required")
        if config.HUB_URL.startswith("ws://") and not config.INSECURE:
            raise SystemExit(
                "Refusing plaintext ws:// — the agent token grants full shell "
                "access. Use wss://, or set AGENT_INSECURE=1 to override."
            )

    async def run(self):
        self._validate()
        backoff = 1
        while True:
            try:
                # max_size=None: a 2000-line ANSI snapshot can exceed the 1MB default.
                async with websockets.connect(
                    config.HUB_URL, max_size=None, ping_interval=20, ping_timeout=20
                ) as ws:
                    await self._session(ws)
                    backoff = 1
            except SystemExit:
                raise
            except Exception as e:
                print(f"[agent] hub connection lost: {e}", flush=True)
            self._ws = None
            self._drain()
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, MAX_BACKOFF_S)

    async def _session(self, ws):
        # Register first; the hub closes with 4401 on a bad token.
        await ws.send(json.dumps({
            "type": "register",
            "token": config.TOKEN,
            "host": config.HOST_ID,
            "label": config.HOST_LABEL,
        }))
        ack = json.loads(await ws.recv())
        if ack.get("type") != "register-ack":
            raise RuntimeError(f"unexpected hub reply: {ack}")
        print(f"[agent] connected to hub as host={config.HOST_ID}", flush=True)

        await self._replay(ws)              # full state before any live frames
        self._ws = ws                       # enqueue() goes live only now

        writer = asyncio.create_task(self._writer(ws))
        keep = asyncio.create_task(self._keepalive())
        try:
            await self._reader(ws)
        finally:
            self._ws = None
            writer.cancel()
            keep.cancel()

    async def _replay(self, ws):
        """Send the hub this machine's current sessions (in order, before frames)."""
        for s in store.all():
            await ws.send(json.dumps({
                "type": "spawned",
                "id": s.id, "cwd": s.cwd, "cmd": s.cmd,
                "status": s.status, "sessionName": s.session_name,
            }))
            if s.status != "stopped":
                await ws.send(json.dumps({"type": "status", "id": s.id, "status": s.status}))
            if s.ai_state:
                await ws.send(json.dumps({"type": "aiState", "id": s.id, "state": s.ai_state}))
            if s.cwd:
                await ws.send(json.dumps({"type": "cwd", "id": s.id, "cwd": s.cwd}))
            if s.process or s.created_at:
                await ws.send(json.dumps({
                    "type": "info", "id": s.id,
                    "process": s.process, "createdAt": s.created_at, "memKB": s.mem_kb,
                }))
        titles = store.titles
        if titles:
            await ws.send(json.dumps({"type": "titles", "titles": titles}))

    async def _reader(self, ws):
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            mt = msg.get("type")
            if mt == "register-ack" or mt == "pong":
                continue
            if mt == "ping":
                self.enqueue({"type": "pong"})
                continue
            try:
                # Each browser is keyed on the hub by its ws_id (sent as wsId) so
                # multiple viewers of this host each get their own active poll.
                ws_id = msg.get("wsId", AGENT_WS_ID)
                # reply=None → snapshots fan out via streamer.broadcast (→ hub → browsers)
                await commands.apply_command(store, streamer, tmux, msg, ws_id=ws_id)
            except Exception as e:
                print(f"[agent] command {mt} failed: {e}", flush=True)

    async def _writer(self, ws):
        while True:
            if not self._buf:
                self._ev.clear()
                await self._ev.wait()
                continue
            msg = self._buf.popleft()
            await ws.send(json.dumps(msg))

    async def _keepalive(self):
        while True:
            await asyncio.sleep(KEEPALIVE_S)
            self.enqueue({"type": "ping"})

    def _drain(self):
        self._buf.clear()
        self._ev.clear()
