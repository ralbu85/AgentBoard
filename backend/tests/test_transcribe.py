import asyncio
import sys

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend import config, routes_transcribe, transcribe

# Stands in for whisper_worker.py: "transcribes" a file by reading it, and
# exits on a file that says so, like a worker that crashed.
FAKE_WORKER = '''
import json, os, sys
print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    text = open(json.loads(line)["path"]).read()
    if text == "crash": sys.exit(3)
    reply = {"error": "bad audio"} if text == "bad" else {"text": f"{text} pid={os.getpid()}"}
    print(json.dumps(reply), flush=True)
'''


def client(monkeypatch):
    monkeypatch.setattr(config, 'AUTH_TOKEN', 'fixture')
    app = FastAPI(); app.include_router(routes_transcribe.router)
    return TestClient(app, cookies={'token': 'fixture'})


def test_voice_input_is_hidden_until_a_whisper_python_is_set(monkeypatch):
    monkeypatch.setattr(config, 'WHISPER_PYTHON', '')
    c = client(monkeypatch)
    assert c.get('/api/transcribe').json() == {'available': False}
    assert c.post('/api/transcribe', content=b'x').status_code == 503
    assert TestClient(c.app).post('/api/transcribe', content=b'x').status_code == 401


def test_recording_is_written_out_and_removed(monkeypatch):
    monkeypatch.setattr(config, 'WHISPER_PYTHON', sys.executable)
    seen = []
    async def fake(path):
        seen.append(path); return f'안녕하세요 ({path.read_bytes().decode()})'
    monkeypatch.setattr(routes_transcribe.transcriber, 'transcribe', fake)
    c = client(monkeypatch)
    assert c.get('/api/transcribe').json() == {'available': True}
    assert c.post('/api/transcribe', content=b'opus').json() == {'ok': True, 'text': '안녕하세요 (opus)'}
    assert not seen[0].exists()
    assert c.post('/api/transcribe', content=b'').status_code == 400
    monkeypatch.setattr(routes_transcribe, 'MAX_AUDIO_BYTES', 3)
    assert c.post('/api/transcribe', content=b'long').status_code == 413


def test_one_worker_keeps_the_model_and_a_dead_one_is_replaced(tmp_path, monkeypatch):
    monkeypatch.setattr(config, 'WHISPER_PYTHON', sys.executable)
    worker = tmp_path / 'worker.py'; worker.write_text(FAKE_WORKER)
    audio = tmp_path / 'a.audio'

    async def run():
        t = transcribe.Transcriber(worker)
        async def say(text):
            audio.write_text(text); return await t.transcribe(audio)
        try:
            t.warm(); await t.warming   # loaded while someone speaks
            warmed = t.proc.pid
            first, second = await say('하나'), await say('둘')
            assert first.endswith(f'pid={warmed}')
            assert first.startswith('하나 pid=') and second.split('pid=')[1] == first.split('pid=')[1]
            for broken in ('bad', 'crash'):
                try:
                    await say(broken)
                    raise AssertionError('expected a failure')
                except transcribe.TranscribeError:
                    pass
            third = await say('셋')
            assert third.startswith('셋 pid=') and third.split('pid=')[1] != first.split('pid=')[1]
        finally:
            await t.stop()
        assert t.proc is None
    asyncio.run(run())
