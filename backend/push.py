"""Web Push (VAPID) notifications for session attention events.

Fires an OS-level browser push when a session needs the user — it goes to
`waiting` (an agent is asking something) or finishes (`completed`/`stopped`).
Works with the tab closed; the service worker (frontend/public/sw.js) renders it.

Hub-only: browsers subscribe here; state changes for both local and remote
sessions flow through ws.broadcast(), where maybe_push() inspects them.
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import time
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from pywebpush import WebPushException, webpush

from . import config
from .logger import log
from .namespace import split_id

_VAPID_PEM = config.PROJECT_ROOT / ".vapid_private.pem"
_SUBS_FILE = config.PROJECT_ROOT / ".push-subs.json"

_private_key = None            # cryptography EC private key
_app_server_key: str = ""      # base64url raw public point (applicationServerKey)
_subs: dict[str, dict] = {}    # endpoint -> subscription info
_last_state: dict[str, str] = {}  # session id -> last state we notified on (dedup)


# ── VAPID keypair (persisted, generated once) ──

def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _load_or_create_vapid():
    global _private_key, _app_server_key
    if _VAPID_PEM.exists():
        _private_key = serialization.load_pem_private_key(_VAPID_PEM.read_bytes(), password=None)
    else:
        _private_key = ec.generate_private_key(ec.SECP256R1())
        pem = _private_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
        tmp = _VAPID_PEM.with_suffix(".pem.tmp")
        tmp.write_bytes(pem)
        os.replace(tmp, _VAPID_PEM)
        log.info("generated VAPID keypair at %s", _VAPID_PEM)
    raw_pub = _private_key.public_key().public_bytes(
        serialization.Encoding.X962,
        serialization.PublicFormat.UncompressedPoint,
    )
    _app_server_key = _b64url(raw_pub)


# ── Subscription store ──

def _load_subs():
    global _subs
    if not _SUBS_FILE.exists():
        return
    try:
        data = json.loads(_SUBS_FILE.read_text())
        _subs = {s["endpoint"]: s for s in data if "endpoint" in s}
    except Exception as e:
        log.warning("push subs unreadable, starting empty: %s", e)
        _subs = {}


def _save_subs():
    try:
        tmp = _SUBS_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(list(_subs.values())))
        os.replace(tmp, _SUBS_FILE)
    except Exception as e:
        log.warning("push subs save failed: %s", e)


def init():
    _load_or_create_vapid()
    _load_subs()
    log.info("push ready: %d subscription(s)", len(_subs))


def public_key() -> str:
    return _app_server_key


def subscribe(sub: dict):
    ep = sub.get("endpoint")
    if not ep:
        return
    _subs[ep] = sub
    _save_subs()


def unsubscribe(endpoint: str):
    if _subs.pop(endpoint, None) is not None:
        _save_subs()


# ── Sending ──

def _vapid_claims() -> dict:
    return {"sub": config.VAPID_SUBJECT}


def _send_one(sub: dict, payload: str):
    """Blocking send of one push (runs in a worker thread). Returns endpoint to
    prune if the subscription is gone (404/410), else None."""
    try:
        webpush(
            subscription_info=sub,
            data=payload,
            vapid_private_key=str(_VAPID_PEM),
            vapid_claims=dict(_vapid_claims()),
            timeout=10,
        )
    except WebPushException as e:
        status = getattr(e.response, "status_code", None)
        if status in (404, 410):
            return sub.get("endpoint")  # subscription expired — prune
        log.debug("web push failed (%s): %s", status, e)
    except Exception as e:
        log.debug("web push error: %s", e)
    return None


async def notify(title: str, body: str, tag: str, url: str):
    if not _subs or _private_key is None:
        return
    payload = json.dumps({"title": title, "body": body, "tag": tag, "url": url})
    targets = list(_subs.values())
    results = await asyncio.gather(
        *(asyncio.to_thread(_send_one, s, payload) for s in targets),
        return_exceptions=True,
    )
    pruned = False
    for r in results:
        if isinstance(r, str):
            _subs.pop(r, None)
            pruned = True
    if pruned:
        _save_subs()


# ── State-change hook (called from ws.broadcast) ──

def _display_name(sid: str) -> str:
    from .sessions import store
    title = store.titles.get(sid)
    if title:
        return title
    s = store.get(sid)
    if s:
        return f"#{sid} {s.cmd}".strip()
    # remote session
    from .agents import registry
    host, local = split_id(sid)
    conn = registry.get(host)
    if conn:
        t = conn.titles.get(local)
        if t:
            return f"{conn.label}: {t}"
        sess = conn.sessions.get(local)
        if sess and sess.get("cmd"):
            return f"{conn.label}: {sess['cmd']}"
    return sid


def maybe_push(msg: dict):
    """Inspect a browser-bound broadcast; fire a push on attention transitions.

    Deduped per session so we only notify on entering waiting/completed, not on
    every repeated frame."""
    mtype = msg.get("type")
    sid = msg.get("id", "")
    if not sid:
        return

    event = None
    if mtype == "aiState":
        state = msg.get("state")
        if state == "waiting":
            event = "waiting"
        elif state in ("working", "idle"):
            # Back to active/idle — reset the latch so the NEXT waiting notifies.
            _last_state.pop(sid, None)
            return
    elif mtype == "status" and msg.get("status") in ("completed", "stopped"):
        event = msg.get("status")
    elif mtype == "status" and msg.get("status") == "running":
        _last_state.pop(sid, None)
        return

    if not event:
        return
    if _last_state.get(sid) == event:
        return
    _last_state[sid] = event

    if not _subs:
        return
    name = _display_name(sid)
    if event == "waiting":
        title, body = "⏳ 입력 대기 중", f"{name} — 응답을 기다립니다"
    elif event == "completed":
        title, body = "✅ 작업 완료", f"{name}"
    else:  # stopped
        title, body = "⏹ 세션 종료", f"{name}"
    url = f"/?session={sid}"
    try:
        asyncio.get_running_loop().create_task(notify(title, body, tag=sid, url=url))
    except RuntimeError:
        pass  # no running loop (shouldn't happen from broadcast)


def clear_dedup(sid: str):
    """Reset the dedup latch when a session goes back to working — so the next
    waiting/completed notifies again."""
    _last_state.pop(sid, None)
