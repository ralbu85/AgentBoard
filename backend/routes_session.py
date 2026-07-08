import time

from fastapi import APIRouter, Depends, Response, Request, HTTPException

from .auth import verify
from .sessions import store
from .models import (
    LoginRequest, SpawnRequest, InputRequest, KeyRequest, AttachRequest,
    SessionIdRequest, PushSubscribeRequest, PushUnsubscribeRequest, ProfilesRequest,
)
from .agents import registry
from .namespace import LOCAL, split_id
from . import config, tmux, streamer, commands, push, profiles

router = APIRouter(prefix="/api")


# Per-IP login throttle: { ip: (failed_count, locked_until_ts) }
_LOGIN_FAILS: dict[str, tuple[int, float]] = {}
_LOGIN_MAX_FAILS = 5
_LOGIN_LOCKOUT_S = 60.0


@router.post("/login")
async def login(req: LoginRequest, request: Request, response: Response):
    import hashlib, hmac
    ip = request.client.host if request.client else "?"
    fails, locked_until = _LOGIN_FAILS.get(ip, (0, 0.0))
    now = time.monotonic()
    if locked_until > now:
        retry_after = int(locked_until - now) + 1
        raise HTTPException(status_code=429, detail=f"Too many failed logins; retry in {retry_after}s")
    if locked_until and locked_until <= now:
        # Lockout expired — start fresh so a single typo doesn't immediately re-lock
        fails = 0
        locked_until = 0.0

    token = hmac.new(b"termhub", req.pw.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(token, config.AUTH_TOKEN):
        fails += 1
        locked_until = now + _LOGIN_LOCKOUT_S if fails >= _LOGIN_MAX_FAILS else 0.0
        _LOGIN_FAILS[ip] = (fails, locked_until)
        return {"ok": False}

    _LOGIN_FAILS.pop(ip, None)  # Successful login resets the counter for this IP
    response.set_cookie(
        "token", config.AUTH_TOKEN, path="/",
        httponly=True, samesite="lax", secure=config.COOKIE_SECURE,
    )
    return {"ok": True}


@router.get("/workers")
async def workers(_=Depends(verify)):
    # Local sessions carry no host field; the frontend defaults them to "local".
    # Remote sessions reach the browser over the WebSocket mirror, not here.
    return [s.to_dict() for s in store.all()]


@router.get("/hosts")
async def hosts(_=Depends(verify)):
    return [{"host": LOCAL, "label": "This machine", "online": True}] + registry.all_hosts()


@router.post("/spawn")
async def spawn(req: SpawnRequest, _=Depends(verify)):
    cmd_msg = {"type": "spawn", "cwd": req.cwd, "cmd": req.cmd, "reqId": req.reqId}
    if req.host != LOCAL:
        ok = await registry.send(req.host, cmd_msg)
        return {"ok": ok}
    new_id = await commands.apply_command(store, streamer, tmux, cmd_msg)
    return {"ok": new_id is not None, "id": new_id}


@router.post("/kill")
async def kill(req: SessionIdRequest, _=Depends(verify)):
    host, local_id = split_id(req.id)
    if host != LOCAL:
        ok = await registry.send(host, {"type": "kill", "id": local_id})
        return {"ok": ok}
    ok = await commands.apply_command(store, streamer, tmux, {"type": "kill", "id": local_id})
    return {"ok": ok}


@router.post("/remove")
async def remove(req: SessionIdRequest, _=Depends(verify)):
    host, local_id = split_id(req.id)
    if host != LOCAL:
        ok = await registry.send(host, {"type": "remove", "id": local_id})
        return {"ok": ok}
    await commands.apply_command(store, streamer, tmux, {"type": "remove", "id": local_id})
    return {"ok": True}


@router.post("/reconnect")
async def reconnect(req: SessionIdRequest, _=Depends(verify)):
    ok = await store.reconnect(req.id)
    if ok:
        s = store.get(req.id)
        if s:
            await streamer.start_stream(req.id, s.session_name)
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
    host, local_id = split_id(req.id)
    if host != LOCAL:
        ok = await registry.send(host, {"type": "input", "id": local_id, "text": req.text})
        return {"ok": ok}
    await commands.apply_command(store, streamer, tmux, {"type": "input", "id": local_id, "text": req.text})
    return {"ok": True}


@router.post("/paste")
async def paste_text(req: InputRequest, _=Depends(verify)):
    """Paste multi-line text as a single block (no line-by-line splitting)."""
    host, local_id = split_id(req.id)
    if host != LOCAL:
        ok = await registry.send(host, {"type": "paste", "id": local_id, "text": req.text})
        return {"ok": ok}
    await commands.apply_command(store, streamer, tmux, {"type": "paste", "id": local_id, "text": req.text})
    return {"ok": True}


@router.post("/key")
async def send_key(req: KeyRequest, _=Depends(verify)):
    host, local_id = split_id(req.id)
    if host != LOCAL:
        ok = await registry.send(host, {"type": "key", "id": local_id, "key": req.key})
        return {"ok": ok}
    await commands.apply_command(store, streamer, tmux, {"type": "key", "id": local_id, "key": req.key})
    return {"ok": True}


@router.get("/config")
async def get_config(_=Depends(verify)):
    return {"basePath": config.BASE_PATH, "favorites": config.FAVORITES,
            "defaultCommand": config.DEFAULT_COMMAND}


@router.get("/profiles")
async def get_profiles(_=Depends(verify)):
    return {"profiles": profiles.load()}


@router.put("/profiles")
async def put_profiles(req: ProfilesRequest, _=Depends(verify)):
    profiles.save([p.model_dump() for p in req.profiles])
    return {"ok": True, "profiles": profiles.load()}


@router.get("/push/key")
async def push_key(_=Depends(verify)):
    return {"key": push.public_key()}


@router.post("/push/subscribe")
async def push_subscribe(req: PushSubscribeRequest, _=Depends(verify)):
    push.subscribe({"endpoint": req.endpoint, "keys": req.keys, "expirationTime": req.expirationTime})
    return {"ok": True}


@router.post("/push/unsubscribe")
async def push_unsubscribe(req: PushUnsubscribeRequest, _=Depends(verify)):
    push.unsubscribe(req.endpoint)
    return {"ok": True}


@router.post("/perf")
async def perf(_=Depends(verify)):
    # No-op sink; accepts no body (an untyped dict body was an unbounded-payload
    # footgun and the endpoint does nothing with it).
    return {"ok": True}
