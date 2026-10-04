import asyncio

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from .auth import verify
from . import conversations, tmux
from .sessions import store

router = APIRouter(prefix='/api/conversations', dependencies=[Depends(verify)])


async def context(id):
    session = store.get(id)
    if not session:
        raise HTTPException(404, '로컬 터미널 세션을 찾을 수 없습니다.')
    info = await tmux.display_info(session.session_name)
    pid = int(info.get('pid') or 0)
    identity = conversations.process_identity(pid)
    if not identity:
        raise HTTPException(409, '실행 중인 터미널을 확인할 수 없습니다.')
    candidates = await asyncio.to_thread(conversations.inventory, session.cwd)
    generation = await asyncio.to_thread(conversations.agent_generation, pid)
    owner = conversations.bindings.owner(session.session_name, identity + ':' + generation, session.cwd)
    return session, pid, candidates, owner


@router.get('/{id}')
async def read(id: str, before: int | None = Query(None, ge=0), source: str | None = Query(None, max_length=80)):
    session, pid, candidates, owner = await context(id)
    key = conversations.bindings.values.get(owner)
    mode = 'manual' if key else 'automatic'
    if key not in candidates:
        key = await asyncio.to_thread(conversations.exact_candidate, pid, candidates)
        mode = 'automatic'
    if source is not None and source != key:
        raise HTTPException(409, '대화 연결이 변경되었습니다. 다시 불러와 주세요.')
    choices = sorted([{'key': k, 'provider': m['provider'], 'id': m['id'], 'timestamp': m['timestamp']}
                      for k, (_, m) in candidates.items()], key=lambda x: x['timestamp'], reverse=True)
    if not key:
        return {'available': False, 'choices': choices, 'messages': [], 'before': None,
                'reason': '자동으로 확인된 대화가 없습니다. 이 터미널의 대화를 직접 선택해 주세요.'}
    path, meta = candidates[key]
    data = await asyncio.to_thread(conversations.transcript, path, meta['provider'], before)
    return {'available': True, 'source': key, 'binding': mode, 'provider': meta['provider'], 'choices': choices, **data}


class Bind(BaseModel):
    source: str | None = Field(default=None, max_length=80)


@router.put('/{id}')
async def bind(id: str, body: Bind):
    _, _, candidates, owner = await context(id)
    if body.source is not None and body.source not in candidates:
        raise HTTPException(400, '이 워크스페이스에서 확인된 대화만 연결할 수 있습니다.')
    await asyncio.to_thread(conversations.bindings.put, owner, body.source)
    return {'ok': True}
