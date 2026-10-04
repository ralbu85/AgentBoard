"""Shared session-tab visibility and ordering, independent of terminal processes."""
import json
import os
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from typing import Literal
from . import config
from .routes_notebook import authorize

router = APIRouter(prefix='/api/session-view', dependencies=[Depends(authorize)])
STATE_FILE = config.STATE_DIR / '.session-view.json'


def read_state():
    if not STATE_FILE.exists():
        return {'revision': 0, 'visibility': {}, 'orders': {}}
    try:
        return json.loads(STATE_FILE.read_text())
    except (ValueError, OSError) as exc:
        raise HTTPException(503, '세션 탭 설정을 읽을 수 없습니다.') from exc


class Change(BaseModel):
    action: Literal['visibility', 'order', 'seed']
    key: str = Field(default='', max_length=8192)
    hidden: bool = False
    items: list[str] = Field(default_factory=list, max_length=2000)


@router.get('')
async def get_state():
    from .sessions import store
    from .agents import registry
    retire_ended([s.to_dict() for s in store.all()] + registry.mirror())
    return read_state()


@router.post('')
async def change(body: Change):
    if any(len(item) > 8192 for item in body.items):
        raise HTTPException(400, '세션 설정이 너무 큽니다.')
    # No await between read and atomic replace: operations from two browsers
    # merge into the latest state instead of overwriting unrelated sessions.
    state = read_state()
    if body.action == 'visibility':
        state['visibility'][body.key] = body.hidden
    elif body.action == 'order':
        state['orders'][body.key] = list(dict.fromkeys(body.items))
    else:
        for key in body.items:
            state['visibility'].setdefault(key, True)
    return commit(state)


def commit(state):
    state['revision'] += 1
    temporary = STATE_FILE.with_suffix('.tmp')
    temporary.write_text(json.dumps(state))
    os.replace(temporary, STATE_FILE)
    from .ws import broadcast
    broadcast({'type': 'session-view', **state})
    return state


def retire_ended(sessions):
    ended = [s for s in sessions if s.get('status') in ('stopped', 'completed') and s.get('online', True)]
    if not ended:
        return
    state = read_state()
    retired = state.setdefault('retired', [])
    changed = False
    for session in ended:
        key = json.dumps([session.get('host') or 'local', session.get('sessionName') or session['id'], session.get('cwd') or '~'], ensure_ascii=False, separators=(',', ':'))
        # A user may deliberately reopen a terminated session to inspect its
        # output. Clean each incarnation once, not on every poll/reconnect.
        marker = json.dumps([key, session.get('createdAt', 0)], ensure_ascii=False, separators=(',', ':'))
        if marker not in retired:
            retired.append(marker)
            state['visibility'][key] = True
            changed = True
    if changed:
        commit(state)
