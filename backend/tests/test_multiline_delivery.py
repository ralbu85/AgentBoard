"""Exercise actual PTY bytes on a private tmux socket, never user sessions."""
import asyncio
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from backend import tmux, commands, routes_session
from backend.models import InputRequest
from backend.sessions import Session


@pytest.fixture
def terminal(monkeypatch):
    if not shutil.which('tmux'):
        pytest.skip('tmux is required for isolated PTY integration tests')
    with tempfile.TemporaryDirectory(prefix='ab-input-test-') as directory:
        root = Path(directory)
        socket, output, receiver = root/'socket', root/'received', root/'receiver.py'
        receiver.write_text('''import os, sys, tty
from pathlib import Path
tty.setraw(0)
os.write(1, b'\\x1b[?2004hINPUT-READY')
received = bytearray()
while True:
    data = os.read(0, 65536)
    if not data: break
    received.extend(data)
    Path(sys.argv[1]).write_bytes(received)
''')
        prefix = ['tmux', '-S', str(socket), '-f', '/dev/null']
        env = {**os.environ, 'TMUX': ''}
        subprocess.run([*prefix, 'new-session', '-d', '-s', 'fixture', sys.executable, str(receiver), str(output)],
                       env=env, check=True, capture_output=True)
        original = asyncio.create_subprocess_exec

        async def isolated(program, *args, **kwargs):
            assert program == 'tmux', 'Only the private tmux server is used by this test'
            return await original(*prefix, *args, env=env, **kwargs)

        monkeypatch.setattr(tmux.asyncio, 'create_subprocess_exec', isolated)

        async def ready():
            for _ in range(100):
                if 'INPUT-READY' in await tmux.tmux_run(['capture-pane', '-p', '-t', 'fixture']):
                    return
                await asyncio.sleep(.02)
            raise AssertionError('Synthetic terminal did not initialize')

        try:
            asyncio.run(ready())
            yield output
        finally:
            subprocess.run([*prefix, 'kill-server'], env=env, capture_output=True)


async def delivered(output, expected):
    for _ in range(100):
        if output.exists() and output.read_bytes() == expected:
            return
        await asyncio.sleep(.02)
    assert output.read_bytes() == expected


def sender():
    session = Session(id='1', session_name='fixture', cwd='/test', cmd='synthetic')
    return SimpleNamespace(get=lambda mid: session), SimpleNamespace(poll_now=AsyncMock())


@pytest.mark.parametrize('endpoint', ['input', 'paste'])
def test_send_arrives_as_one_bracketed_message_then_one_enter(terminal, endpoint):
    text = '첫째 --option\n\n  둘째 줄\n' + '긴 문장🙂 ' * 500 + '\n마지막\n'
    expected = b'\x1b[200~' + text.encode() + b'\x1b[201~\r'
    async def scenario():
        store, streamer = sender()
        await commands.apply_command(store, streamer, tmux, {'type': endpoint, 'id': '1', 'text': text})
        await delivered(terminal, expected)
        assert not (await tmux.tmux_run(['list-buffers', '-F', '#{buffer_name}'])).strip()
    asyncio.run(scenario())


def test_simultaneous_device_sends_do_not_mix_messages_or_clipboards(terminal):
    texts = ['기기 하나\n다음 줄', '기기 둘\n\n마지막']
    async def scenario():
        store, streamer = sender()
        await tmux.tmux_run(['set-buffer', '-b', 'keep', 'unrelated clipboard'])
        await asyncio.gather(*(commands.apply_command(store, streamer, tmux, {'type': 'input', 'id': '1', 'text': text}) for text in texts))
        await delivered(terminal, b''.join(b'\x1b[200~' + t.encode() + b'\x1b[201~\r' for t in texts))
        assert (await tmux.tmux_run(['list-buffers', '-F', '#{buffer_name}'])).strip() == 'keep'
        assert await tmux.tmux_run(['show-buffer', '-b', 'keep']) == 'unrelated clipboard'
    asyncio.run(scenario())


def test_missing_target_reports_failure_without_submitting_or_leaving_prompt_buffers(terminal):
    async def scenario():
        with pytest.raises(tmux.TmuxInputError):
            await tmux.paste_text('nonexistent-fixture', 'first\nsecond')
        assert not terminal.exists()
        assert not (await tmux.tmux_run(['list-buffers', '-F', '#{buffer_name}'])).strip()
    asyncio.run(scenario())


def test_failed_paste_does_not_send_enter_or_claim_api_success(monkeypatch):
    store, streamer = sender()
    fake = SimpleNamespace(paste_text=AsyncMock(side_effect=tmux.TmuxInputError('전송 실패')),
                           send_keys=AsyncMock(), TmuxInputError=tmux.TmuxInputError)
    monkeypatch.setattr(routes_session, 'store', store)
    monkeypatch.setattr(routes_session, 'streamer', streamer)
    monkeypatch.setattr(routes_session, 'tmux', fake)
    from fastapi import HTTPException
    for endpoint in (routes_session.input_text, routes_session.paste_text):
        with pytest.raises(HTTPException) as error:
            asyncio.run(endpoint(InputRequest(id='1', text='first\nsecond')))
        assert error.value.status_code == 503
    fake.send_keys.assert_not_awaited()


def test_missing_session_is_not_reported_as_success(monkeypatch):
    monkeypatch.setattr(routes_session, 'store', SimpleNamespace(get=lambda mid: None))
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as error:
        asyncio.run(routes_session.input_text(InputRequest(id='absent', text='first\nsecond')))
    assert error.value.status_code == 503
