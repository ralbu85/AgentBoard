import hmac

from fastapi import Request, HTTPException, WebSocket

from . import config


def verify(request: Request):
    token = request.cookies.get("token", "")
    if not hmac.compare_digest(token, config.AUTH_TOKEN):
        raise HTTPException(status_code=401, detail="Unauthorized")


def verify_ws(ws: WebSocket) -> bool:
    return hmac.compare_digest(ws.cookies.get("token", ""), config.AUTH_TOKEN)
