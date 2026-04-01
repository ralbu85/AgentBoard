from fastapi import Request, HTTPException

from . import config


def verify(request: Request):
    token = request.cookies.get("token", "")
    if token != config.AUTH_TOKEN:
        raise HTTPException(status_code=401, detail="Unauthorized")
