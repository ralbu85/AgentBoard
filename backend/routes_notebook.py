from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, ConfigDict

from .auth import verify
from .routes_desktop import same_origin
from .notebooks import manager, MAX_KERNELS


def authorize(request: Request):
    verify(request)
    if not same_origin(request.headers):
        raise HTTPException(403, '다른 사이트의 노트북 제어 요청은 허용하지 않습니다.')


router = APIRouter(prefix='/api/notebooks', dependencies=[Depends(authorize)])


class Open(BaseModel):
    path: str = Field(max_length=4096)


class Update(BaseModel):
    model_config = ConfigDict(extra='forbid')
    revision: int
    content: str = Field(max_length=10*1024*1024)


class Action(BaseModel):
    model_config = ConfigDict(extra='forbid')
    action: Literal['connect', 'execute', 'run-all', 'interrupt', 'restart', 'shutdown', 'save', 'reload', 'select-environment']
    revision: int
    cell: int | None = None
    environment: str | None = None


@router.post('/open')
async def open_notebook(body: Open):
    return manager.open(body.path).snapshot()


@router.get('')
async def list_notebooks():
    return {'limit': MAX_KERNELS, 'sessions': [
        {key: value for key, value in d.snapshot().items() if key != 'content'}
        for d in manager.documents.values()
    ]}


@router.get('/{key}/environments')
async def environments(key: str):
    import asyncio
    document = manager.get(key)
    return {'folder': str(document.path.parent), 'selected': document.environment, 'environments': await asyncio.to_thread(document.environments)}


@router.get('/{key}')
async def state(key: str, since: int = Query(-1)):
    document = manager.get(key)
    if document.km and not document.busy and not await document.km.is_alive():
        async with document.lock:
            if document.km and not document.busy and not await document.km.is_alive():
                await document.shutdown()
                document.error = '커널이 종료되었습니다. 다시 연결한 뒤 필요한 셀을 실행하세요.'
                document.touch()
    if since == document.revision:
        return {'unchanged': True}
    return document.snapshot()


@router.put('/{key}')
async def update(key: str, body: Update):
    document = manager.get(key)
    async with document.lock:
        document.update(body.content, body.revision)
        return document.snapshot()


@router.post('/{key}/action')
async def action(key: str, body: Action):
    document = manager.get(key)
    async with document.lock:
        # Interrupt/stop are intentionally available with an older poll revision.
        if body.action not in ('interrupt', 'shutdown'):
            document.check_revision(body.revision)
        if body.action == 'interrupt':
            await document.interrupt()
        elif body.action == 'shutdown':
            await document.shutdown()
        elif body.action == 'select-environment':
            document.select_environment(body.environment)
        elif body.action == 'save':
            document.save(body.revision)
        elif body.action == 'reload':
            if document.busy:
                raise HTTPException(409, '실행을 중단한 뒤 원본을 다시 여세요.')
            await document.shutdown()
            from .notebooks import checked_path, parse, version
            raw = checked_path(str(document.path)).read_bytes()
            document.notebook = parse(raw.decode())
            document.file_version = version(raw)
            document.dirty = False
            document.error = ''
            document.touch(checkpoint=True)
        else:
            if document.busy:
                raise HTTPException(409, '이미 실행·연결 중입니다.')
            indices = [body.cell] if body.action == 'execute' else [i for i, cell in enumerate(document.notebook['cells']) if cell['cell_type'] == 'code']
            if body.action in ('execute', 'run-all'):
                document.validate_indices(indices)
            if body.action == 'restart':
                await document.shutdown()
            await manager.start(document)
            if body.action in ('execute', 'run-all'):
                document.schedule(indices)
        return document.snapshot()
