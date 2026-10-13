import asyncio
import json
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend import config, recent_work, session_state, routes_session, routes_session_state, ws
from backend.models import InputRequest
from backend.recent_work import RecentWork


def session(**changes):
    return {**dict(id='1', sessionName='pane', host='local', cwd='/project', createdAt=10,
                   cmd='codex', status='running', aiState='idle', completionEvent='',
                   completionAt=0, completionUnread=False, lastActivityAt=0), **changes}


def test_five_requests_keep_context_after_completion_read_close_restart_and_id_reuse(tmp_path):
    path = tmp_path/'recent.json'
    state = RecentWork(path)
    source = session()
    state.sync([source], {})
    for i in range(6):
        state.submitted(source, f'작업 {i}', 100+i, '')
    result = state.snapshot()
    assert [item['title'] for item in result['items']] == [f'작업 {i}' for i in range(5, 0, -1)]
    assert all(item['status'] == 'previous' for item in result['items'][1:])
    completed = session(completionEvent='done', completionAt=110, completionUnread=True)
    done = state.sync([completed], {})
    assert done['items'][0]['status'] == 'completed' and done['items'][0]['unread']
    read = state.sync([{**completed, 'completionUnread': False}], {})
    assert len(read['items']) == 5 and not read['items'][0]['unread']
    assert read['items'][0]['id'] == result['items'][0]['id']
    renamed = read['items'][0]['id']
    state.rename(renamed, '직접 수정한 작업명')
    state = RecentWork(path)
    recovered = state.sync([{**completed, 'id': '9', 'completionUnread': False}], {})
    assert recovered['items'][0]['title'] == '직접 수정한 작업명'
    assert all(item['sessionId'] == '9' for item in recovered['items'])
    removed = state.sync([], {})
    assert len(removed['items']) == 5
    assert path.stat().st_mode & 0o777 == 0o600
    # An unrelated process reusing the numeric id must not own these entries.
    other = state.sync([session(createdAt=20, sessionName='new-pane')], {})
    assert all(item['sessionName'] == 'pane' for item in other['items'])


def test_status_polling_and_acknowledging_do_not_reorder_completed_work(tmp_path):
    state = RecentWork(tmp_path/'recent.json')
    source = session()
    state.sync([source], {})
    state.submitted(source, '처음 요청', 100, '')
    state.sync([session(completionEvent='a', completionAt=110, completionUnread=True)], {})
    second = session(id='2', sessionName='second', cwd='/other')
    state.submitted(second, '다음 요청', 120, '')
    before = state.snapshot()
    sessions = [session(completionEvent='a', completionAt=110, lastActivityAt=200), second]
    after = state.sync(sessions, {})
    assert [row['id'] for row in after['items']] == [row['id'] for row in before['items']]
    assert state.sync(sessions, {}) == after


def test_fast_completion_is_merged_with_request_and_delayed_sends_keep_order(tmp_path):
    state = RecentWork(tmp_path/'recent.json')
    source = session()
    state.sync([source], {})
    state.sync([session(completionEvent='fast', completionAt=101)], {})
    state.submitted(source, '빠른 요청', 100, '')
    assert len(state.snapshot()['items']) == 1
    assert state.snapshot()['items'][0]['title'] == '빠른 요청'
    assert state.snapshot()['items'][0]['status'] == 'completed'
    state.submitted(source, '나중 요청', 120, 'fast')
    state.submitted(source, '먼저 보낸 요청', 115, 'fast')
    rows = state.snapshot()['items']
    assert rows[0]['title'] == '나중 요청' and rows[0]['status'] == 'submitted'
    assert rows[1]['status'] == 'previous'


def test_bootstrap_uses_known_timestamps_and_offline_replay_does_not_create_work(tmp_path):
    state = RecentWork(tmp_path/'recent.json')
    sources = [session(id=str(i), sessionName=f'pane-{i}', completionEvent=f'done-{i}', completionAt=100+i) for i in range(8)]
    sources += [session(id='offline', online=False, completionEvent='old', completionAt=999), session(id='unknown', createdAt=0)]
    result = state.sync(sources, {})
    assert [row['at'] for row in result['items']] == [107, 106, 105, 104, 103]
    assert state.sync(list(reversed(sources)), {}) == result
    assert RecentWork(state.path).sync(sources, {}) == result


def test_initial_history_can_fill_a_late_title_without_overwriting_previous_task_names(tmp_path):
    state = RecentWork(tmp_path/'recent.json')
    source = session(completionEvent='done', completionAt=100)
    initial = state.sync([source], {'1': 'codex #12'})
    assert initial['items'][0]['title'] == '터미널 작업'
    filled = state.sync([{**source, 'autoTitle': '완료된 작업'}], {})
    assert filled['items'][0]['title'] == '완료된 작업'
    later = state.sync([{**source, 'autoTitle': '다음 작업 제목'}], {})
    assert later['items'][0]['title'] == '완료된 작업'


def test_input_title_is_only_first_nonblank_line_and_never_created_for_failed_send(monkeypatch):
    assert recent_work.label('\n  \x1b[32m수정 요청\x1b[0m\n긴 본문') == '수정 요청'
    source = session()
    monkeypatch.setattr(session_state, 'sessions', lambda: [source])
    monkeypatch.setattr(routes_session.commands, 'apply_command', AsyncMock(side_effect=ValueError('failed')))
    with pytest.raises(Exception):
        asyncio.run(routes_session.input_text(InputRequest(id='1', text='수정 요청\n긴 본문')))
    assert recent_work.state.snapshot()['items'] == []
    monkeypatch.setattr(routes_session.commands, 'apply_command', AsyncMock())
    monkeypatch.setattr(ws, 'broadcast', lambda _: None)
    assert asyncio.run(routes_session.input_text(InputRequest(id='1', text='수정 요청\n긴 본문'))) == {'ok': True}
    assert recent_work.state.snapshot()['items'][0]['title'] == '수정 요청'
    assert '긴 본문' not in recent_work.state.path.read_text()


def test_history_write_failure_never_reports_delivered_input_as_failed(monkeypatch):
    monkeypatch.setattr(session_state, 'sessions', lambda: [session()])
    monkeypatch.setattr(routes_session.commands, 'apply_command', AsyncMock())
    def failed(*args):
        raise OSError('disk failure')
    monkeypatch.setattr(recent_work.state, '_commit', failed)
    assert asyncio.run(routes_session.input_text(InputRequest(id='1', text='a'))) == {'ok': True}
    snapshot = session_state.snapshot()
    assert len(snapshot['sessions']) == 1 and 'recentWorkError' in snapshot


def test_two_devices_share_history_after_ack_rename_and_reconnect(monkeypatch):
    from backend.security_audit import AuditMiddleware, audit
    monkeypatch.setattr(audit, 'write', lambda *a, **k: None)
    source = session(completionId='result', lastActivityAt=100)
    monkeypatch.setattr(session_state, 'sessions', lambda: [source])
    messages = []
    monkeypatch.setattr(ws, 'broadcast', messages.append)
    app = FastAPI();app.add_middleware(AuditMiddleware);app.include_router(routes_session_state.router)
    with TestClient(app) as phone, TestClient(app) as desktop:
        assert phone.get('/api/session-state').status_code == 401
        for client in [phone, desktop]:
            client.cookies.set('token', config.AUTH_TOKEN)
        first = desktop.get('/api/session-state').json()
        item = first['recentWork']['items'][0]
        body = {'id': item['id'], 'title': '공유 작업명'}
        url = '/api/session-state/recent-work/title'
        assert phone.post(url, json=body, headers={'origin': 'https://foreign.test'}).status_code == 403
        response = phone.post(url, json=body)
        assert response.headers['cache-control'] == 'no-store'
        shared = response.json()
        assert desktop.get('/api/session-state').json()['recentWork'] == shared['recentWork']
        receipt = {'id': '1', 'event': first['sessions'][0]['completionEvent']}
        read = phone.post('/api/session-state/acknowledge', json=receipt).json()
        assert read['recentWork']['items'][0]['title'] == '공유 작업명'
        assert not read['recentWork']['items'][0]['unread']
        assert desktop.get('/api/session-state').json() == read == messages[-1]
        assert phone.post(url, json={'id': 'missing', 'title': 'x'}).status_code == 404
