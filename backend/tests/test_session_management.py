import asyncio
from unittest.mock import AsyncMock

from backend import sessions, routes_session
from backend.sessions import Session, SessionStore
from backend.models import AttachRequest


def test_failed_kill_does_not_report_stopped(monkeypatch):
    store = SessionStore.__new__(SessionStore)
    session = Session(id='1', session_name='fake', cwd='/project', cmd='codex', ai_state='working')
    store.sessions = {'1': session}
    events = []
    store._broadcast = events.append
    monkeypatch.setattr(sessions.tmux, 'kill_session', AsyncMock())
    monkeypatch.setattr(sessions.tmux, 'is_alive', AsyncMock(return_value=True))
    assert asyncio.run(store.kill('1')) is False
    assert session.status == 'running' and session.ai_state == 'working'
    assert not events


def test_duplicate_attach_returns_existing_session(monkeypatch):
    store = SessionStore.__new__(SessionStore)
    session = Session(id='1', session_name='fake', cwd='/project', cmd='codex')
    store.sessions = {'1': session}
    monkeypatch.setattr(routes_session, 'store', store)
    monkeypatch.setattr(routes_session.tmux, 'is_alive', AsyncMock(return_value=True))
    start = AsyncMock()
    monkeypatch.setattr(routes_session.streamer, 'start_stream', start)
    result = asyncio.run(routes_session.attach(AttachRequest(sessionName='fake', cwd='/wrong')))
    assert result == {'ok': True, 'id': '1'}
    assert len(store.sessions) == 1 and session.cwd == '/project'
    start.assert_not_awaited()


def test_remote_replay_keeps_completion_and_activity_metadata(monkeypatch):
    import json
    from types import SimpleNamespace
    from agent import client
    session = Session(id='1', session_name='fake', cwd='/project', cmd='codex',
                      ai_state='idle', completion_id='turn-a', last_activity_at=123,
                      process='codex', auto_title='Research')
    monkeypatch.setattr(client, 'store', SimpleNamespace(all=lambda:[session], titles={}))
    ws = SimpleNamespace(send=AsyncMock())
    asyncio.run(client.AgentClient()._replay(ws))
    events = [json.loads(call.args[0]) for call in ws.send.await_args_list]
    assert next(e for e in events if e['type']=='aiState')['completionId'] == 'turn-a'
    assert next(e for e in events if e['type']=='activity')['lastActivityAt'] == 123
    assert next(e for e in events if e['type']=='info')['autoTitle'] == 'Research'
