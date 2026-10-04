import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend import config, session_state, routes_session_state, ws
from backend.agents import AgentRegistry
from backend.session_state import SessionState


def session(**kwargs):
    return dict(id='1', host='local', sessionName='term-1', createdAt=123,
                cwd='/project', status='running', aiState='idle', completionId='turn-a', **kwargs)


def test_receipts_persist_across_devices_cwd_id_changes_and_restart(tmp_path):
    path = tmp_path / 'state.json'
    state = SessionState(path)
    records = [session()]
    desktop = state.snapshot(records)
    phone = state.snapshot(records)
    assert desktop == phone and phone['sessions'][0]['completionUnread']
    event = phone['sessions'][0]['completionEvent']
    acknowledged = state.acknowledge(records, '1', event)
    assert not acknowledged['sessions'][0]['completionUnread']
    assert acknowledged['revision'] > desktop['revision']
    assert state.acknowledge(records, '1', event) == acknowledged
    # Hub recovery has no live completionId yet; its persisted receipt survives.
    recovered = [{**records[0], 'id': '9', 'cwd': '/another', 'completionId': ''}]
    restarted = SessionState(path).snapshot(recovered)
    assert restarted['sessions'][0]['completionEvent'] == event
    assert not restarted['sessions'][0]['completionUnread']
    assert path.stat().st_mode & 0o777 == 0o600
    assert 'turn-a' not in path.read_text() and '/project' not in path.read_text()


def test_stale_ack_and_replayed_completion_cannot_clear_or_resurrect_results(tmp_path):
    state = SessionState(tmp_path / 'state.json')
    first = session()
    old = state.snapshot([first])['sessions'][0]['completionEvent']
    newer = {**first, 'completionId': 'turn-b'}
    new = state.snapshot([newer])['sessions'][0]['completionEvent']
    assert new != old
    assert state.acknowledge([newer], '1', old)['sessions'][0]['completionUnread']
    state.acknowledge([newer], '1', new)
    for source in [first, newer, {**newer, 'aiState': 'working'}, {**first, 'aiState': 'idle'}]:
        result = state.snapshot([source])['sessions'][0]
        assert not result['completionUnread'] and result['completionEvent'] == new
    assert state.snapshot([{**newer, 'completionId': 'turn-c'}])['sessions'][0]['completionUnread']


def test_identity_is_scoped_to_host_and_incarnation_not_numeric_id(tmp_path):
    state = SessionState(tmp_path / 'state.json')
    local = session()
    remote = {**local, 'host': 'office', 'id': 'office:1'}
    result = state.snapshot([local, remote])
    a, b = result['sessions']
    assert a['completionEvent'] != b['completionEvent']
    state.acknowledge([local, remote], '1', a['completionEvent'])
    result = state.snapshot([{**local, 'createdAt': 456}, remote])
    assert all(s['completionUnread'] for s in result['sessions'])
    stale = state.acknowledge([{**local, 'createdAt': 456}, remote], '1', a['completionEvent'])
    assert stale['sessions'][0]['completionUnread']


def test_unknown_incarnation_and_disconnect_do_not_synthesize_completion(tmp_path):
    state = SessionState(tmp_path / 'state.json')
    assert not state.snapshot([{**session(), 'createdAt': 0}])['sessions'][0]['completionUnread']
    assert not state.snapshot([{**session(), 'online': False}])['sessions'][0]['completionUnread']
    idle = {**session(), 'completionId': ''}
    assert not state.snapshot([idle])['sessions'][0]['completionUnread']
    ended = {**idle, 'status': 'completed'}
    event = state.snapshot([ended])['sessions'][0]['completionEvent']
    state.acknowledge([ended], '1', event)
    assert not state.snapshot([ended])['sessions'][0]['completionUnread']


def test_corrupt_or_failed_receipt_storage_does_not_report_success(tmp_path, monkeypatch):
    path = tmp_path / 'state.json'
    path.write_text('broken')
    with pytest.raises(ValueError):
        SessionState(path).snapshot([session()])
    path.unlink()
    state = SessionState(path)
    records = [session()]
    event = state.snapshot(records)['sessions'][0]['completionEvent']
    def failed(*args):
        raise OSError('simulated storage failure')
    monkeypatch.setattr(state, '_save', failed)
    with pytest.raises(OSError):
        state.acknowledge(records, '1', event)
    assert state.snapshot(records)['sessions'][0]['completionUnread']


def test_two_authenticated_clients_share_receipts_and_both_receive_broadcast(monkeypatch):
    from backend.security_audit import AuditMiddleware, audit
    monkeypatch.setattr(audit, 'write', lambda *args, **kwargs: None)
    records = [session()]
    monkeypatch.setattr(session_state, 'sessions', lambda: records)
    events = []
    monkeypatch.setattr(ws, 'broadcast', events.append)
    app = FastAPI()
    app.add_middleware(AuditMiddleware)
    app.include_router(routes_session_state.router)
    with TestClient(app) as phone, TestClient(app) as desktop:
        assert phone.get('/api/session-state').status_code == 401
        for client in (phone, desktop):
            client.cookies.set('token', config.AUTH_TOKEN)
        initial = desktop.get('/api/session-state')
        assert initial.headers['cache-control'] == 'no-store'
        before = initial.json()
        receipt = {'id': '1', 'event': before['sessions'][0]['completionEvent']}
        assert phone.post('/api/session-state/acknowledge', json=receipt, headers={'origin': 'https://foreign.test'}).status_code == 403
        response = phone.post('/api/session-state/acknowledge', json=receipt)
        assert response.headers['cache-control'] == 'no-store'
        done = response.json()
        assert not done['sessions'][0]['completionUnread']
        assert desktop.get('/api/session-state').json() == done == events[-1]
        records[0]['completionId'] = 'turn-b'
        assert phone.post('/api/session-state/acknowledge', json=receipt).json()['sessions'][0]['completionUnread']


def test_broadcast_and_resume_deliver_authoritative_state_to_all_viewers(monkeypatch):
    records = [session()]
    monkeypatch.setattr(session_state, 'sessions', lambda: records)
    monkeypatch.setattr(ws.push, 'maybe_push', lambda msg: None)
    async def scenario():
        class Socket:
            client_state = SimpleNamespace(name='CONNECTED')
            send_text = None
            def __init__(self):
                self.send_text = AsyncMock()
        one, two = Socket(), Socket()
        monkeypatch.setattr(ws, 'clients', {one, two})
        ws.broadcast({'type': 'aiState', 'id': '1', 'state': 'idle', 'completionId': 'turn-a'})
        await asyncio.sleep(0)
        a = json.loads(one.send_text.call_args.args[0])
        b = json.loads(two.send_text.call_args.args[0])
        assert a == b and a['type'] == 'session-state'
        from backend import routes_session_view
        monkeypatch.setattr(routes_session_view, 'get_state', AsyncMock(return_value={'revision': 1, 'visibility': {}, 'orders': {}}))
        one.send_text.reset_mock()
        await ws._handle_msg({'type': 'session-sync'}, one)
        assert json.loads(one.send_text.call_args_list[0].args[0]) == a
        assert json.loads(one.send_text.call_args_list[1].args[0])['type'] == 'session-view'
    asyncio.run(scenario())


def test_remote_offline_inventory_is_identical_for_new_and_existing_devices(tmp_path):
    registry = AgentRegistry()
    conn = registry.register('office', 'Office', None)
    conn.update_from({'type': 'session-inventory', 'sessions': [session()]})
    state = SessionState(tmp_path / 'state.json')
    initial = state.snapshot(registry.mirror())
    event = initial['sessions'][0]['completionEvent']
    registry.unregister('office')
    disconnected = state.snapshot(registry.mirror())
    assert disconnected['sessions'][0]['online'] is False
    assert disconnected['sessions'][0]['aiState'] == 'idle'
    assert disconnected['sessions'][0]['completionEvent'] == event
    state.acknowledge(registry.mirror(), 'office:1', event)
    conn = registry.register('office', 'Office', None)
    conn.update_from({'type': 'session-inventory', 'sessions': [session()]})
    assert not state.snapshot(registry.mirror())['sessions'][0]['completionUnread']
    conn.update_from({'type': 'session-inventory', 'sessions': []})
    assert state.snapshot(registry.mirror())['sessions'] == []
