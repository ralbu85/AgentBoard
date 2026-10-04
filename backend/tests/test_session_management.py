import asyncio
from unittest.mock import AsyncMock

from backend import sessions, routes_session
from backend.sessions import Session, SessionStore
from backend.models import AttachRequest


def test_recovery_preserves_running_pane_dimensions_without_resizing(tmp_path, monkeypatch):
    monkeypatch.setattr(sessions.config, 'TITLES_FILE', tmp_path / 'titles.json')
    store = SessionStore()
    monkeypatch.setattr(sessions.tmux, 'apply_global_options', AsyncMock())
    monkeypatch.setattr(sessions.tmux, 'list_sessions', AsyncMock(return_value=[
        {'sessionName':'term-7', 'cwd':'/project'},
        {'sessionName':'external', 'cwd':'/other'},
        {'sessionName':'term-8', 'cwd':'/unknown'},
    ]))
    monkeypatch.setattr(sessions.tmux, 'pane_size', AsyncMock(side_effect=[(163,40),(120,50),None]))
    resize = AsyncMock()
    monkeypatch.setattr(sessions.tmux, 'resize_window', resize)
    asyncio.run(store.recover())
    resize.assert_not_awaited()
    assert (store.get('7').display_cols, store.get('7').display_rows) == (163,40)
    external = next(s for s in store.all() if s.session_name == 'external')
    assert (external.display_cols, external.display_rows) == (120,50)
    assert not store.get('8').geometry_verified


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


def test_saved_titles_are_bound_to_session_incarnation(tmp_path, monkeypatch):
    import json
    path = tmp_path / 'titles.json'
    path.write_text(json.dumps({'12':'Old unrelated title'}))
    monkeypatch.setattr(sessions.config, 'TITLES_FILE', path)
    store = SessionStore()
    session = Session(id='12', session_name='term-12', cwd='/project', cmd='codex', created_at=100)
    store.sessions['12'] = session
    assert store.titles['12'] == ''
    assert store._titles['12'] == 'Old unrelated title'
    store.set_title('12', 'My deliberate title')
    restored = SessionStore()
    restored.sessions['12'] = session
    assert restored.titles['12'] == 'My deliberate title'
    session.created_at = 200
    assert restored.titles['12'] == ''
    restored.set_title('12', 'New session title')
    assert restored.titles['12'] == 'New session title'
    restored.set_title('12', '')
    assert restored.titles['12'] == ''
