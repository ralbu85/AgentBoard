import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from backend import conversations as c, routes_conversation as routes

ID = '11111111-2222-3333-4444-555555555555'
OTHER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'


def write(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(''.join(json.dumps(row) + '\n' for row in rows))
    return path


def meta(identity=ID, cwd='/project'):
    return {'type': 'session_meta', 'payload': {'id': identity, 'cwd': cwd}}


def message(text, role='assistant', channel='final'):
    return {'type': 'response_item', 'payload': {'type': 'message', 'role': role, 'channel': channel,
                                               'content': [{'type': 'output_text', 'text': text}]}}


def test_inventory_matches_cwd_and_excludes_symlinks_and_nested_agents(tmp_path, monkeypatch):
    monkeypatch.setattr(c, 'ROOTS', {'codex': tmp_path/'codex'})
    good = write(tmp_path/'codex/one.jsonl', [meta()])
    write(tmp_path/'codex/other.jsonl', [meta(OTHER, '/other')])
    write(tmp_path/'codex/subagents/child.jsonl', [meta(OTHER)])
    outside = write(tmp_path/'outside.jsonl', [meta(OTHER)])
    (tmp_path/'codex/link.jsonl').symlink_to(outside)
    found = c.inventory('/project')
    assert list(found) == ['codex:'+ID]
    assert found['codex:'+ID][0] == good


def test_transcript_preserves_original_text_and_filters_hidden_and_system_content(tmp_path):
    text = 'An original paragraph without terminal wrapping.\n\n    code()'
    path = write(tmp_path/'log.jsonl', [meta(), message('private', channel='analysis'),
                                    message('system instructions', role='system'), message(text)])
    page = c.transcript(path, 'codex')
    assert [m['text'] for m in page['messages']] == [text]
    assert page['before'] is None


def test_byte_pagination_is_stable_when_file_grows_and_ignores_partial_append(tmp_path):
    path = write(tmp_path/'log.jsonl', [meta(), *[message(str(i)) for i in range(6)]])
    page = c.transcript(path, 'codex', limit=3)
    with path.open('a') as stream:
        stream.write(json.dumps(message('6'))+'\n'+ '{"type":')
    older = c.transcript(path, 'codex', before=page['before'], limit=3)
    assert [m['text'] for m in older['messages']] == ['0','1','2']
    assert [m['text'] for m in page['messages']] == ['3','4','5']
    assert c.transcript(path, 'codex')['messages'][-1]['text'] == '6'


def test_claude_skips_thinking_tools_and_sidechains(tmp_path):
    content = [{'type':'thinking','thinking':'private'}, {'type':'tool_use','name':'exec'}, {'type':'text','text':'visible'}]
    path = write(tmp_path/'claude.jsonl', [{'type':'assistant','message':{'role':'assistant','content':content}},
        {'type':'user','isSidechain':True,'message':{'role':'user','content':'child'}}])
    assert [m['text'] for m in c.transcript(path,'claude')['messages']] == ['visible']


def setup_route(tmp_path, monkeypatch):
    path = write(tmp_path/'log.jsonl', [meta(),message('correct conversation')])
    candidates = {'codex:'+ID:(path,{'provider':'codex','id':ID,'timestamp':''})}
    monkeypatch.setattr(routes,'context',AsyncMock(return_value=(SimpleNamespace(),1,candidates,'owner')))
    monkeypatch.setattr(c,'bindings',SimpleNamespace(values={}))
    return candidates


def test_no_latest_file_fallback_when_process_ownership_is_unavailable(tmp_path, monkeypatch):
    setup_route(tmp_path,monkeypatch)
    monkeypatch.setattr(c,'exact_candidate',lambda *_:None)
    result = asyncio.run(routes.read('1',before=None,source=None))
    assert result['available'] is False and result['messages'] == []


def test_stale_pagination_source_is_rejected_after_session_changes(tmp_path, monkeypatch):
    setup_route(tmp_path,monkeypatch)
    monkeypatch.setattr(c,'exact_candidate',lambda *_:'codex:'+ID)
    with pytest.raises(HTTPException) as error:
        asyncio.run(routes.read('1',before=123,source='codex:'+OTHER))
    assert error.value.status_code == 409


def test_binding_identity_changes_on_pane_reuse_and_atomic_file_is_private(tmp_path, monkeypatch):
    monkeypatch.setattr(c.config,'STATE_DIR',tmp_path)
    binding = c.Bindings()
    a=binding.owner('term-1','100:1','/project');b=binding.owner('term-1','100:2','/project')
    assert a != b
    binding.put(a,'codex:'+ID)
    assert binding.path.stat().st_mode & 0o777 == 0o600
    assert c.Bindings().values == {a:'codex:'+ID}


def test_unknown_binding_cannot_read_arbitrary_path(tmp_path, monkeypatch):
    setup_route(tmp_path,monkeypatch)
    with pytest.raises(HTTPException) as error:
        asyncio.run(routes.bind('1',routes.Bind(source='/root/.ssh/id_rsa')))
    assert error.value.status_code == 400


def test_unfinished_large_record_does_not_create_nonprogressing_pagination(tmp_path,monkeypatch):
    monkeypatch.setattr(c,'CHUNK',400)
    path=write(tmp_path/'large.jsonl',[meta(),message('x'*1200)])
    first=c.transcript(path,'codex')
    assert first['limited'] and first['before'] < path.stat().st_size
    second=c.transcript(path,'codex',before=first['before'])
    assert second['before'] < first['before']


def test_transcript_routes_require_authentication():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    app=FastAPI();app.include_router(routes.router)
    with TestClient(app) as client:
        assert client.get('/api/conversations/1').status_code==401
        assert client.put('/api/conversations/1',json={'source':None}).status_code==401
