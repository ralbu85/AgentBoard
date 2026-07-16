import asyncio
from types import SimpleNamespace

from backend.commands import SEQ_MAP, apply_command

# ── Fakes: apply_command takes store/streamer/tmux as parameters, so the whole
# dispatch layer is testable without tmux or a server. ──

class FakeSession(SimpleNamespace):
    pass


def make_session(id="1"):
    return FakeSession(id=id, session_name=f"term-{id}", display_rows=40)


class FakeStore:
    def __init__(self, sessions=None, fail_spawn=False):
        self.sessions = sessions or {}
        self.fail_spawn = fail_spawn
        self.killed, self.removed_ids, self.titles = [], [], {}

    def get(self, id):
        return self.sessions.get(id)

    async def spawn(self, cwd, cmd, req_id=None):
        if self.fail_spawn:
            raise RuntimeError("boom")
        s = make_session("9")
        self.sessions[s.id] = s
        return s

    async def kill(self, id):
        self.killed.append(id)
        return True

    def remove(self, id):
        self.removed_ids.append(id)

    def set_title(self, id, title):
        self.titles[id] = title


class FakeStreamer:
    def __init__(self):
        self.broadcasts, self.started, self.stopped, self.actives = [], [], [], []
        self.snapshot_data = "SNAP"

    def broadcast(self, msg):
        self.broadcasts.append(msg)

    async def start_stream(self, id, name):
        self.started.append(id)

    async def stop_stream(self, id, name):
        self.stopped.append(id)

    def set_active(self, id, ws_id=0):
        self.actives.append((id, ws_id))

    async def get_snapshot(self, id, name):
        return self.snapshot_data

    async def poll_now(self, id):
        pass


class FakeTmux:
    def __init__(self):
        self.sent, self.resizes, self.pastes = [], [], []

    async def send_keys(self, name, keys, literal=False):
        self.sent.append((keys, literal))

    async def resize_window(self, name, cols, rows):
        self.resizes.append((cols, rows))

    async def paste_text(self, name, text):
        self.pastes.append(text)


def run(msg, sessions=None, fail_spawn=False, reply=None):
    store = FakeStore(sessions, fail_spawn)
    streamer, tmux = FakeStreamer(), FakeTmux()
    result = asyncio.run(apply_command(store, streamer, tmux, msg, reply=reply))
    return result, store, streamer, tmux


# ── spawn ──

def test_spawn_returns_id_and_starts_stream():
    result, _, streamer, _ = run({"type": "spawn", "cwd": "/w", "cmd": "bash"})
    assert result == "9"
    assert streamer.started == ["9"]


def test_spawn_failure_broadcasts_error_with_reqid():
    result, _, streamer, _ = run(
        {"type": "spawn", "cwd": "/w", "cmd": "bash", "reqId": "r1"}, fail_spawn=True)
    assert result is None
    err = streamer.broadcasts[0]
    assert err["type"] == "spawn-error" and err["reqId"] == "r1" and "boom" in err["error"]


# ── kill / remove ──

def test_kill_stops_stream_first():
    s = make_session("1")
    result, store, streamer, _ = run({"type": "kill", "id": "1"}, {"1": s})
    assert result is True
    assert streamer.stopped == ["1"] and store.killed == ["1"]


def test_remove_broadcasts_removed():
    s = make_session("1")
    _, store, streamer, _ = run({"type": "remove", "id": "1"}, {"1": s})
    assert store.removed_ids == ["1"]
    assert {"type": "removed", "id": "1"} in streamer.broadcasts


# ── keys / input ──

def test_key_sent_verbatim():
    s = make_session("1")
    _, _, _, tmux = run({"type": "key", "id": "1", "key": "PageUp"}, {"1": s})
    assert tmux.sent == [("PageUp", False)]


def test_terminal_input_maps_control_bytes():
    s = make_session("1")
    _, _, _, tmux = run({"type": "terminal-input", "id": "1", "data": "\r"}, {"1": s})
    assert tmux.sent == [("Enter", False)]  # mapped to a tmux key name


def test_terminal_input_literal_passthrough():
    s = make_session("1")
    _, _, _, tmux = run({"type": "terminal-input", "id": "1", "data": "hello"}, {"1": s})
    assert tmux.sent == [("hello", True)]  # -l: never interpreted as a key name


def test_seq_map_covers_backspace_variants():
    assert SEQ_MAP["\x7f"] == "BSpace" and SEQ_MAP["\x08"] == "BSpace"


def test_input_sends_each_line_plus_enter():
    s = make_session("1")
    _, _, _, tmux = run({"type": "input", "id": "1", "text": "a\nb"}, {"1": s})
    assert tmux.sent == [("a", True), ("Enter", False), ("b", True), ("Enter", False)]


def test_paste_goes_through_buffer_not_keys():
    s = make_session("1")
    _, _, _, tmux = run({"type": "paste", "id": "1", "text": "x\ny"}, {"1": s})
    assert tmux.pastes == ["x\ny"] and tmux.sent == []


# ── resize bounds ──

def test_resize_valid_applies_and_snapshots():
    s = make_session("1")
    _, _, streamer, tmux = run({"type": "resize", "id": "1", "rows": 50}, {"1": s})
    assert tmux.resizes == [(80, 50)]
    assert any(m["type"] == "snapshot" for m in streamer.broadcasts)


def test_resize_below_canonical_ignored():
    s = make_session("1")
    _, _, _, tmux = run({"type": "resize", "id": "1", "rows": 10}, {"1": s})
    assert tmux.resizes == []


def test_resize_non_int_ignored():
    s = make_session("1")
    _, _, _, tmux = run({"type": "resize", "id": "1", "rows": "50; rm -rf /"}, {"1": s})
    assert tmux.resizes == []


# ── active / title / unknown ──

def test_active_sets_and_replies_snapshot():
    s = make_session("1")
    replies = []

    async def reply(m):
        replies.append(m)

    _, _, streamer, _ = run({"type": "active", "id": "1"}, {"1": s}, reply=reply)
    assert streamer.actives == [("1", 0)]
    assert replies and replies[0]["type"] == "snapshot"


def test_active_empty_deactivates():
    _, _, streamer, _ = run({"type": "active", "id": ""})
    assert streamer.actives == [(None, 0)]


def test_title_stored():
    s = make_session("1")
    _, store, _, _ = run({"type": "title", "id": "1", "title": "학습"}, {"1": s})
    assert store.titles == {"1": "학습"}


def test_unknown_type_is_noop():
    result, _, streamer, tmux = run({"type": "definitely-not-a-command", "id": "1"})
    assert result is None and streamer.broadcasts == [] and tmux.sent == []


def test_missing_session_is_noop():
    _, _, _, tmux = run({"type": "key", "id": "404", "key": "Enter"})
    assert tmux.sent == []
