import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock
from backend import commands, terminal_geometry, streamer, ws
from backend.terminal_geometry import Viewports
from backend.tests.test_commands import FakeStore, FakeStreamer, FakeTmux, make_session

class SizedTmux(FakeTmux):
    async def pane_size(self, name):
        return self.resizes[-1] if self.resizes else (80, 40)


def test_mobile_never_resizes_the_process_and_desktop_keeps_auto_width(monkeypatch):
    views=Viewports()
    monkeypatch.setattr(commands,'viewports',views)
    s=make_session()
    store,stream,tmux=FakeStore({'1':s}),FakeStreamer(),SizedTmux()
    async def command(client,kind='viewport',device='desktop',cols=160):
        await commands.apply_command(store,stream,tmux,{'type':kind,'id':'1','device':device,'cols':cols},ws_id=client)
    async def scenario():
        await command(2)
        assert tmux.resizes==[(160,40)]
        await command(1,device='mobile',cols=60)
        assert tmux.resizes==[(160,40)]
        await command(3,cols=100)
        await command(2,cols=190)
        await command(1,device='mobile',cols=45)
        assert tmux.resizes==[(160,40),(190,40)]
        await command(1,kind='active')
        assert stream.broadcasts[-1]['cols']==190
        await command(1,kind='viewport-release')
        await command(3,cols=100)
        assert tmux.resizes[-1]==(190,40)  # the original desktop retains control
        await command(2,kind='viewport-release')
        await command(3,cols=100)
        assert tmux.resizes==[(160,40),(190,40),(100,40)]
        assert stream.broadcasts[-1]['cols']==100
        assert stream.broadcasts[-1]['gridVersion']==3
    asyncio.run(scenario())


def test_geometry_bounds_and_actual_size_verification(monkeypatch):
    views=Viewports();monkeypatch.setattr(commands,'viewports',views)
    s=make_session();store,stream,tmux=FakeStore({'1':s}),FakeStreamer(),SizedTmux()
    tmux.pane_size=AsyncMock(return_value=(80,40))
    async def scenario():
        for cols in [True,5,241,'140']:
            await commands.apply_command(store,stream,tmux,{'type':'viewport','id':'1','device':'desktop','cols':cols},ws_id=1)
        assert not tmux.resizes
        await commands.apply_command(store,stream,tmux,{'type':'viewport','id':'1','device':'desktop','cols':160},ws_id=1)
        assert s.display_cols==80
        assert stream.broadcasts[-1]['cols']==80
        assert not s.resizing
    asyncio.run(scenario())


def test_disconnect_and_expired_owners_release_control(monkeypatch):
    clock=[0.0]
    monkeypatch.setattr(terminal_geometry.time,'monotonic',lambda:clock[0])
    views=Viewports()
    assert views.update('1',10,150)
    assert not views.update('1',20,120)
    views.release(10)
    assert views.update('1',20,120)
    clock[0]=16
    assert views.update('1',30,100)
    assert set(views.viewers('1'))=={30}
    assert not views.update('1',30,None)
    assert views.update('1',40,140)


def test_mobile_first_multiple_phones_expiry_and_other_sessions(monkeypatch):
    clock=[0.0]
    monkeypatch.setattr(terminal_geometry.time,'monotonic',lambda:clock[0])
    views=Viewports()
    views.update('1',10,None)
    views.update('1',11,None)
    assert views.target_columns('1') is None
    views.update('1',20,180)
    views.update('2',20,160)
    assert views.target_columns('1')==180
    assert views.target_columns('2')==160
    views.release(10)
    assert views.target_columns('1')==180
    clock[0]=10
    views.update('1',20,180)
    clock[0]=16  # backgrounded/dead phone no longer sends heartbeats
    assert views.target_columns('1')==180
    views.release(20)
    assert views.target_columns('1') is None


def test_unverified_resize_pauses_frames_and_retries_on_next_viewport(monkeypatch):
    views=Viewports();monkeypatch.setattr(commands,'viewports',views)
    s=make_session();store,stream,tmux=FakeStore({'1':s}),FakeStreamer(),SizedTmux()
    tmux.pane_size=AsyncMock(side_effect=[None,(80,40)])
    async def scenario():
        await commands.apply_command(store,stream,tmux,{'type':'viewport','id':'1','device':'desktop','cols':160},ws_id=1)
        assert not stream.broadcasts
        assert not terminal_geometry.stable(s,s.grid_revision)
        # Returning to the last known width still requires verification.
        await commands.apply_command(store,stream,tmux,{'type':'viewport','id':'1','device':'desktop','cols':80},ws_id=1)
        assert tmux.resizes==[(160,40),(80,40)]
        assert terminal_geometry.stable(s,s.grid_revision)
        assert stream.broadcasts[-1]['cols']==80
    asyncio.run(scenario())


def test_mobile_can_reverify_recovered_geometry_without_resizing(monkeypatch):
    views=Viewports();monkeypatch.setattr(commands,'viewports',views)
    s=make_session();s.geometry_verified=False
    store,stream,tmux=FakeStore({'1':s}),FakeStreamer(),SizedTmux()
    tmux.pane_size=AsyncMock(return_value=(163,40))
    asyncio.run(commands.apply_command(store,stream,tmux,{'type':'viewport','id':'1','device':'mobile'},ws_id=1))
    assert not tmux.resizes
    assert s.geometry_verified and s.display_cols==163
    assert stream.broadcasts[-1]['cols']==163


def test_snapshot_drops_capture_that_overlaps_width_change(monkeypatch):
    from backend import sessions
    from backend.tests.test_streamer_helpers import _FakeTmux
    s=SimpleNamespace(id='fixture',session_name='fixture',grid_revision=1,resizing=False)
    fake=_FakeTmux()
    async def racing_capture(*args,**kwargs):
        s.grid_revision+=1
        return 'old-width\n', None
    fake.capture_with_cursor=racing_capture
    monkeypatch.setattr(streamer,'tmux',fake)
    monkeypatch.setattr(sessions,'store',SimpleNamespace(get=lambda _:s))
    assert asyncio.run(streamer.get_snapshot('fixture','fixture'))==''


def test_remote_viewport_uses_browser_identity_and_tracks_split_view(monkeypatch):
    fake_ws=SimpleNamespace()
    send=AsyncMock(return_value=True)
    monkeypatch.setattr(ws.registry,'send',send)
    monkeypatch.setattr(ws,'_ws_viewports',{})
    asyncio.run(ws._handle_msg({'type':'viewport','id':'remote:7','device':'desktop','cols':130,'wsId':999},fake_ws))
    assert send.call_args.args==('remote',{'type':'viewport','id':'7','device':'desktop','cols':130,'wsId':id(fake_ws)})
    assert ws._ws_viewports[id(fake_ws)]=={('remote','7')}
    asyncio.run(ws._handle_msg({'type':'viewport-release','id':'remote:7'},fake_ws))
    assert not ws._ws_viewports[id(fake_ws)]
