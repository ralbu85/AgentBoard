import asyncio
from unittest.mock import AsyncMock
from backend import tmux, streamer
from backend.terminal_geometry import FrameText, frame_meta


def test_verified_source_wraps_preserve_margin_spaces_and_explicit_newlines():
    body='alpha beta\n gamma\nEXPLICIT\nnext\n'
    frame=tmux._with_soft_wraps(body,'alpha beta gamma\nEXPLICIT\nnext\n',10)
    assert frame.wrapped_rows == [0]
    assert str(frame)==body
    # Spaces trimmed by ordinary capture are restored only where -J confirms them.
    frame=tmux._with_soft_wraps('12345678\nnext\n','12345678  next\n',10)
    assert frame.wrapped_rows == [0]
    assert str(frame)=='12345678  \nnext\n'


def test_cjk_wraps_and_inconsistent_capture_fail_closed():
    frame=tmux._with_soft_wraps('한글AB\n끝\n','한글AB끝\n',6)
    assert frame.wrapped_rows == [0]
    assert str(frame)=='한글AB\n끝\n'
    original='original\n'
    failed=tmux._with_soft_wraps(original,'changed output\n',80)
    assert failed.wrapped_rows is None and str(failed)==original


def test_rows_a_resize_rewrapped_still_verify():
    # After a resize tmux's reflow moves a wide glyph that missed the last column
    # to the next row with no padding cell in -J, and -J folds an empty
    # continuation row (left by an app's redraw) into the line above. Either
    # used to drop every wrap in the frame, so tables there couldn't be refitted.
    frame=tmux._with_soft_wraps('한글A\n끝\n','한글A끝\n',6)
    assert frame.wrapped_rows == [0]
    assert str(frame)=='한글A\n끝\n'
    frame=tmux._with_soft_wraps('│ a │ b\n\nnext\n','│ a │ b \nnext\n',8)
    assert frame.wrapped_rows == [0]
    assert str(frame)=='│ a │ b\n\nnext\n'
    # An empty row -J does keep is an explicit blank line, not a continuation.
    assert tmux._with_soft_wraps('text\n\nnext\n','text\n\nnext\n',8).wrapped_rows == []


def test_ambiguous_margin_spaces_are_preserved_instead_of_changing_words():
    # Older tmux exports both a written space and an unused cell before a wide
    # glyph as ' '. There is no evidence allowing us to delete either one.
    frame=tmux._with_soft_wraps('한글A\n끝\n','한글A 끝\n',6)
    assert frame.wrapped_rows == [0]
    assert str(frame)=='한글A \n끝\n'


def test_malformed_cursor_cannot_leak_the_joined_auxiliary_capture(monkeypatch):
    monkeypatch.setattr(tmux,'tmux_run',AsyncMock(return_value='text\n\x02\ntext\n\x01bad;cursor;1;bad\n'))
    body,cursor=asyncio.run(tmux.capture_with_cursor('owned-fixture'))
    assert body=='text\n' and cursor is None


def test_capture_and_wire_metadata_keep_body_cursor_and_wraps_together(monkeypatch):
    run=AsyncMock(return_value='1234567890\ntail\n\x02\n1234567890tail\n\x012;1;1;10\n')
    monkeypatch.setattr(tmux,'tmux_run',run)
    body,cursor=asyncio.run(tmux.capture_with_cursor('owned-fixture'))
    assert body.wrapped_rows == [0]
    assert cursor == (2,1,True)
    assert frame_meta(None,body)['wrappedRows']==[0]
    run.assert_awaited_once()
    assert '-J' in run.call_args.args[0]


def test_snapshot_and_broadcast_preserve_wrap_metadata(monkeypatch):
    capture=AsyncMock(return_value=(FrameText('1234567890\ntail\n',[0]),(2,1,True)))
    monkeypatch.setattr(streamer.tmux,'capture_with_cursor',capture)
    data,_,_=asyncio.run(streamer._capture_snapshot('owned-fixture',False,2))
    events=[];monkeypatch.setattr(streamer,'_broadcast',events.append)
    streamer.broadcast({'type':'snapshot','id':'fixture','data':data})
    assert events[0]['wrappedRows']==[0]
    assert events[0]['data'].startswith('1234567890\r\ntail')


def test_identical_cells_with_new_wrap_boundaries_are_broadcast(monkeypatch):
    from types import SimpleNamespace
    from backend.sessions import store
    sid='owned-wrap-change'
    monkeypatch.setitem(store.sessions,sid,SimpleNamespace(session_name=sid,status='running'))
    for name in ('_last_screen','_last_cursor','_last_wraps','_last_change_at','_last_state_check'):
        monkeypatch.setattr(streamer,name,{})
    capture=AsyncMock(side_effect=[(FrameText('same\ntext\n',rows),(0,1,True)) for rows in ([],[0],[0])])
    monkeypatch.setattr(streamer.tmux,'capture_with_cursor',capture)
    monkeypatch.setattr(streamer,'_detect_state',lambda *args:None)
    events=[];monkeypatch.setattr(streamer,'_broadcast',events.append)
    for _ in range(3):
        asyncio.run(streamer.poll_now(sid))
    assert [event['wrappedRows'] for event in events]==[[],[0]]
