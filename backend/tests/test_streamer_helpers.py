from backend.streamer import _combine_snapshot, _cursor_suffix, _strip_cursor


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
