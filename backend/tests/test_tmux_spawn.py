"""Exercise the real launch command on private tmux sockets, never live panes."""
import asyncio
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from backend import commands, sessions, streamer, tmux
from backend.terminal_geometry import SHARED_SETTLE_SECONDS, Viewports


@pytest.fixture
def isolated_tmux(monkeypatch):
    if not shutil.which('tmux'):
        pytest.skip('tmux is required for the isolated spawn regression test')
    with tempfile.TemporaryDirectory(prefix='ab-spawn-test-') as directory:
        root = Path(directory)
        prefix = ['tmux', '-S', str(root/'socket'), '-f', '/dev/null']
        env = {**os.environ, 'TMUX': ''}
        env.pop('AGENTBOARD_SESSION', None)
        original = asyncio.create_subprocess_exec

        async def isolated(program, *args, **kwargs):
            assert program == 'tmux'
            return await original(*prefix, *args, env=env, **kwargs)

        monkeypatch.setattr(tmux.asyncio, 'create_subprocess_exec', isolated)
        monkeypatch.setattr(sessions.config, 'TITLES_FILE', root/'titles.json')
        try:
            yield root
        finally:
            subprocess.run([*prefix, 'kill-server'], env=env, capture_output=True)


async def wait_for_file(path):
    for _ in range(100):
        if path.is_file():
            return path.read_text()
        await asyncio.sleep(.02)
    raise AssertionError('Private terminal did not execute the test input')


def test_clean_terminal_creation_input_output_and_scoped_environment(isolated_tmux):
    root = isolated_tmux
    cwd = root/"workspace with 'quotes' and spaces"; cwd.mkdir()
    # The clean profile must not execute a startup script or another agent.
    home=root/'home'; home.mkdir()
    (home/'.bashrc').write_text('printf unwanted > '+shlex.quote(str(root/'startup-ran'))+'\n')
    receipt=root/'receipt'

    async def scenario():
        # Keep one unrelated pane in the *private* server. This also exercises
        # a warm-server launch without borrowing any real user's tmux session.
        await tmux.tmux_run(['new-session','-d','-s','unrelated','bash --noprofile --norc'], check=True)
        before=await tmux.tmux_run(['display-message','-p','-t','unrelated','#{pane_pid}'])
        before_env=await tmux.tmux_run(['show-environment','-g'])
        store=sessions.SessionStore(); events=[]; store.set_broadcast(events.append)
        streamer=SimpleNamespace(start_stream=AsyncMock(), broadcast=events.append)
        cmd='HOME='+shlex.quote(str(home))+' bash --noprofile --norc'
        sid=await commands.apply_command(store,streamer,tmux,{'type':'spawn','cwd':str(cwd),'cmd':cmd,'reqId':'test'})
        assert sid is not None
        session=store.get(sid)
        assert await tmux.is_alive(session.session_name)
        # tmux returns before its command shell has exec'd Bash/chdir'd.
        for _ in range(100):
            info=await tmux.display_info(session.session_name)
            if info['process']=='bash' and info['cwd']==str(cwd):
                break
            await asyncio.sleep(.02)
        assert info['process']=='bash' and info['cwd']==str(cwd)
        streamer.start_stream.assert_awaited_once_with(sid,session.session_name)
        assert next(e for e in events if e['type']=='spawned')['reqId']=='test'
        await tmux.paste_text(session.session_name,
            "printf '%s|%s' \"$AGENTBOARD_SESSION\" \"$PWD\" > "+shlex.quote(str(receipt))+"; printf 'SPAWN-READY\\n'")
        await tmux.send_keys(session.session_name,'Enter')
        assert await wait_for_file(receipt) == '1|'+str(cwd)
        output=await tmux.capture_pane(session.session_name,ansi=False)
        assert 'SPAWN-READY' in output
        assert not (root/'startup-ran').exists()
        assert await tmux.tmux_run(['show-environment','-g']) == before_env
        assert await tmux.tmux_run(['display-message','-p','-t','unrelated','#{pane_pid}']) == before
    asyncio.run(scenario())


def test_cold_server_and_compound_profile_keep_environment(isolated_tmux):
    receipt=isolated_tmux/'compound'
    command="true && printf '%s' \"$AGENTBOARD_SESSION\" > "+shlex.quote(str(receipt))+"; exec bash --noprofile --norc"
    async def scenario():
        await tmux.new_session('cold',str(isolated_tmux),command)
        assert await wait_for_file(receipt) == '1'
        assert await tmux.is_alive('cold')
    asyncio.run(scenario())


def test_invalid_folder_reports_spawn_failure_without_publishing_a_session(isolated_tmux):
    async def scenario():
        store=sessions.SessionStore(); events=[]; store.set_broadcast(events.append)
        streamer=SimpleNamespace(start_stream=AsyncMock(),broadcast=events.append)
        result=await commands.apply_command(store,streamer,tmux,{'type':'spawn',
            'cwd':str(isolated_tmux/'missing'),'cmd':'bash --noprofile --norc','reqId':'failed'})
        assert result is None and not store.all()
        assert [e['type'] for e in events]==['spawn-error']
        assert events[0]['reqId']=='failed'
        assert '작업 폴더' in events[0]['error']
        streamer.start_stream.assert_not_awaited()
    asyncio.run(scenario())


def test_real_tmux_windows_converge_on_the_shared_width(isolated_tmux, monkeypatch):
    views = Viewports()
    monkeypatch.setattr(sessions, 'viewports', views)
    monkeypatch.setattr(streamer, 'viewports', views)
    monkeypatch.setattr(streamer, 'broadcast', lambda msg: None)
    async def scenario():
        store = sessions.SessionStore()
        store.broadcast = lambda msg: None
        before = await store.spawn('/tmp', 'sleep 60')
        assert await tmux.pane_size(before.session_name) == (80, 40)
        views.set_shared_width(168)
        views.shared_at -= SHARED_SETTLE_SECONDS
        after = await store.spawn('/tmp', 'sleep 60')
        assert await tmux.pane_size(after.session_name) == (168, 40)
        assert await streamer._align_idle(before.id, before)
        assert await tmux.pane_size(before.session_name) == (168, 40)
        assert before.display_cols == 168 and before.geometry_verified
        assert not await streamer._align_idle(after.id, after)
    asyncio.run(scenario())
