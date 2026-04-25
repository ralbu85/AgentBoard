import asyncio
import mimetypes
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Response
from fastapi.responses import FileResponse

from . import config, streamer, tunnel
from .logger import log
from .sessions import store
from .routes_session import router as session_router
from .routes_file import router as file_router
from .ws import handle_ws, broadcast

_frontend_dist = Path(__file__).parent.parent / "frontend" / "dist"


@asynccontextmanager
async def lifespan(app: FastAPI):
    store.set_broadcast(broadcast)
    streamer.set_broadcast(broadcast)
    tunnel.set_broadcast(broadcast)

    await store.recover()

    for s in store.all():
        await streamer.start_stream(s.id, s.session_name)

    streamer.start_polling()

    if config.DISCORD_WEBHOOK:
        await tunnel.start()

    if config.PASSWORD == "changeme":
        log.warning("Using default password 'changeme' — set DASHBOARD_PASSWORD in .env")

    log.info("AgentBoard running on http://localhost:%s", config.PORT)
    yield

    await streamer.stop_all()
    await tunnel.stop()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)

app.include_router(session_router)
app.include_router(file_router)
app.add_api_websocket_route("/ws", handle_ws)


def _serve_index():
    """Always read index.html fresh from disk so deploys take effect immediately."""
    html_path = _frontend_dist / "index.html"
    if not html_path.exists():
        return Response("Not found", status_code=404)
    return Response(
        content=html_path.read_bytes(),
        media_type="text/html",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )


if _frontend_dist.exists():
    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        if full_path:
            static = _frontend_dist / full_path
            if static.is_file():
                mime = mimetypes.guess_type(str(static))[0] or "application/octet-stream"
                return Response(
                    content=static.read_bytes(),
                    media_type=mime,
                    headers={"Cache-Control": "no-cache, must-revalidate"},
                )
        return _serve_index()


def run():
    import uvicorn
    uvicorn.run(
        "backend.main:app",
        host="0.0.0.0",
        port=config.PORT,
        log_level="warning",
    )


if __name__ == "__main__":
    run()
