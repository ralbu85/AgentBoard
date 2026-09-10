import asyncio
import hashlib
from pathlib import Path

from starlette.requests import Request
from backend import routes_file, config
from backend.models import FileWriteRequest
from backend.streamer import _background_stability
from backend.state_detector import detect_state


def test_edit_conflict_preserves_external_changes(tmp_path, monkeypatch):
    monkeypatch.setattr(config, 'ALLOWED_ROOTS', [tmp_path])
    path = tmp_path / 'a.py'
    path.write_text('original')
    read = asyncio.run(routes_file.read_file(str(path)))
    path.write_text('agent change')
    result = asyncio.run(routes_file.write_file(FileWriteRequest(path=str(path), content='user change', expectedVersion=read['version'])))
    assert result.status_code == 409
    assert path.read_text() == 'agent change'


def test_save_versions_and_new_file_collision(tmp_path, monkeypatch):
    monkeypatch.setattr(config, 'ALLOWED_ROOTS', [tmp_path])
    path = tmp_path / 'a.py'
    result = asyncio.run(routes_file.write_file(FileWriteRequest(path=str(path), content='hello', expectedVersion='')))
    assert result['version'] == hashlib.sha256(b'hello').hexdigest()
    conflict = asyncio.run(routes_file.write_file(FileWriteRequest(path=str(path), content='overwrite', expectedVersion='')))
    assert conflict.status_code == 409
    result2 = asyncio.run(routes_file.write_file(FileWriteRequest(path=str(path), content='updated', expectedVersion=result['version'])))
    assert result2['ok']
    assert path.read_text() == 'updated'
    assert not list(tmp_path.glob('.*.tmp-*'))


def upload_request(body):
    async def receive():
        return {'type': 'http.request', 'body': body, 'more_body': False}
    return Request({'type': 'http', 'method': 'POST', 'path': '/'}, receive)


def test_upload_collision_and_temporary_cleanup(tmp_path, monkeypatch):
    monkeypatch.setattr(config, 'ALLOWED_ROOTS', [tmp_path])
    first = asyncio.run(routes_file.upload(upload_request(b'first'), id='', dir=str(tmp_path), name='a.txt'))
    assert first['ok']
    second = asyncio.run(routes_file.upload(upload_request(b'second'), id='', dir=str(tmp_path), name='a.txt'))
    assert second.status_code == 409
    assert (tmp_path / 'a.txt').read_bytes() == b'first'
    assert not list(tmp_path.glob('.upload-*'))


def test_background_idle_uses_output_stability():
    samples = {}
    output = 'Finished the requested task.\ncontext remaining: 95%'
    assert detect_state(output, 'codex', _background_stability(samples, '1', output, 10)) == 'working'
    assert detect_state(output, 'codex', _background_stability(samples, '1', output, 14)) == 'idle'
    assert detect_state('new output', 'codex', _background_stability(samples, '1', 'new output', 15)) == 'working'
