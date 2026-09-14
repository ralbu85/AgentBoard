"""Owned test kernels and temporary notebooks only; never touches real sessions."""
import asyncio
import json
import sys

import nbformat
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from backend import config, notebooks, routes_notebook


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setattr(config, 'ALLOWED_ROOTS', [tmp_path])
    monkeypatch.setattr(notebooks, 'STATE_DIR', tmp_path / 'recovery')
    monkeypatch.setattr(notebooks, 'PYTHON', sys.executable)
    manager = notebooks.NotebookManager()
    monkeypatch.setattr(routes_notebook, 'manager', manager)
    def document(*sources):
        path = tmp_path / (str(len(manager.documents)) + '.ipynb')
        path.write_text(nbformat.writes(nbformat.v4.new_notebook(cells=[nbformat.v4.new_code_cell(s) for s in sources])))
        return manager.open(str(path))
    return manager, document


def test_edit_save_conflict_and_recovery(setup):
    manager, create = setup
    doc = create('a = 1')
    original = doc.path.read_text()
    draft = json.loads(original)
    draft['cells'][0]['source'] = 'a = 42'
    revision = doc.revision
    doc.update(json.dumps(draft), revision)
    assert doc.path.read_text() == original
    with pytest.raises(HTTPException) as exc:
        doc.update(original, revision)
    assert exc.value.status_code == 409
    recovered = notebooks.Document(doc.path)
    assert recovered.dirty and not recovered.km
    assert recovered.notebook['cells'][0]['source'] == 'a = 42'
    doc.save(doc.revision)
    assert not doc.dirty and 'a = 42' in doc.path.read_text()
    assert not notebooks.Document(doc.path).dirty
    doc.path.write_text(original)
    with pytest.raises(HTTPException) as exc:
        doc.save(doc.revision)
    assert exc.value.status_code == 409
    assert doc.path.read_text() == original


def test_http_auth_paths_and_revisions(setup, tmp_path):
    manager, create = setup
    doc = create('42')
    app = FastAPI()
    app.include_router(routes_notebook.router)
    with TestClient(app) as client:
        assert client.post('/api/notebooks/open', json={'path': str(doc.path)}).status_code == 401
        client.cookies.set('token', config.AUTH_TOKEN)
        assert client.post('/api/notebooks/open', json={'path': str(doc.path)}, headers={'origin': 'https://foreign.test'}).status_code == 403
        assert client.post('/api/notebooks/open', json={'path': '/etc/passwd'}).status_code == 403
        assert client.post('/api/notebooks/open', json={'path': str(doc.path)}).status_code == 200
        base = '/api/notebooks/' + doc.id
        assert client.get(base, params={'since': doc.revision}).json() == {'unchanged': True}
        assert client.put(base, json={'revision': 0, 'content': '{}'}).status_code == 409
        assert client.put(base, json={'revision': doc.revision, 'content': '[]'}).status_code == 400
        assert client.post(base+'/action', json={'action': 'execute', 'revision': doc.revision, 'cell': 9}).status_code == 400
        assert not doc.km


def test_real_kernel_execution_errors_save_and_interrupt(setup):
    manager, create = setup
    doc = create('x = 40\nprint("hello")', 'x + 2', 'raise ValueError("fixture error")', 'print("must not run")')
    async def scenario():
        try:
            await manager.start(doc)
            doc.schedule([0, 1, 2, 3])
            with pytest.raises(HTTPException):
                doc.update(notebooks.encoded(doc.notebook), doc.revision)
            await asyncio.wait_for(doc.task, 20)
            cells = doc.notebook['cells']
            assert cells[0]['outputs'][0]['text'] == 'hello\n'
            assert cells[1]['outputs'][0]['data']['text/plain'] == '42'
            assert cells[2]['outputs'][0]['ename'] == 'ValueError'
            assert not cells[3]['outputs'] and doc.error
            assert doc.state == 'idle'
            doc.save(doc.revision)
            nbformat.validate(json.loads(doc.path.read_text()))
            draft = json.loads(notebooks.encoded(doc.notebook))
            draft['cells'][0]['source'] = 'import time\nprint("sleeping", flush=True)\ntime.sleep(60)'
            doc.update(json.dumps(draft), doc.revision)
            doc.schedule([0, 3])
            for _ in range(100):
                if doc.notebook['cells'][0]['outputs']:
                    break
                await asyncio.sleep(.05)
            await doc.interrupt()
            assert not doc.busy and not doc.notebook['cells'][3]['outputs']
            assert not doc.error
            assert await doc.km.is_alive()
            doc.schedule([1])
            await asyncio.wait_for(doc.task, 10)
            assert doc.notebook['cells'][1]['outputs'][0]['data']['text/plain'] == '42'
            await doc.shutdown()
            await manager.start(doc)
            doc.schedule([1])
            await asyncio.wait_for(doc.task, 10)
            assert doc.notebook['cells'][1]['outputs'][0]['ename'] == 'NameError'
            doc.path.unlink()
            assert manager.get(doc.id) is doc
        finally:
            await manager.shutdown()
        assert doc.km is None
    asyncio.run(scenario())


def test_rich_output_updates_clear_and_limits(setup, monkeypatch):
    manager, create = setup
    monkeypatch.setattr(notebooks, 'MAX_OUTPUT', 5000)
    doc = create('from IPython.display import display, HTML, clear_output\nh = display(HTML("<b>old</b>"), display_id=True)\nh.update(HTML("<b>new</b>"))',
                 'clear_output(wait=True)\nprint("visible")', 'print("x" * 10000)')
    async def scenario():
        try:
            await manager.start(doc)
            doc.schedule([0, 1, 2])
            await asyncio.wait_for(doc.task, 15)
            assert doc.notebook['cells'][0]['outputs'][0]['data']['text/html'] == '<b>new</b>'
            assert doc.notebook['cells'][1]['outputs'][0]['text'] == 'visible\n'
            assert '한도' in doc.notebook['cells'][2]['outputs'][0]['text']
            nbformat.validate(doc.notebook)
            doc.schedule([0])
            await asyncio.wait_for(doc.task, 10)
            assert len(doc.displays[next(iter(doc.displays))]) <= 1
        finally:
            await manager.shutdown()
    asyncio.run(scenario())


def test_kernel_limit_and_non_python(setup, monkeypatch):
    manager, create = setup
    one, two = create('1'), create('2')
    monkeypatch.setattr(notebooks, 'MAX_KERNELS', 1)
    async def scenario():
        try:
            await manager.start(one)
            with pytest.raises(HTTPException) as exc:
                await manager.start(two)
            assert exc.value.status_code == 409
            await one.shutdown()
            two.notebook['metadata']['language_info'] = {'name': 'R'}
            with pytest.raises(HTTPException) as exc:
                await manager.start(two)
            assert exc.value.status_code == 400
        finally:
            await manager.shutdown()
    asyncio.run(scenario())


def test_failed_start_does_not_leak_kernel_slot(setup, monkeypatch):
    manager, create = setup
    doc = create('1')
    monkeypatch.setattr(notebooks, 'PYTHON', '/nonexistent/agentboard-test-python')
    async def scenario():
        try:
            with pytest.raises(HTTPException) as exc:
                await manager.start(doc)
            assert exc.value.status_code == 503
            assert doc.km is None and doc.state == 'stopped'
        finally:
            await manager.shutdown()
    asyncio.run(scenario())


def test_evicted_document_retains_unsaved_draft(setup, monkeypatch):
    manager, create = setup
    monkeypatch.setattr(notebooks, 'MAX_DOCUMENTS', 1)
    first = create('1')
    draft = json.loads(notebooks.encoded(first.notebook))
    draft['cells'][0]['source'] = 'remember me'
    first.update(json.dumps(draft), first.revision)
    second = create('2')
    assert first.id not in manager.documents and second.id in manager.documents
    recovered = manager.open(str(first.path))
    assert recovered.notebook['cells'][0]['source'] == 'remember me'
    assert recovered.dirty and not recovered.km


def test_environment_discovery_is_read_only(setup, tmp_path):
    from backend.notebook_environments import discover
    env = tmp_path / '.venv' / 'bin'
    env.mkdir(parents=True)
    python = env / 'python'
    marker = tmp_path / 'must-not-run'
    python.write_text('#!/bin/sh\ntouch '+str(marker)+'\n')
    python.chmod(0o755)
    options = discover(tmp_path, sys.executable)
    found = next(item for item in options if item['python'] == str(python))
    assert found['source'] == '프로젝트 환경' and '.venv' in found['name']
    assert not marker.exists()


def test_environment_selection_persistence_and_kernel_guard(setup, monkeypatch):
    manager, create = setup
    doc = create('import sys\nprint(sys.executable)')
    choices = [{'id':'chosen','name':'Research Python','python':sys.executable,'source':'test'}]
    monkeypatch.setattr(notebooks.Document, 'environments', lambda self: choices)
    doc.select_environment('chosen')
    assert doc.snapshot()['kernelName'] == 'Research Python'
    assert notebooks.Document(doc.path).environment == 'chosen'
    with pytest.raises(HTTPException):
        doc.select_environment('arbitrary-command')
    async def scenario():
        try:
            await manager.start(doc)
            with pytest.raises(HTTPException) as exc:
                doc.select_environment('chosen')
            assert exc.value.status_code == 409
            doc.schedule([0])
            await asyncio.wait_for(doc.task, 10)
            assert sys.executable in doc.notebook['cells'][0]['outputs'][0]['text']
        finally:
            await manager.shutdown()
    asyncio.run(scenario())


def test_select_and_connect_requires_confirmation_before_replacing(setup, monkeypatch):
    manager, create = setup
    doc = create('value = 17')
    choices = [{'id': key, 'name': key, 'python': sys.executable, 'source': 'test'} for key in ('one', 'two')]
    monkeypatch.setattr(notebooks.Document, 'environments', lambda self: choices)
    async def select(key, replace=False):
        return await routes_notebook.action(doc.id, routes_notebook.Action(action='connect-environment', revision=doc.revision, environment=key, replace=replace))
    async def scenario():
        try:
            result = await select('one')
            assert result['kernel'] and result['state'] == 'idle' and result['kernelName'] == 'one'
            original = doc.km
            await select('one')
            assert doc.km is original
            for key, replace in [('two', False), ('unknown', True)]:
                with pytest.raises(HTTPException):
                    await select(key, replace)
                assert doc.km is original and await original.is_alive()
            result = await select('two', True)
            assert result['kernelName'] == 'two' and result['state'] == 'idle'
            assert doc.km is not original
        finally:
            await manager.shutdown()
    asyncio.run(scenario())


def test_kernel_list_does_not_serialize_notebook_contents(setup, monkeypatch):
    manager, create = setup
    doc = create('print("large document fixture")')
    monkeypatch.setattr(notebooks, 'encoded', lambda _: (_ for _ in ()).throw(AssertionError('list serialized content')))
    result = asyncio.run(routes_notebook.list_notebooks())
    assert result['sessions'][0]['id'] == doc.id
    assert 'content' not in result['sessions'][0]
