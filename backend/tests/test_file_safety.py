import asyncio
import hashlib
from pathlib import Path

from starlette.requests import Request
from backend import routes_file, config
from backend.models import FileWriteRequest, NotesSaveRequest
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


def test_file_stat_changes_with_every_write_and_stays_contained(tmp_path, monkeypatch):
    monkeypatch.setattr(config, 'ALLOWED_ROOTS', [tmp_path])
    path = tmp_path / 'deck.html'
    path.write_text('<h1>a</h1>')
    first = asyncio.run(routes_file.file_stat(str(path)))['signature']
    read = asyncio.run(routes_file.read_file(str(path)))
    asyncio.run(routes_file.write_file(FileWriteRequest(path=str(path), content='<h1>b</h1>', expectedVersion=read['version'])))
    assert asyncio.run(routes_file.file_stat(str(path)))['signature'] != first
    assert asyncio.run(routes_file.file_stat(str(tmp_path / 'gone.html'))).status_code == 404
    assert asyncio.run(routes_file.file_stat(str(tmp_path))).status_code == 404
    assert asyncio.run(routes_file.file_stat('/etc/passwd')).status_code == 403


def upload_request(body):
    async def receive():
        return {'type': 'http.request', 'body': body, 'more_body': False}
    return Request({'type': 'http', 'method': 'POST', 'path': '/'}, receive)


def test_pdf_memos_are_kept_beside_the_file_and_replaced_whole(tmp_path, monkeypatch):
    monkeypatch.setattr(config, 'ALLOWED_ROOTS', [tmp_path])
    monkeypatch.setattr(routes_file, 'NOTES_DIR', tmp_path / 'notes')
    pdf = tmp_path / 'paper.pdf'
    pdf.write_bytes(b'%PDF-1.7')
    memo = {'id': 'a', 'kind': 'text', 'page': 2, 'rects': [[0.1, 0.2, 0.3, 0.02]], 'text': '수정', 'quote': 'the model', 'created': 1}
    for notes in ([memo], [memo, {**memo, 'id': 'b'}]):
        assert asyncio.run(routes_file.save_notes(NotesSaveRequest(path=str(pdf), notes=notes))) == {'ok': True}
    assert asyncio.run(routes_file.get_notes(str(pdf)))['notes'] == [memo, {**memo, 'id': 'b'}]
    assert pdf.read_bytes() == b'%PDF-1.7'                                   # the PDF itself is untouched
    assert [f.suffix for f in (tmp_path / 'notes').iterdir()] == ['.json']   # no temporary left behind


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
