"""Isolated desktop UI fixture. Never starts tmux or imports the production app."""
from pathlib import Path

from fastapi import FastAPI, WebSocket
from fastapi.responses import FileResponse, HTMLResponse

from backend import config
from backend.routes_desktop import router

config.AUTH_TOKEN = 'fixture-token'
app = FastAPI()
app.include_router(router)
root = '/tmp/agentboard-desktop-fixture'
sessions = [dict(id=str(i), sessionName='fixture-'+str(i), cwd=root+'/'+str(i), host='local', cmd='codex',
                 autoTitle='작업 '+str(i), status='running', aiState='idle', createdAt=1, memKB=0, process='codex') for i in (1, 2)]


@app.get('/api/workers')
def workers():
    return sessions


@app.get('/api/profiles')
def profiles():
    return {'profiles': []}


@app.get('/api/files')
def files():
    return {'entries': []}


@app.get('/api/hosts')
def hosts():
    return []


@app.get('/api/push/key')
def push():
    return {'enabled': False}


@app.websocket('/ws')
async def ws(ws: WebSocket):
    await ws.accept()
    await ws.send_json({'type': 'sessions', 'sessions': sessions})
    try:
        while True:
            message = await ws.receive_json()
            if message.get('type') in ('active', 'resync'):
                await ws.send_json({'type': 'snapshot', 'id': message.get('id'), 'data': 'fixture terminal'})
    except Exception:
        pass


@app.get('/fixture/{name}')
def fixture(name: str):
    return HTMLResponse('<title>'+name+'</title><h1>'+name+'</h1><input id="text"><a id="next" href="/fixture/next">Next</a><div style="height:2000px">scroll</div>', headers={'X-Frame-Options': 'DENY'})


@app.get('/{path:path}')
def static(path: str):
    base = Path(__file__).resolve().parents[2]/'frontend'/'dist'
    target = (base/path).resolve()
    if target.is_relative_to(base) and target.is_file():
        return FileResponse(target)
    return FileResponse(base/'index.html')
