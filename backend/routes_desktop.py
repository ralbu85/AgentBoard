"""Authenticated command relay to user-owned desktop browser tabs. No frame stream."""
import asyncio
import re
import uuid
from dataclasses import dataclass, field
from urllib.parse import urlsplit
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ConfigDict, Field

from .auth import verify, verify_ws

router = APIRouter(prefix='/api/desktop')


class Command(BaseModel):
    model_config = ConfigDict(extra='forbid')
    action: Literal['list', 'open', 'navigate', 'back', 'forward', 'reload', 'stop',
                    'close', 'snapshot', 'screenshot', 'click', 'fill', 'key', 'scroll']
    id: str | None = Field(default=None, max_length=108)
    workspace: str | None = Field(default=None, max_length=10000)
    url: str | None = Field(default=None, max_length=8192)
    selector: str | None = Field(default=None, max_length=2048)
    text: str | None = Field(default=None, max_length=100000)
    key: str | None = Field(default=None, max_length=20)
    dy: float | None = Field(default=None, ge=-10000, le=10000)


@dataclass
class Desktop:
    id: str
    name: str
    ws: WebSocket
    tabs: list = field(default_factory=list)
    pending: dict = field(default_factory=dict)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


desktops: dict[str, Desktop] = {}


def same_origin(headers):
    origin = headers.get('origin')
    if not origin:
        return True  # Non-browser agent clients authenticate with the cookie.
    try:
        source = urlsplit(origin)
        target = urlsplit('//'+headers.get('x-forwarded-host', headers.get('host', '')).split(',')[0].strip())
        return source.scheme in ('http', 'https') and source.hostname == target.hostname and (target.port is None or source.port == target.port)
    except ValueError:
        return False


@router.get('/clients')
async def clients(_=Depends(verify)):
    return {'clients': [{'id': d.id, 'name': d.name, 'tabs': d.tabs} for d in desktops.values()]}


@router.post('/clients/{desktop_id}/command')
async def command(desktop_id: str, body: Command, request: Request, _=Depends(verify)):
    if not same_origin(request.headers):
        raise HTTPException(403, '다른 사이트의 제어 요청은 허용하지 않습니다.')
    desktop = desktops.get(desktop_id)
    if not desktop:
        raise HTTPException(404, '데스크톱이 연결되어 있지 않습니다.')
    if len(desktop.pending) >= 8:
        raise HTTPException(429, '진행 중인 브라우저 작업이 많습니다.')
    request_id = str(uuid.uuid4())
    future = asyncio.get_running_loop().create_future()
    desktop.pending[request_id] = future
    try:
        async with desktop.lock:
            await desktop.ws.send_json({'type': 'command', 'id': request_id, 'command': body.model_dump(exclude_none=True)})
        return await asyncio.wait_for(future, 20)
    except asyncio.TimeoutError:
        raise HTTPException(504, '응답 시간이 초과됐습니다. 작업이 이미 실행됐을 수 있으므로 페이지 상태를 확인하세요.')
    except (WebSocketDisconnect, RuntimeError, ConnectionError):
        raise HTTPException(503, '데스크톱 연결이 끊겼습니다.')
    finally:
        desktop.pending.pop(request_id, None)


@router.websocket('/ws')
async def desktop_ws(ws: WebSocket):
    await ws.accept()
    if not verify_ws(ws):
        await ws.close(code=4401)
        return
    if not same_origin(ws.headers):
        await ws.close(code=4403)
        return
    desktop = None
    try:
        hello = await asyncio.wait_for(ws.receive_json(), 15)
        desktop_id = hello.get('id', '')
        if not isinstance(desktop_id, str) or not re.fullmatch(r'[a-zA-Z0-9-]{1,100}', desktop_id):
            await ws.close(code=4400)
            return
        if desktop_id in desktops:
            await ws.close(code=4409)
            return
        desktop = Desktop(desktop_id, str(hello.get('name', 'Desktop'))[:100], ws)
        desktop.tabs = hello.get('tabs', [])[:12] if isinstance(hello.get('tabs'), list) else []
        desktops[desktop.id] = desktop
        while True:
            message = await ws.receive_json()
            if message.get('type') == 'tabs' and isinstance(message.get('tabs'), list):
                desktop.tabs = message['tabs'][:12]
            elif message.get('type') == 'result':
                future = desktop.pending.get(message.get('id'))
                if future and not future.done():
                    if message.get('error'):
                        future.set_exception(HTTPException(409, str(message['error'])[:500]))
                    else:
                        future.set_result({'result': message.get('result')})
    except (WebSocketDisconnect, asyncio.TimeoutError, ValueError, TypeError):
        pass
    finally:
        if desktop and desktops.get(desktop.id) is desktop:
            desktops.pop(desktop.id, None)
            for future in desktop.pending.values():
                if not future.done():
                    future.set_exception(ConnectionError('Desktop disconnected'))
        try:
            await ws.close()
        except RuntimeError:
            pass
