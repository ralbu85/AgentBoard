import asyncio
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend import config, routes_session, routes_session_state, session_activity, session_state, ws
from backend.models import InputRequest
from backend.session_activity import SessionActivity, workspace_key, request_hash


def session(**changes):
    return {'id': '1', 'sessionName': 'pane', 'host': 'local', 'createdAt': 10,
            'cwd': '/project', 'status': 'running', 'aiState': 'idle',
            'autoTitle': 'Old task', **changes}


def test_semantic_titles_survive_restart_and_numeric_id_changes_without_storing_prompts(tmp_path):
    path = tmp_path / 'activity.json'
    state = SessionActivity(path)
    sources = [session(id=str(i), sessionName=f'pane-{i}', autoTitle=f'작업 요약 {i}') for i in range(8)]
    for i, source in enumerate(sources):
        state.submitted(source, request_hash('프롬프트 비밀 내용'), 100+i)
    result = state.sync(sources)
    assert [s['taskTitle'] for s in result['sessions']] == [f'작업 요약 {i}' for i in range(8)]
    assert path.stat().st_mode & 0o777 == 0o600
    assert '프롬프트 비밀 내용' not in path.read_text()
    assert SessionActivity(path).sync([{**s, 'id': f'new-{s["id"]}'} for s in sources])['workspaceActivity'] == result['workspaceActivity']
    assert state.sync([session(id='0', sessionName='pane-0', createdAt=99, autoTitle='')])['sessions'][0]['taskTitle'] == ''


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


def test_requests_keep_title_and_old_responses_cannot_rename_newer_work(tmp_path):
    state = SessionActivity(tmp_path / 'activity.json')
    source = session()
    state.sync([source])
    state.submitted(source, request_hash('새 요청'), 120)
    state.submitted(source, request_hash('이전 요청'), 110)
    old = {'title': '지난 요청 요약', 'at': 130, 'userAt': 110, 'requestHash': request_hash('이전 요청')}
    result = state.sync([{**source, 'taskSummary': old}])
    assert result['sessions'][0]['taskTitle'] == 'Old task'
    latest = {'title': '모바일 스크롤 개선', 'at': 131, 'userAt': 121, 'requestHash': request_hash('새 요청')}
    current = {**source, 'taskSummary': latest}
    assert state.sync([current])['sessions'][0]['taskTitle'] == '모바일 스크롤 개선'
    state.submitted(source, request_hash('계속해'), 140)
    assert state.sync([current])['sessions'][0]['taskTitle'] == '모바일 스크롤 개선'
    assert state.sync([current])['workspaceActivity'][workspace_key(source)] == 140
    assert SessionActivity(state.path).sync([source])['sessions'][0]['taskTitle'] == '모바일 스크롤 개선'
    assert state.sync([{**current, 'autoTitle': '다음 작업의 새 제목'}])['sessions'][0]['taskTitle'] == '다음 작업의 새 제목'


def test_migration_discards_prompt_excerpts_but_keeps_recency(tmp_path):
    import json
    from backend.session_state import identity
    path = tmp_path/'activity.json'
    source = session()
    path.write_text(json.dumps({'version':1, 'revision':2, 'records': {identity(source): {'title':'비밀 프롬프트', 'requestAt':100}}, 'workspaces':{workspace_key(source):100}}))
    state = SessionActivity(path)
    result = state.sync([source])
    assert result['sessions'][0]['taskTitle'] == 'Old task'
    assert result['workspaceActivity'] == {workspace_key(source):100}
    assert '비밀 프롬프트' not in path.read_text()
    assert json.loads(path.read_text())['version'] == 2


@pytest.mark.parametrize('summary', [None, 'bad', {'title':'제목','at':'bad'},
    {'title':'제목','at':float('nan'),'userAt':1,'requestHash':request_hash('요청')},
    {'title':'제목','at':10,'userAt':20,'requestHash':request_hash('요청')}])
def test_malformed_remote_summary_does_not_break_shared_status(tmp_path, summary):
    state = SessionActivity(tmp_path/'activity.json')
    result = state.sync([session(taskSummary=summary, host='remote')])
    assert result['sessions'][0]['taskTitle'] == 'Old task'


def test_repeated_prompt_never_replays_an_older_matching_response(tmp_path):
    state=SessionActivity(tmp_path/'activity.json'); source=session()
    state.submitted(source,request_hash('계속해'),140)
    old={'title':'예전 제목','at':130,'userAt':110,'requestHash':request_hash('계속해')}
    assert state.sync([{**source,'taskSummary':old}])['sessions'][0]['taskTitle'] == 'Old task'


@pytest.mark.parametrize('endpoint', [routes_session.input_text, routes_session.paste_text])
def test_only_successful_input_changes_recency_and_returns_shared_snapshot(monkeypatch, endpoint):
    source = session()
    monkeypatch.setattr(session_state, 'sessions', lambda: [source])
    monkeypatch.setattr(routes_session.commands, 'apply_command', AsyncMock(side_effect=ValueError('failed')))
    request = InputRequest(id='1', text='\n\x1b[32m바로 반영\x1b[0m\n두 번째 줄')
    with pytest.raises(Exception):
        asyncio.run(endpoint(request))
    assert session_activity.state.decorate([source])['sessions'][0]['taskTitle'] == ''
    monkeypatch.setattr(routes_session.commands, 'apply_command', AsyncMock())
    messages = []
    monkeypatch.setattr(ws, 'broadcast', messages.append)
    result = asyncio.run(endpoint(request))
    assert result['ok']
    assert result['sessionState'] == messages[-1]
    assert result['sessionState']['sessions'][0]['taskTitle'] == 'Old task'
    assert result['sessionState']['workspaceActivity'][workspace_key(source)] > 0


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
        assert latest['sessions'][0]['taskTitle'] == 'Old task'
        source.update(completionId='done')
        completed = desktop.get('/api/session-state').json()
        acknowledged = phone.post('/api/session-state/acknowledge', json={
            'id': '1', 'event': completed['sessions'][0]['completionEvent']}).json()
        assert acknowledged['workspaceActivity'] == completed['workspaceActivity']
        assert acknowledged['sessions'][0]['taskTitle'] == 'Old task'
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
    assert session_activity.state.sync([source.to_dict()])['sessions'][0]['taskTitle'] == ''
