import asyncio
import json
from types import SimpleNamespace
from backend import security_audit as module


def test_private_log_omits_unapproved_secret_fields_and_rotates(tmp_path,monkeypatch):
    log=module.Audit(tmp_path/'audit')
    log.write('login',result='denied',password='NEVER_LOG',cookie='NEVER_LOG',body='NEVER_LOG')
    path=tmp_path/'audit/events.jsonl'
    assert 'NEVER_LOG' not in path.read_text()
    assert path.stat().st_mode & 0o777 == 0o600
    assert path.parent.stat().st_mode & 0o777 == 0o700
    monkeypatch.setattr(module,'MAX_BYTES',1)
    log.write('next',result='ready')
    assert (path.parent/'events.1.jsonl').exists()


def test_symlink_and_hardlink_cannot_redirect_audit_writes(tmp_path):
    other=tmp_path/'private';other.write_text('unchanged')
    directory=tmp_path/'audit';directory.mkdir()
    path=directory/'events.jsonl';path.symlink_to(other)
    log=module.Audit(directory);log.write('blocked')
    assert log.failed and other.read_text()=='unchanged'
    path.unlink();path.hardlink_to(other)
    log.write('blocked')
    assert log.failed and other.read_text()=='unchanged'


def test_destination_logs_host_only_and_never_url_credentials_query_or_path(tmp_path,monkeypatch):
    monkeypatch.setattr(module,'audit',module.Audit(tmp_path))
    module.destination('browser.request','https://user:SECRET@example.org/private/path?token=SECRET')
    text=(tmp_path/'events.jsonl').read_text()
    assert 'example.org' in text and 'SECRET' not in text and '/private/' not in text


def test_http_middleware_records_template_and_result_without_payload(tmp_path,monkeypatch):
    monkeypatch.setattr(module,'audit',module.Audit(tmp_path))
    async def app(scope,receive,send):
        scope['route']=SimpleNamespace(path='/api/files/{id}')
        await send({'type':'http.response.start','status':403})
    async def send(_):pass
    scope={'type':'http','method':'GET','path':'/api/files/SECRET','query_string':b'token=SECRET','client':('127.0.0.1',123)}
    asyncio.run(module.AuditMiddleware(app)(scope,None,send))
    data=json.loads((tmp_path/'events.jsonl').read_text())
    assert data['route']=='/api/files/{id}' and data['status']=='403'
    assert 'SECRET' not in json.dumps(data) and '127.0.0.1' not in json.dumps(data)
