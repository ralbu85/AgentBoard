import asyncio
from types import SimpleNamespace

from backend import streamer
from backend.streamer import _combine_snapshot, _cursor_suffix, _strip_cursor


# ── get_snapshot must build the body from ONE atomic capture ──
# A separate history (`-E -1`) + visible stitch races while streaming: a line
# scrolling from the visible area into history between the two calls lands in
# both, duplicated on scroll-up. The single `-S -N` capture (no -E) can't dup;
# it also naturally covers empty history (just the visible screen).

class _FakeTmux:
    """Models the streaming race: the visible screen (capture_with_cursor) is a
    T1 view; a later `-E -1` history capture is a T2 view where a visible line
    has already scrolled into history. The atomic `-S -N` capture is one
    consistent view with no overlap."""
    def __init__(self):
        self.end_dash1_calls = 0     # the old racing history call
        self.atomic_calls = 0        # the new single history+visible call

    async def display_info(self, name):
        return {"process": "bash", "created_at": 1, "alt_screen": False}

    async def capture_with_cursor(self, name, ansi=True):
        return "vis-1\nvis-2\n", (0, 1, True)          # T1 visible

    async def history_info(self, name):
        return 5, 50000

    async def capture_pane(self, name, lines=0, ansi=True, end=None):
        if end == -1 and lines <= 5:
            return "vis-2\n"                            # tiny edge probe (growth baseline)
        if end == -1:
            self.end_dash1_calls += 1                   # the old racing history stitch
            return "hist-1\nvis-1\n"                    # T2: vis-1 leaked in → would dup
        self.atomic_calls += 1
        return "hist-1\nvis-1\nvis-2\n"                 # atomic: consistent, no dup

    async def allow_alt_screen_exit(self, name): pass
    async def clear_alt_screen_override(self, name): pass


def _snapshot(monkeypatch):
    from backend.sessions import store
    fake = _FakeTmux()
    monkeypatch.setattr(streamer, "tmux", fake)
    s = SimpleNamespace(id="t-hist", session_name="term-t-hist", status="running",
                        process="bash", created_at=1, alt_screen=False,
                        ai_state=None, mem_kb=0)
    store.sessions["t-hist"] = s
    try:
        return asyncio.run(streamer.get_snapshot("t-hist", s.session_name)), fake
    finally:
        store.sessions.pop("t-hist", None)


def test_snapshot_body_is_one_atomic_capture(monkeypatch):
    combined, fake = _snapshot(monkeypatch)
    assert fake.atomic_calls == 1        # single history+visible capture
    assert fake.end_dash1_calls == 0     # never the racing two-call stitch


def test_snapshot_has_no_duplicated_line(monkeypatch):
    combined, _ = _snapshot(monkeypatch)
    # vis-1 would appear twice with the old racing stitch; atomic capture = once
    assert combined.count("vis-1") == 1
    assert combined.index("hist-1") < combined.index("vis-2")


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
