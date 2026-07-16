import asyncio
from types import SimpleNamespace

from backend import streamer
from backend.streamer import _combine_snapshot, _cursor_suffix, _strip_cursor


# ── get_snapshot must NOT capture history when the pane has none ──
# `capture-pane -E -1` on an empty history clamps to the first SCREEN line, so
# an unguarded history capture duplicates line 1 of every fresh session.

class _FakeTmux:
    def __init__(self, hist_size):
        self.hist_size = hist_size
        self.history_capture_calls = 0

    async def display_info(self, name):
        return {"process": "bash", "created_at": 1, "alt_screen": False}

    async def capture_with_cursor(self, name, ansi=True):
        return "line-1\nline-2\n", (0, 1, True)

    async def history_info(self, name):
        return self.hist_size, 50000

    async def capture_pane(self, name, lines=0, ansi=True, end=None):
        if end == -1:
            self.history_capture_calls += 1
            # what real tmux returns for empty history: the clamped screen line
            return "old-hist\n" if self.hist_size > 0 else "line-1\n"
        return "line-1\nline-2\n"

    async def allow_alt_screen_exit(self, name): pass
    async def clear_alt_screen_override(self, name): pass


def _snapshot_with(monkeypatch, hist_size):
    from backend.sessions import store
    fake = _FakeTmux(hist_size)
    monkeypatch.setattr(streamer, "tmux", fake)
    s = SimpleNamespace(id="t-hist", session_name="term-t-hist", status="running",
                        process="bash", created_at=1, alt_screen=False,
                        ai_state=None, mem_kb=0)
    store.sessions["t-hist"] = s
    try:
        return asyncio.run(streamer.get_snapshot("t-hist", s.session_name)), fake
    finally:
        store.sessions.pop("t-hist", None)


def test_fresh_session_snapshot_skips_history_capture(monkeypatch):
    combined, fake = _snapshot_with(monkeypatch, hist_size=0)
    assert fake.history_capture_calls == 0        # never asks tmux for empty history
    assert combined.count("line-1") == 1          # no duplicated first line


def test_snapshot_with_history_stitches_it_above(monkeypatch):
    combined, fake = _snapshot_with(monkeypatch, hist_size=5)
    assert fake.history_capture_calls >= 1
    assert combined.index("old-hist") < combined.index("line-1")


# ── _combine_snapshot: history above, exact current screen at the bottom ──

def test_combine_history_then_current():
    assert _combine_snapshot("old1\nold2\n", "cur1\ncur2\n") == "old1\r\nold2\r\ncur1\r\ncur2"


def test_combine_empty_history_is_current_only():
    assert _combine_snapshot("", "cur\n") == "cur"


# ── _cursor_suffix: relative move from the end of the written content ──

def test_cursor_none_is_empty():
    assert _cursor_suffix("line1\nline2", None) == ""


def test_cursor_on_last_line():
    # 2 lines, cursor at row 1 (0-based) col 4, visible
    assert _cursor_suffix("line1\nline2", (4, 1, True)) == "\r\x1b[4C\x1b[?25h"


def test_cursor_rows_above():
    # 3 lines, cursor on the first line → up 2
    assert _cursor_suffix("a\nb\nc", (0, 0, True)) == "\r\x1b[2A\x1b[?25h"


def test_cursor_below_content_clamps_down():
    # 1 content line but cursor reported at row 3 (blank rows were stripped)
    assert _cursor_suffix("only", (2, 3, False)) == "\r\x1b[3B\x1b[2C\x1b[?25l"


def test_cursor_hidden_flag():
    assert _cursor_suffix("x", (0, 0, False)).endswith("\x1b[?25l")


def test_cursor_col_zero_emits_no_forward():
    assert "C" not in _cursor_suffix("x", (0, 0, True))


# ── _strip_cursor: diff-noise removal ──

def test_strip_cursor_removes_visibility_and_movement():
    s = "\x1b[?25hhello\x1b[2Aworld\x1b[?25l"
    assert _strip_cursor(s) == "helloworld"


def test_strip_cursor_keeps_colors():
    s = "\x1b[31mred\x1b[0m"
    assert _strip_cursor(s) == s
