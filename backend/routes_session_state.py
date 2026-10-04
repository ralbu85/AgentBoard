"""Authenticated status reconciliation and exact-event acknowledgement."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from .routes_notebook import authorize
from . import session_state

router = APIRouter(prefix='/api/session-state', dependencies=[Depends(authorize)])


class Receipt(BaseModel):
    id: str = Field(min_length=1, max_length=256)
    event: str = Field(min_length=1, max_length=128)


@router.get('')
async def get_state():
    try:
        return session_state.snapshot()
    except (OSError, ValueError) as exc:
        raise HTTPException(503, '공유 세션 상태를 읽지 못했습니다.') from exc


@router.post('/acknowledge')
async def acknowledge(body: Receipt):
    try:
        result = session_state.state.acknowledge(session_state.sessions(), body.id, body.event)
    except (OSError, ValueError) as exc:
        raise HTTPException(503, '완료 확인을 저장하지 못했습니다. 다시 시도해 주세요.') from exc
    from .ws import broadcast
    broadcast(result)
    return result
