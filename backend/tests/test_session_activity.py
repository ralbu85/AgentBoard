import asyncio
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend import config, routes_session, routes_session_state, session_activity, session_state, ws
from backend.models import InputRequest
from backend.session_activity import SessionActivity, workspace_key


def session(**changes):
    return {'id': '1', 'sessionName': 'pane', 'host': 'local', 'createdAt': 10,
            'cwd': '/project', 'status': 'running', 'aiState': 'idle',
            'autoTitle': 'Old task', **changes}


def test_latest_titles_survive_more_than_five_requests_restart_and_numeric_id_changes(tmp_path):
    path = tmp_path / 'activity.json'
    state = SessionActivity(path)
    sources = [session(id=str(i), sessionName=f'pane-{i}') for i in range(8)]
    for i, source in enumerate(sources):
        state.submitted(source, f'최신 요청 {i}\n본문은 저장하지 않음', 100+i)
    state = SessionActivity(path)
    result = state.sync([{**s, 'id': f'new-{s["id"]}'} for s in sources])
    assert [s['requestTitle'] for s in result['sessions']] == [f'최신 요청 {i}' for i in range(8)]
    assert path.stat().st_mode & 0o777 == 0o600
    assert '본문은 저장하지 않음' not in path.read_text()
    # A different process reusing the numeric ID never inherits its title.
    assert state.sync([session(id='0', sessionName='pane-0', createdAt=99)])['sessions'][0]['requestTitle'] == ''


def test_only_requests_and_new_completions_advance_workspace_recency(tmp_path):
    state = SessionActivity(tmp_path / 'activity.json')
    a, b = session(), session(id='2', sessionName='second', cwd='/other')
    state.submitted(a, '요청 A', 100)
    state.submitted(b, '요청 B', 110)
    done = {**a, 'completionEvent': 'done', 'completionAt': 120, 'completionUnread': True}
    first = state.sync([done, b])
    assert first['workspaceActivity'] == {workspace_key(a): 120, workspace_key(b): 110}
    # Acknowledgement, state oscillation and ongoing output are not new work.
    for status in ['working', 'waiting', 'idle']:
        result = state.sync([{**done, 'completionUnread': False, 'lastActivityAt': 999, 'aiState': status}, b])
        assert result['workspaceActivity'] == first['workspaceActivity']
        assert result['revision'] == first['revision']
    assert state.sync([])['workspaceActivity'] == first['workspaceActivity']
    assert SessionActivity(state.path).sync([done, b]) == first


def test_bootstrap_and_offline_replay_do_not_invent_recent_work(tmp_path):
    state = SessionActivity(tmp_path / 'activity.json')
    source = session(completionEvent='a', completionAt=100)
    sources = [source, session(id='2', sessionName='second', cwd='/other', lastActivityAt=999, aiState='working'),
               session(id='3', createdAt=0, completionEvent='b', completionAt=300),
               session(id='4', online=False, completionEvent='c', completionAt=400)]
    result = state.sync(sources)
    assert result['workspaceActivity'] == {workspace_key(source): 100}
    assert state.sync(list(reversed(sources)))['revision'] == result['revision']


def test_delayed_requests_and_stale_agent_titles_never_replace_the_latest_request(tmp_path):
    state = SessionActivity(tmp_path / 'activity.json')
    source = session()
    state.submitted(source, '새 요청', 120)
    state.submitted(source, '늦게 도착한 이전 요청', 110)
    result = state.sync([{**source, 'autoTitle': '아직 이전 작업 제목', 'completionEvent': 'done', 'completionAt': 130}])
    assert result['sessions'][0]['requestTitle'] == '새 요청'
    assert result['workspaceActivity'][workspace_key(source)] == 130


@pytest.mark.parametrize('endpoint', [routes_session.input_text, routes_session.paste_text])
def test_only_successful_input_changes_title_and_returns_shared_snapshot(monkeypatch, endpoint):
    source = session()
    monkeypatch.setattr(session_state, 'sessions', lambda: [source])
    monkeypatch.setattr(routes_session.commands, 'apply_command', AsyncMock(side_effect=ValueError('failed')))
    request = InputRequest(id='1', text='\n\x1b[32m바로 반영\x1b[0m\n두 번째 줄')
    with pytest.raises(Exception):
        asyncio.run(endpoint(request))
    assert session_activity.state.decorate([source])['sessions'][0]['requestTitle'] == ''
    monkeypatch.setattr(routes_session.commands, 'apply_command', AsyncMock())
    messages = []
    monkeypatch.setattr(ws, 'broadcast', messages.append)
    result = asyncio.run(endpoint(request))
    assert result['ok']
    assert result['sessionState'] == messages[-1]
    assert result['sessionState']['sessions'][0]['requestTitle'] == '바로 반영'


def test_metadata_write_failure_does_not_report_delivered_input_as_failed(monkeypatch):
    monkeypatch.setattr(session_state, 'sessions', lambda: [session()])
    monkeypatch.setattr(routes_session.commands, 'apply_command', AsyncMock())
    def failed(*args):
        raise OSError('disk failure')
    monkeypatch.setattr(session_activity.state, '_commit', failed)
    assert asyncio.run(routes_session.input_text(InputRequest(id='1', text='a'))) == {'ok': True}
    assert 'activityError' in session_state.snapshot()


def test_devices_share_titles_and_recency_even_without_a_new_status_revision(monkeypatch):
    from backend.security_audit import AuditMiddleware, audit
    monkeypatch.setattr(audit, 'write', lambda *a, **k: None)
    source = session()
    monkeypatch.setattr(session_state, 'sessions', lambda: [source])
    app = FastAPI()
    app.add_middleware(AuditMiddleware)
    app.include_router(routes_session_state.router)
    with TestClient(app) as phone, TestClient(app) as desktop:
        assert phone.get('/api/session-state').status_code == 401
        for client in [phone, desktop]:
            client.cookies.set('token', config.AUTH_TOKEN)
        before = desktop.get('/api/session-state').json()
        session_activity.state.submitted(source, '새로운 요청', 100)
        first = phone.get('/api/session-state')
        assert first.headers['cache-control'] == 'no-store'
        shared = first.json()
        assert shared['revision'] > before['revision']
        assert shared == desktop.get('/api/session-state').json()
        session_activity.state.submitted(source, '다음 요청', 110)
        latest = desktop.get('/api/session-state').json()
        assert latest['revision'] > shared['revision']
        assert latest['sessions'][0]['requestTitle'] == '다음 요청'
        source.update(completionId='done')
        completed = desktop.get('/api/session-state').json()
        acknowledged = phone.post('/api/session-state/acknowledge', json={
            'id': '1', 'event': completed['sessions'][0]['completionEvent']}).json()
        assert acknowledged['workspaceActivity'] == completed['workspaceActivity']
        assert acknowledged['sessions'][0]['requestTitle'] == '다음 요청'
        assert acknowledged == desktop.get('/api/session-state').json()


def test_just_created_local_session_resolves_identity_before_title_capture(monkeypatch):
    from backend import sessions, streamer, tmux
    source = sessions.Session(id='1', session_name='fixture', cwd='/project', cmd='codex')
    monkeypatch.setattr(sessions.store, 'sessions', {'1': source})
    monkeypatch.setattr(session_state, 'sessions', lambda: [source.to_dict()])
    monkeypatch.setattr(tmux, 'display_info', AsyncMock(return_value={'created_at': 123, 'process': 'codex'}))
    monkeypatch.setattr(streamer, 'broadcast', lambda _: None)
    context = asyncio.run(session_activity.prepare_input('1', '첫 요청'))
    assert context[0]['createdAt'] == 123
    session_activity.state.submitted(*context)
    assert session_activity.state.sync([source.to_dict()])['sessions'][0]['requestTitle'] == '첫 요청'
