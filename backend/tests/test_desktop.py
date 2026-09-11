import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException, WebSocketDisconnect
from pydantic import ValidationError

from backend import config, routes_desktop as relay


def test_desktop_auth_and_origin(monkeypatch):
    monkeypatch.setattr(config, 'AUTH_TOKEN', 'fixture')
    async def run():
        for cookies, origin, code in [({}, None, 4401), ({'token': 'fixture'}, 'https://foreign.test', 4403)]:
            ws = SimpleNamespace(cookies=cookies, headers={'host': 'app.test', **({'origin': origin} if origin else {})}, accept=AsyncMock(), close=AsyncMock())
            await relay.desktop_ws(ws)
            ws.close.assert_awaited_once_with(code=code)
    asyncio.run(run())
    assert relay.same_origin({'host': 'app.test:3002', 'origin': 'http://app.test:3002'})
    assert not relay.same_origin({'host': 'app.test:3002', 'origin': 'http://app.test:3003'})


def test_only_browser_commands_and_bounded_payloads():
    for payload in [{'action': 'evaluate', 'text': 'process.exit()'}, {'action': 'fill', 'text': 'x'*100001}, {'action': 'click', 'path': '/etc/passwd'}, {'action': 'scroll', 'dy': float('inf')}]:
        with pytest.raises(ValidationError):
            relay.Command(**payload)


def test_relay_routes_response_to_request_and_cleans_disconnect(monkeypatch):
    monkeypatch.setattr(config, 'AUTH_TOKEN', 'fixture')
    monkeypatch.setattr(relay, 'desktops', {})
    async def run():
        inbound = asyncio.Queue()
        outbound = asyncio.Queue()
        async def receive():
            value = await inbound.get()
            if isinstance(value, Exception):
                raise value
            return value
        ws = SimpleNamespace(cookies={'token': 'fixture'}, headers={}, accept=AsyncMock(), close=AsyncMock(), receive_json=receive, send_json=outbound.put)
        await inbound.put({'id': 'desktop-one', 'name': 'Fixture', 'tabs': []})
        serving = asyncio.create_task(relay.desktop_ws(ws))
        while 'desktop-one' not in relay.desktops:
            await asyncio.sleep(0)
        task = asyncio.create_task(relay.command('desktop-one', relay.Command(action='snapshot', id='browser:one'), SimpleNamespace(headers={})))
        request = await outbound.get()
        assert request['command'] == {'action': 'snapshot', 'id': 'browser:one'}
        await inbound.put({'type': 'result', 'id': 'wrong-request', 'result': 'wrong'})
        await inbound.put({'type': 'result', 'id': request['id'], 'result': {'title': 'correct'}})
        assert await task == {'result': {'title': 'correct'}}
        assert not relay.desktops['desktop-one'].pending
        task = asyncio.create_task(relay.command('desktop-one', relay.Command(action='list'), SimpleNamespace(headers={})))
        await outbound.get()
        await inbound.put(WebSocketDisconnect())
        with pytest.raises(HTTPException) as exc:
            await task
        assert exc.value.status_code == 503
        await serving
        assert not relay.desktops
    asyncio.run(run())


def test_command_rejects_foreign_origin_and_offline_desktop():
    async def run():
        for headers, status in [({'host': 'app.test', 'origin': 'https://other.test'}, 403), ({}, 404)]:
            with pytest.raises(HTTPException) as exc:
                await relay.command('not-connected', relay.Command(action='list'), SimpleNamespace(headers=headers))
            assert exc.value.status_code == status
    asyncio.run(run())
