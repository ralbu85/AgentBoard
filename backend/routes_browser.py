import asyncio
import json
import os
import shutil
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse

from .auth import verify, verify_ws
from .browser import manager, MAX_TABS, browser_memory_mb
from .routes_file import _safe_path

router=APIRouter(prefix='/api/browser')


def get_tab(tab_id):
    tab=manager.tabs.get(tab_id)
    if not tab:raise HTTPException(404,'종료된 웹 탭입니다.')
    return tab


@router.get('/tabs')
async def tabs(_=Depends(verify)):
    return {'limit':MAX_TABS,'memoryMB':await asyncio.to_thread(browser_memory_mb),'tabs':[{'id':t.id,'workspace':t.workspace,'url':t.page.url,'title':t.metadata.get('title',''),'viewers':len(t.clients)} for t in list(manager.tabs.values())]}


@router.delete('/tabs/{tab_id}')
async def close(tab_id:str,_=Depends(verify)):
    await manager.close(tab_id)
    return {'ok':True}


@router.get('/tabs/{tab_id}/downloads/{download_id}')
async def download(tab_id:str,download_id:str,_=Depends(verify)):
    tab=get_tab(tab_id)
    item=next((d for d in tab.downloads if d['id']==download_id),None)
    if not item:raise HTTPException(404,'다운로드를 찾을 수 없습니다.')
    return FileResponse(item['path'],filename=item['name'],media_type='application/octet-stream')


@router.post('/tabs/{tab_id}/downloads/{download_id}/save')
async def save_download(tab_id:str,download_id:str,_=Depends(verify)):
    tab=get_tab(tab_id)
    item=next((d for d in tab.downloads if d['id']==download_id),None)
    if not item:raise HTTPException(404,'다운로드를 찾을 수 없습니다.')
    host,cwd=json.loads(tab.workspace)
    if host!='local':raise HTTPException(400,'원격 워크스페이스는 기기에 저장을 이용해 주세요.')
    folder=_safe_path(str(Path(cwd).expanduser()/'browser-downloads'))
    if folder is None:raise HTTPException(403,'저장할 수 없는 워크스페이스입니다.')
    folder.mkdir(parents=True,exist_ok=True)
    destination=_safe_path(str(folder/(os.urandom(4).hex()+'-'+item['name'])))
    if destination is None:raise HTTPException(403,'허용되지 않은 경로입니다.')
    def copy():
        with open(item['path'],'rb') as source, destination.open('xb') as target:
            shutil.copyfileobj(source,target)
    await asyncio.to_thread(copy)
    return {'ok':True,'path':str(destination)}


@router.post('/tabs/{tab_id}/upload')
async def upload(tab_id:str,files:list[UploadFile]=File(...),_=Depends(verify)):
    tab=get_tab(tab_id)
    if not tab.chooser:raise HTTPException(409,'웹 페이지의 파일 선택 버튼을 먼저 눌러 주세요.')
    buffers=[]
    total=0
    try:
        for file in files:
            content=await file.read(25*1024*1024+1-total)
            total+=len(content)
            if total>25*1024*1024:raise HTTPException(413,'업로드는 합계 25MB까지 지원합니다.')
            buffers.append({'name':Path((file.filename or 'upload').replace('\\','/')).name,'mimeType':file.content_type or 'application/octet-stream','buffer':content})
        chooser=tab.chooser
        await chooser.set_files(buffers)
        tab.chooser=None
        return {'ok':True}
    finally:
        for file in files:await file.close()


async def browser_ws(ws:WebSocket):
    # Cookie authentication plus Origin check prevent another site from opening
    # an authenticated remote-control socket using the user's browser cookies.
    await ws.accept()
    if not verify_ws(ws):await ws.close(code=4401);return
    origin=ws.headers.get('origin')
    if origin:
        remote=urlsplit(origin)
        # Reverse proxies often forward $host without the external port.
        target=urlsplit('//'+ws.headers.get('x-forwarded-host',ws.headers.get('host','')).split(',')[0].strip())
        if remote.scheme not in ('http','https') or remote.hostname!=target.hostname or (target.port is not None and remote.port!=target.port):
            await ws.close(code=4403);return
    tab=None
    sender=None
    send_lock=asyncio.Lock()
    async def send_json(data):
        async with send_lock:await ws.send_json(data)
    try:
        init=await asyncio.wait_for(ws.receive_json(),15)
        tab=await manager.open(init.get('id',''),init.get('workspace',''),init.get('url',''))
        tab.clients.add(ws)
        await tab.casting_enabled(True)
        async def frames():
            seq=-1
            last_state=''
            while not tab.closed:
                if tab.frame_no!=seq and tab.frame:
                    seq=tab.frame_no
                    async with send_lock:await ws.send_bytes(tab.frame)
                state=await tab.status()
                # Never expose filesystem paths in the browser's download list.
                state['downloads']=[{k:v for k,v in d.items() if k!='path'} for d in state['downloads']]
                encoded=json.dumps(state)
                if encoded!=last_state:
                    await send_json(state);last_state=encoded
                await asyncio.sleep(.2)
            await send_json({'type':'closed'})
            await ws.close(code=1000)
        async def produce():
            try:await frames()
            except asyncio.CancelledError:raise
            except Exception:
                try:
                    await send_json({'type':'error','message':'화면 연결이 끊겼습니다. 다시 연결합니다.'})
                    await ws.close(code=1011)
                except Exception:pass
        sender=asyncio.create_task(produce())
        while not tab.closed:
            data=await ws.receive_json()
            try:
                result=await tab.command(data)
                if result:await send_json(result)
                if data.get('ack'):await send_json({'type':'ack','action':data.get('action')})
            except Exception as exc:
                await send_json({'type':'error','message':str(exc)[:250] if isinstance(exc,ValueError) else '브라우저 작업을 완료하지 못했습니다. 페이지 상태를 확인해 주세요.'})
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    except Exception as exc:
        try:await send_json({'type':'error','message':str(exc)[:250] if isinstance(exc,ValueError) else 'Chromium에 연결하지 못했습니다. 다시 연결해 주세요.'})
        except Exception:pass
    finally:
        if sender:
            sender.cancel()
            await asyncio.gather(sender,return_exceptions=True)
        if tab:
            tab.clients.discard(ws)
            if not tab.clients and not tab.closed:
                try:await tab.casting_enabled(False)
                except Exception:pass
            if not tab.closed:
                try:await asyncio.wait_for(manager.save_profile(tab.workspace),5)
                except Exception:pass
        else:
            await manager.release_empty()
        try:await ws.close()
        except Exception:pass


router.add_api_websocket_route('/ws',browser_ws)
