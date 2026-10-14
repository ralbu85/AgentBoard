import asyncio
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from backend import task_titles as t
from backend.session_activity import request_hash


def row(text, role='assistant', at=102, provider='codex', **extra):
    stamp = datetime.fromtimestamp(at, timezone.utc).isoformat()
    body = {'role': role, 'content': [{'type': 'text', 'text': text}]}
    if provider == 'codex':
        return {'type': 'response_item', 'timestamp': stamp, 'payload': {'type': 'message', **body, **extra}}
    return {'type': role, 'timestamp': stamp, 'message': body, **extra}


def append(path, *rows):
    with path.open('a') as file:
        for item in rows:
            file.write(json.dumps(item) + '\n')


@pytest.mark.parametrize('provider', ['codex', 'claude'])
def test_only_current_assistant_labels_name_a_task_and_partial_appends_are_retried(tmp_path, provider):
    path = tmp_path/'transcript.jsonl'
    reader = t.Reader(); reader.started_at = 100
    append(path, row('old', 'user', 50, provider), row('작업: 오래된 제목', at=55, provider=provider),
           row('작업: 사용자 내용은 제목이 아님', 'user', 101, provider),
           row('일반 응답', at=102, provider=provider))
    assert reader.read('one', path, provider) is None
    message = json.dumps(row('**작업: 모바일 스크롤 개선**\n본문', at=103, provider=provider))
    with path.open('a') as file:
        file.write(message[:20])
    assert reader.read('one', path, provider) is None
    with path.open('a') as file:
        file.write(message[20:]+'\n')
    found = reader.read('one', path, provider)
    assert found['title'] == '모바일 스크롤 개선'
    assert found['requestHash'] == request_hash('작업: 사용자 내용은 제목이 아님')
    assert reader.read('one', path, provider) is None
    append(path, row('계속해', 'user', 104, provider), row('계속 진행하겠습니다.', at=105, provider=provider))
    assert reader.read('one', path, provider) is None


def test_hidden_reasoning_tool_results_and_quoted_examples_are_not_titles(tmp_path):
    path = tmp_path/'transcript.jsonl'; reader = t.Reader(); reader.started_at = 100
    append(path, row('요청', 'user', 101), row('작업: 숨은 추론', channel='analysis'),
           row('작업: 압축 요약', channel='summary'), row('작업: 도구 결과', 'tool'),
           row('```\n작업: 코드 예시\n```'), row('> 작업: 인용 예시'),
           row('설명\n작업: 두 번째 줄 예시'))
    assert reader.read('one', path, 'codex') is None
    assert t.message(row('작업: 자식 에이전트', provider='claude', isSidechain=True), 'claude') is None
    tool = row('not used', 'user', provider='claude')
    tool['message']['content'] = [{'type':'tool_result', 'content':'작업: 도구 결과'}]
    assert t.message(tool, 'claude') is None
    assert not t.task_label('작업: '+ '가'*61)
    assert not t.task_label('작업: 제목\x1b[0m')


def test_later_user_in_same_batch_clears_candidate_and_truncation_resets_context(tmp_path):
    path = tmp_path/'transcript.jsonl'; reader = t.Reader(); reader.started_at = 100
    append(path, row('첫 요청', 'user', 101), row('작업: 첫 작업', at=102), row('새 요청', 'user', 103))
    assert reader.read('one', path, 'codex') is None
    path.write_text('')
    append(path, row('작업: 사용자 없는 응답', at=104))
    assert reader.read('one', path, 'codex') is None


def test_large_record_does_not_stall_cursor_or_turn_payload_into_title(tmp_path, monkeypatch):
    path = tmp_path/'transcript.jsonl'; reader = t.Reader(); reader.started_at = 100
    monkeypatch.setattr(t, 'MAX_READ', 512)
    append(path, row('요청', 'user', 101))
    reader.read('one', path, 'codex')
    append(path, row('x'*1600, at=102), row('새 요청', 'user', 103), row('작업: 정상 요약', at=104))
    results = [reader.read('one', path, 'codex') for _ in range(8)]
    assert [r['title'] for r in results if r] == ['정상 요약']
    assert reader.cursors['one'].offset == path.stat().st_size


def test_source_requires_unique_parent_fd_header_and_cwd_never_newest_file(tmp_path, monkeypatch):
    root = tmp_path/'codex'; root.mkdir()
    process = tmp_path/'123'; (process/'fd').mkdir(parents=True)
    monkeypatch.setattr(t.conversations, 'ROOTS', {'codex': root})
    monkeypatch.setattr(t, 'nearest_agents', lambda _: [(process, 'codex', '123:456')])
    identity = '11111111-2222-3333-4444-555555555555'
    path = root/'one.jsonl'
    append(path, {'type':'session_meta','payload':{'id':identity,'cwd':'/project'}})
    # Merely sharing a cwd, even with a newer file, is not ownership evidence.
    assert t.exact_source(123, '/project') is None
    (process/'fd/4').symlink_to(path)
    assert t.exact_source(123, '/project') == (path, 'codex', '123:456')
    assert t.exact_source(123, '/other') is None
    other = root/'two.jsonl'; append(other, {'type':'session_meta','payload':{'id':identity,'cwd':'/project'}})
    (process/'fd/5').symlink_to(other)
    assert t.exact_source(123, '/project') is None
    (process/'fd/5').unlink()
    outside = tmp_path/'outside.jsonl'; outside.write_bytes(path.read_bytes())
    (process/'fd/4').unlink(); (process/'fd/4').symlink_to(outside)
    assert t.exact_source(123, '/project') is None


def test_generation_change_does_not_share_pending_user_or_cursor(tmp_path, monkeypatch):
    path=tmp_path/'log.jsonl'; reader=t.Reader(); reader.started_at=100
    append(path,row('요청','user',101))
    monkeypatch.setattr(t,'exact_source',lambda *_:(path,'codex','one'))
    assert reader.collect([('1',123,'/project',1)]) == []
    monkeypatch.setattr(t,'exact_source',lambda *_:(path,'codex','two'))
    path.write_text('')
    append(path,row('작업: 다른 프로세스의 응답',at=102))
    assert reader.collect([('1',123,'/project',1)]) == []
    assert len(reader.cursors) == 1


def test_claude_pid_registry_verifies_process_incarnation_and_exact_session(tmp_path, monkeypatch):
    root=tmp_path/'projects'; project=root/'encoded-project'; project.mkdir(parents=True)
    registry=tmp_path/'sessions'; registry.mkdir()
    process=tmp_path/'123'; (process/'fd').mkdir(parents=True)
    identity='11111111-2222-3333-4444-555555555555'
    path=project/(identity+'.jsonl')
    append(path, {'type':'user','sessionId':identity,'cwd':'/project'})
    monkeypatch.setattr(t.conversations,'ROOTS',{'claude':root})
    monkeypatch.setattr(t,'nearest_agents',lambda _:[(process,'claude','123:456')])
    data={'pid':123,'sessionId':identity,'cwd':'/project','procStart':'456'}
    metadata=registry/'123.json'; metadata.write_text(json.dumps(data))
    assert t.exact_source(123,'/project') == (path,'claude','123:456')
    metadata.write_text(json.dumps({**data,'procStart':'455'}))
    assert t.exact_source(123,'/project') is None
    metadata.write_text(json.dumps({**data,'sessionId':'../../outside'}))
    assert t.exact_source(123,'/project') is None
    metadata.write_text(json.dumps(data))
    path.write_text(json.dumps({'type':'user','sessionId':'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee','cwd':'/project'})+'\n')
    assert t.exact_source(123,'/project') is None


def test_process_switch_during_read_discards_candidate(tmp_path, monkeypatch):
    path=tmp_path/'log.jsonl'; reader=t.Reader(); reader.started_at=100
    append(path,row('요청','user',101),row('작업: 지난 프로세스 응답',at=102))
    sources=iter([(path,'codex','old'),(path,'codex','new')])
    monkeypatch.setattr(t,'exact_source',lambda *_:next(sources))
    assert reader.collect([('1',123,'/project',1)]) == []


def test_remote_summary_survives_replay_and_is_namespaced():
    from backend.agents import AgentConn
    from backend.namespace import prefix_msg
    conn = AgentConn('remote','Remote',SimpleNamespace())
    summary={'title':'원격 작업', 'at':102, 'userAt':101, 'requestHash':request_hash('원격 요청')}
    conn.update_from({'type':'spawned','id':'1','autoTitle':'원격 제목','taskSummary':summary})
    assert conn.sessions['1']['taskSummary'] == summary
    next_summary={**summary,'title':'다음 작업','at':105}
    conn.update_from({'type':'task-summary','id':'1','taskSummary':next_summary})
    assert conn.sessions['1']['taskSummary'] == next_summary
    assert prefix_msg('remote','Remote',{'type':'task-summary','id':'1','taskSummary':summary})['id'] == 'remote:1'


def test_instruction_install_is_idempotent_preserves_rules_and_has_private_backup(tmp_path):
    spec = importlib.util.spec_from_file_location('installer', Path(__file__).parents[2]/'tools/install_task_title_instructions.py')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    path=tmp_path/'AGENTS.md'; original='# User rules\nNever disable security.\n'
    path.write_text(original)
    assert module.install(path)
    assert path.read_text().startswith(original)
    assert 'AGENTBOARD_SESSION' in path.read_text()
    assert not module.install(path)
    backups=list(tmp_path.glob('*.agentboard-backup-*'))
    assert len(backups)==1 and backups[0].read_text()==original
    assert backups[0].stat().st_mode & 0o777 == 0o600
    assert module.install(path, remove=True)
    assert path.read_text().strip()==original.strip()
    link=tmp_path/'link';link.symlink_to(path)
    with pytest.raises(ValueError):module.install(link)


def test_new_terminal_remains_clean_shell_with_scoped_marker(monkeypatch):
    from backend import tmux
    call=AsyncMock();monkeypatch.setattr(tmux,'tmux_run',call)
    asyncio.run(tmux.new_session('isolated-test','/project','bash --noprofile --norc'))
    args=call.call_args.args[0]
    assert args[-3:]==['-e','AGENTBOARD_SESSION=1','bash --noprofile --norc']
    assert 'claude' not in args and 'codex' not in args
