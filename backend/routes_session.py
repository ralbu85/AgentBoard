from fastapi import APIRouter, Depends, Response, Request

from .auth import verify
from .sessions import store
from .models import LoginRequest, SpawnRequest, InputRequest, KeyRequest, AttachRequest
from . import config, tmux, streamer

router = APIRouter(prefix="/api")


@router.post("/login")
async def login(req: LoginRequest, response: Response):
    import hashlib, hmac
    token = hmac.new(b"termhub", req.pw.encode(), hashlib.sha256).hexdigest()
    if token != config.AUTH_TOKEN:
        return {"ok": False}
    response.set_cookie("token", config.AUTH_TOKEN, path="/", httponly=True)
    return {"ok": True}


@router.get("/workers")
async def workers(_=Depends(verify)):
    return [s.to_dict() for s in store.all()]


@router.post("/spawn")
async def spawn(req: SpawnRequest, _=Depends(verify)):
    s = await store.spawn(req.cwd, req.cmd)
    await streamer.start_stream(s.id, s.session_name)
    return {"ok": True, "id": s.id}


@router.post("/kill")
async def kill(req: dict, _=Depends(verify)):
    id = req.get("id", "")
    s = store.get(id)
    if s:
        await streamer.stop_stream(id, s.session_name)
    ok = await store.kill(id)
    return {"ok": ok}


@router.post("/remove")
async def remove(req: dict, _=Depends(verify)):
    id = req.get("id", "")
    s = store.get(id)
    if s:
        await streamer.stop_stream(id, s.session_name)
    store.remove(id)
    return {"ok": True}


@router.post("/reconnect")
async def reconnect(req: dict, _=Depends(verify)):
    id = req.get("id", "")
    ok = await store.reconnect(id)
    if ok:
        s = store.get(id)
        if s:
            await streamer.start_stream(id, s.session_name)
    return {"ok": ok}


@router.post("/attach")
async def attach(req: AttachRequest, _=Depends(verify)):
    alive = await tmux.is_alive(req.sessionName)
    if not alive:
        return {"ok": False, "error": "Session not found"}
    s = store.add(req.sessionName, req.cwd, config.DEFAULT_COMMAND)
    await streamer.start_stream(s.id, s.session_name)
    store.broadcast({
        "type": "spawned",
        "id": s.id, "cwd": s.cwd, "cmd": s.cmd,
        "status": s.status, "sessionName": s.session_name,
    })
    return {"id": s.id}


@router.get("/scan")
async def scan(_=Depends(verify)):
    all_sessions = await tmux.list_sessions()
    managed = {s.session_name for s in store.all()}
    unmanaged = [s for s in all_sessions if s["sessionName"] not in managed]
    return unmanaged


@router.post("/input")
async def input_text(req: InputRequest, _=Depends(verify)):
    s = store.get(req.id)
    if not s:
        return {"ok": False}
    lines = req.text.split("\n")
    for line in lines:
        await tmux.send_keys(s.session_name, line, literal=True)
        await tmux.send_keys(s.session_name, "Enter")
    await streamer.poll_now(req.id)
    return {"ok": True}


@router.post("/paste")
async def paste_text(req: InputRequest, _=Depends(verify)):
    """Paste multi-line text as a single block (no line-by-line splitting)."""
    s = store.get(req.id)
    if not s:
        return {"ok": False}
    await tmux.paste_text(s.session_name, req.text)
    await streamer.poll_now(req.id)
    return {"ok": True}


@router.post("/key")
async def send_key(req: KeyRequest, _=Depends(verify)):
    s = store.get(req.id)
    if not s:
        return {"ok": False}
    await tmux.send_keys(s.session_name, req.key)
    await streamer.poll_now(req.id)
    return {"ok": True}


@router.get("/config")
async def get_config(_=Depends(verify)):
    return {"basePath": config.BASE_PATH}


@router.post("/perf")
async def perf(req: dict, _=Depends(verify)):
    return {"ok": True}
