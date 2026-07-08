"""Agent entrypoint.

Brings up this machine's local sessions exactly as the hub does, routes their
broadcasts to the hub over an outbound WebSocket, and applies hub commands.

Run from the repo root:  python -m agent.main
"""
from __future__ import annotations

import asyncio

from backend import streamer
from backend.sessions import store

from . import config
from .client import AgentClient


async def main():
    client = AgentClient()

    # Route every store/streamer broadcast to the hub instead of browser clients.
    store.set_broadcast(client.enqueue)
    streamer.set_broadcast(client.enqueue)

    # Same bring-up as the hub's lifespan: adopt existing tmux sessions, start
    # their FIFO streams, begin adaptive polling.
    await store.recover()
    for s in store.all():
        await streamer.start_stream(s.id, s.session_name)
    streamer.start_polling()

    print(f"[agent] host={config.HOST_ID} label={config.HOST_LABEL} → {config.HUB_URL}", flush=True)
    try:
        await client.run()
    finally:
        await streamer.stop_all()


def run():
    asyncio.run(main())


if __name__ == "__main__":
    run()
