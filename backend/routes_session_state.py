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
        session_state.state.acknowledge(session_state.sessions(), body.id, body.event)
        result = session_state.snapshot()
    except (OSError, ValueError) as exc:
        raise HTTPException(503, '완료 확인을 저장하지 못했습니다. 다시 시도해 주세요.') from exc
    from .ws import broadcast
    broadcast(result)
    return result


class WorkTitle(BaseModel):
    id: str = Field(min_length=1, max_length=128)
    title: str = Field(min_length=1, max_length=120)


@router.post('/recent-work/title')
async def rename_work(body: WorkTitle):
    from . import recent_work
    try:
        recent_work.state.rename(body.id, body.title)
        result = session_state.snapshot()
    except KeyError as exc:
        raise HTTPException(404, '최근 작업 목록이 바뀌었습니다. 다시 확인해 주세요.') from exc
    except ValueError as exc:
        raise HTTPException(400, '작업명을 저장하지 못했습니다.') from exc
    except OSError as exc:
        raise HTTPException(503, '최근 작업 기록을 저장하지 못했습니다.') from exc
    from .ws import broadcast
    broadcast(result)
    return result
