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


def test_shared_width_follows_the_window_in_use_not_one_left_open(monkeypatch):
    views=Viewports()
    views.set_shared_width(168)
    assert views.shared_cols==168  # nothing known yet: any desktop may seed it
    views.set_shared_width(240)
    assert views.shared_cols==168  # a forgotten window's heartbeat cannot override
    views.set_shared_width(240,claim=True)
    assert views.shared_cols==240


def test_claim_moves_a_session_to_the_window_in_use():
    views=Viewports()
    views.update('1',10,240)
    views.update('1',20,168)
    assert views.target_columns('1')==240  # an unused second window only fits
    views.update('1',20,168,claim=True)
    assert views.target_columns('1')==168
    views.update('1',10,240)  # the other window's heartbeat does not take it back
    assert views.target_columns('1')==168
    views.update('1',30,None,claim=True)  # a phone never owns the source
    assert views.target_columns('1')==168


def test_idle_target_waits_for_layout_and_for_a_session_just_left(monkeypatch):
    clock=[100.0]
    monkeypatch.setattr(terminal_geometry.time,'monotonic',lambda:clock[0])
    views=Viewports()
    assert views.idle_target('1') is None  # no desktop has reported yet
    views.set_shared_width(168)
    assert views.idle_target('1') is None  # still settling (e.g. a sidebar drag)
    clock[0]+=terminal_geometry.SHARED_SETTLE_SECONDS
    assert views.idle_target('1')==168
    views.update('1',10,101)
    assert views.idle_target('1') is None  # a split pane keeps fitting while shown
    assert views.target_columns('1')==101
    views.release(10)
    clock[0]+=terminal_geometry.RELEASE_GRACE_SECONDS-1
    assert views.idle_target('1') is None  # flipping tabs must not reflow it
    clock[0]+=1
    assert views.idle_target('1')==168


def test_desktop_width_command_is_bounded_and_needs_no_session(monkeypatch):
    views=Viewports();monkeypatch.setattr(commands,'viewports',views)
    store,stream,tmux=FakeStore({}),FakeStreamer(),SizedTmux()
    async def scenario():
        for cols in [True,79,241,'140',None]:
            await commands.apply_command(store,stream,tmux,{'type':'desktop-width','cols':cols,'claim':True})
        assert views.shared_cols is None
        await commands.apply_command(store,stream,tmux,{'type':'desktop-width','cols':168})
        await commands.apply_command(store,stream,tmux,{'type':'desktop-width','cols':200,'claim':'yes'})
        assert views.shared_cols==168
        await commands.apply_command(store,stream,tmux,{'type':'desktop-width','cols':200,'claim':True})
        assert views.shared_cols==200
    asyncio.run(scenario())
    assert not tmux.resizes


def align_fixture(monkeypatch,session_name='term-1'):
    clock=[100.0]
    monkeypatch.setattr(terminal_geometry.time,'monotonic',lambda:clock[0])
    views=Viewports();monkeypatch.setattr(streamer,'viewports',views);monkeypatch.setattr(commands,'viewports',views)
    fake=SizedTmux();monkeypatch.setattr(streamer,'tmux',fake)
    sent=[];monkeypatch.setattr(streamer,'broadcast',sent.append)
    monkeypatch.setattr(streamer,'get_snapshot',AsyncMock(return_value='SNAP'))
    s=make_session();s.id='1';s.session_name=session_name;s.resize_lock=asyncio.Lock()
    views.set_shared_width(168)
    clock[0]+=terminal_geometry.SHARED_SETTLE_SECONDS
    return s,views,fake,sent,clock


def test_idle_session_joins_the_shared_width_and_only_once(monkeypatch):
    s,views,fake,sent,_=align_fixture(monkeypatch)
    async def scenario():
        assert await streamer._align_idle('1',s)
        assert not await streamer._align_idle('1',s)
    asyncio.run(scenario())
    assert fake.resizes==[(168,40)]
    assert s.display_cols==168
    assert sent[-1]['type']=='snapshot' and sent[-1]['cols']==168


def test_alignment_skips_fitted_and_externally_attached_sessions(monkeypatch):
    s,views,fake,_,_=align_fixture(monkeypatch)
    views.update('1',10,101)
    assert not asyncio.run(streamer._align_idle('1',s))
    views.release(10)
    external,_,_,_,_=align_fixture(monkeypatch,session_name='my-own-tmux')
    assert not asyncio.run(streamer._align_idle('1',external))
    assert not fake.resizes


def test_redraw_after_a_resize_is_neither_activity_nor_a_state_change(monkeypatch):
    s,_,_,_,clock=align_fixture(monkeypatch)
    s.ai_state,s.process,s.last_activity_at,s.submission_id='waiting','claude',123.0,''
    monkeypatch.setattr(streamer._time,'monotonic',lambda:clock[0])
    monkeypatch.setattr(streamer,'detect_state',lambda *a:'idle')
    monkeypatch.setitem(streamer._state_samples,'1',('before-redraw',clock[0]))
    sent=[];monkeypatch.setattr(streamer,'broadcast',sent.append)
    monkeypatch.setattr(streamer,'get_snapshot',AsyncMock(return_value=''))
    asyncio.run(streamer._align_idle('1',s))
    streamer._detect_state('1',s,'cleared screen')
    assert s.ai_state=='waiting' and not sent
    clock[0]+=terminal_geometry.REFLOW_QUIET_SECONDS
    streamer._detect_state('1',s,'redrawn at the new width')
    assert s.last_activity_at==123.0  # the first sample after a redraw is a new baseline
    streamer._state_samples.pop('1',None)


def test_shared_width_is_relayed_to_every_agent(monkeypatch):
    views=Viewports();monkeypatch.setattr(commands,'viewports',views)
    send=AsyncMock(return_value=True)
    monkeypatch.setattr(ws.registry,'send',send)
    monkeypatch.setattr(ws.registry,'all_hosts',lambda:[{'host':'office'},{'host':'lab'}])
    asyncio.run(ws._handle_msg({'type':'desktop-width','cols':168,'claim':True},SimpleNamespace()))
    assert [c.args[0] for c in send.call_args_list]==['office','lab']
    assert send.call_args.args[1]['cols']==168 and send.call_args.args[1]['claim'] is True
    assert views.shared_cols==168


def test_new_session_starts_at_the_shared_width(monkeypatch):
    from backend import sessions
    views=Viewports();views.set_shared_width(168);monkeypatch.setattr(sessions,'viewports',views)
    fake=SimpleNamespace(new_session=AsyncMock(),is_alive=AsyncMock(return_value=True),resize_window=AsyncMock())
    monkeypatch.setattr(sessions,'tmux',fake)
    store=sessions.SessionStore()
    store.broadcast=lambda msg:None
    s=asyncio.run(store.spawn('/tmp','bash'))
    assert fake.resize_window.call_args.args==(s.session_name,168,40)
    assert s.display_cols==168
