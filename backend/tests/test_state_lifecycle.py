from types import SimpleNamespace
from backend import streamer
from backend.state_detector import activity_signature


def machine(monkeypatch):
    now = [0.0]
    events = []
    monkeypatch.setattr(streamer._time, 'monotonic', lambda: now[0])
    monkeypatch.setattr(streamer, 'broadcast', events.append)
    monkeypatch.setattr(streamer, '_state_samples', {})
    monkeypatch.setattr(streamer, '_pending_state', {})
    session = SimpleNamespace(ai_state='idle', process='codex', completion_id='', submission_id='')
    def observe(t, text):
        now[0] = t
        streamer._detect_state('test', session, text, 0)
    return session, events, observe


def test_short_redraw_and_busy_flicker_do_not_start_work(monkeypatch):
    session, events, observe = machine(monkeypatch)
    observe(0, 'esc to interrupt')
    observe(.2, 'Done\n›')
    observe(2, 'Done\n›')
    assert session.ai_state == 'idle'
    assert not events


def test_same_completion_is_identified_once_and_new_submission_is_distinct(monkeypatch):
    session, events, observe = machine(monkeypatch)
    observe(0, 'esc to interrupt'); observe(.7, 'esc to interrupt')
    assert session.ai_state == 'working'
    observe(1, 'Answer\n›'); observe(3.1, 'Answer\n›')
    first = session.completion_id
    assert first and session.ai_state == 'idle'
    observe(4, 'esc to interrupt'); observe(4.7, 'esc to interrupt')
    observe(5, 'Answer\n›'); observe(7.1, 'Answer\n›')
    assert session.completion_id == first
    session.submission_id = 'new-user-turn'
    observe(8, 'esc to interrupt'); observe(8.7, 'esc to interrupt')
    observe(9, 'Answer\n›'); observe(11.1, 'Answer\n›')
    assert session.completion_id != first
    assert [e['state'] for e in events] == ['working','idle','working','idle','working','idle']


def test_plain_streaming_requires_sustained_activity_and_completion_requires_quiet(monkeypatch):
    session, events, observe = machine(monkeypatch)
    observe(0, 'output 0'); observe(1, 'output 1'); observe(2, 'output 2')
    assert session.ai_state == 'idle'
    observe(3.1, 'output 3')
    assert session.ai_state == 'working'
    observe(4, 'output 3'); observe(5.2, 'output 3')
    assert session.ai_state == 'working'
    observe(7.3, 'output 3')
    assert session.ai_state == 'idle'


def test_initial_stable_capture_does_not_generate_completion(monkeypatch):
    session, events, observe = machine(monkeypatch)
    session.ai_state = None
    observe(0, 'Existing completed output')
    observe(3, 'Existing completed output')
    assert session.ai_state == 'idle'
    assert not session.completion_id
    assert [e['state'] for e in events] == ['idle']


def test_color_cursor_and_rewrap_are_not_new_activity():
    assert activity_signature('\x1b[32mAnswer\x1b[0m\ntext\x1b[2;3H') == activity_signature('Answer text')
