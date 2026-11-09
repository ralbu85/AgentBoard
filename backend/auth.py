import hmac
from urllib.parse import urlsplit

from fastapi import Request, HTTPException, WebSocket
from fastapi.responses import JSONResponse
from starlette.datastructures import Headers

from . import config
from .logger import log


def verify(request: Request):
    token = request.cookies.get("token", "")
    if not hmac.compare_digest(token, config.AUTH_TOKEN):
        raise HTTPException(status_code=401, detail="Unauthorized")


def verify_ws(ws: WebSocket) -> bool:
    return hmac.compare_digest(ws.cookies.get("token", ""), config.AUTH_TOKEN)


def same_origin(headers) -> bool:
    origin = headers.get('origin')
    if not origin:
        return True  # Non-browser agent clients authenticate with the cookie.
    try:
        source = urlsplit(origin)
        target = urlsplit('//'+headers.get('x-forwarded-host', headers.get('host', '')).split(',')[0].strip())
        return source.scheme in ('http', 'https') and source.hostname == target.hostname and (target.port is None or source.port == target.port)
    except ValueError:
        return False


def foreign_request(headers) -> bool:
    """A browser request another page started. Same-site counts as foreign:
    every *.<tailnet>.ts.net node is one site, so the SameSite=Lax cookie rides
    along from any page served there (a course site, a board)."""
    site = headers.get('sec-fetch-site')
    if site:
        return site not in ('same-origin', 'none')
    return not same_origin(headers)   # browsers without Fetch Metadata, and the desktop relay


class OriginGuard:
    """Refuse state-changing requests and WebSockets that another page started:
    the cookie alone would let it type into a terminal or write a file."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        kind = scope['type']
        unsafe = kind == 'websocket' or kind == 'http' and scope.get('method') not in ('GET', 'HEAD', 'OPTIONS')
        if not unsafe or not foreign_request(Headers(scope=scope)):
            return await self.app(scope, receive, send)
        log.warning('refused a %s %s started by another site', scope.get('method', 'WS'), scope.get('path', ''))
        if kind == 'websocket':
            return await send({'type': 'websocket.close', 'code': 4403})
        await JSONResponse({'ok': False, 'error': '다른 사이트에서 보낸 요청은 받지 않습니다.'}, 403)(scope, receive, send)
