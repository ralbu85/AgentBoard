from fastapi import FastAPI, WebSocket
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
import pytest

from backend.auth import OriginGuard, foreign_request


def app():
    app = FastAPI()
    app.add_middleware(OriginGuard)
    @app.post('/api/input')
    def input(): return {'ok': True}
    @app.get('/api/file')
    def read(): return {'ok': True}
    @app.websocket('/ws')
    async def ws(socket: WebSocket):
        await socket.accept(); await socket.send_text('hi'); await socket.close()
    return TestClient(app, base_url='https://agent.tail.ts.net')


def test_another_site_cannot_type_into_a_terminal():
    client = app()
    # A course site on the same tailnet is the same site: the cookie would ride along.
    for headers in [{'sec-fetch-site': 'same-site', 'origin': 'https://dllecture.tail.ts.net'},
                    {'sec-fetch-site': 'cross-site', 'origin': 'https://evil.test'},
                    {'origin': 'https://dllecture.tail.ts.net'},   # no Fetch Metadata
                    {'origin': 'null'}]:                           # a sandboxed preview
        assert client.post('/api/input', headers=headers).status_code == 403
        with pytest.raises(WebSocketDisconnect) as refused:
            with client.websocket_connect('wss://agent.tail.ts.net/ws', headers=headers): pass
        assert refused.value.code == 4403
    # Reading stays open: another site can't read the response anyway (no CORS).
    assert client.get('/api/file', headers={'sec-fetch-site': 'cross-site'}).status_code == 200


def test_the_app_its_desktop_relay_and_agents_still_get_in():
    client = app()
    for headers in [{'sec-fetch-site': 'same-origin', 'origin': 'https://agent.tail.ts.net'},
                    {'origin': 'https://agent.tail.ts.net'},   # the desktop relay (Node): Origin, no Fetch Metadata
                    {}]:                                       # remote agents and CLI tools: no Origin
        assert client.post('/api/input', headers=headers).status_code == 200
        with client.websocket_connect('wss://agent.tail.ts.net/ws', headers=headers) as socket:
            assert socket.receive_text() == 'hi'


def test_a_proxy_that_forwards_the_host():
    assert not foreign_request({'origin': 'https://agent.tail.ts.net', 'host': '127.0.0.1:3002', 'x-forwarded-host': 'agent.tail.ts.net'})
    assert foreign_request({'origin': 'https://agent.tail.ts.net:8443', 'host': 'agent.tail.ts.net:443'})
