from __future__ import annotations

import asyncio
import os
import shlex
import re
from pathlib import Path
from wcwidth import wcwidth

from . import config
from .terminal_geometry import FrameText

TMUX_TIMEOUT = 5.0


async def tmux_run(args: list[str], timeout: float = TMUX_TIMEOUT) -> str:
    proc = await asyncio.create_subprocess_exec(
        "tmux", *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return stdout.decode("utf-8", errors="replace") if proc.returncode == 0 else ""
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except ProcessLookupError:
            pass  # exited between the timeout and the kill — nothing to reap
        return ""


async def is_alive(session_name: str) -> bool:
    proc = await asyncio.create_subprocess_exec(
        "tmux", "has-session", "-t", session_name,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    await proc.wait()
    return proc.returncode == 0


async def capture_pane(session_name: str, lines: int = 50, ansi: bool = True,
                       end: int | None = None) -> str:
    # -S -lines: start `lines` rows up in the scrollback. -E <end>: stop at that
    # row (line 0 = top of the visible screen, negatives = history). `end=-1`
    # captures history ONLY (everything above the current screen).
    args = ["capture-pane", "-t", session_name, "-p", "-S", f"-{lines}"]
    if end is not None:
        args += ["-E", str(end)]
    if ansi:
        args.append("-e")
    return await tmux_run(args)


# Separates capture text from the cursor line in capture_with_cursor's chained
# output. Pane content never contains C0 controls (tmux stores printable cells).
_CURSOR_SENTINEL = "\x01"
_JOINED_SENTINEL = "\x02\n"
_ANSI_CAPTURE = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][0-2A-Z]')


def _with_soft_wraps(body: str, joined: str, cols: int) -> FrameText:
    """Recover only boundaries verified by tmux's -J capture, never by prose heuristics.

    -J preserves padding while joining soft-wrapped rows. Validate each physical
    row against the ordinary capture; on Unicode/version disagreement retain the
    original frame without guessing which explicit newlines could be removed.
    """
    rows = body.removesuffix('\n').split('\n')
    plain = [_ANSI_CAPTURE.sub('', row) for row in rows]
    wrapped, padded, index = [], list(rows), 0
    for logical in joined.removesuffix('\n').split('\n'):
        chunks, current, used = [], '', 0
        for char in logical:
            size = max(0, wcwidth(char, unicode_version='11.0.0'))
            if size and used == cols:
                chunks.append(current); current, used = '', 0
            if used + size > cols:
                return FrameText(body)
            current += char; used += size
        chunks.append(current)
        for offset, chunk in enumerate(chunks):
            if index >= len(rows) or chunk.rstrip(' ') != plain[index].rstrip(' '):
                return FrameText(body)
            if offset < len(chunks)-1:
                wrapped.append(index)
                # Ordinary capture trims spaces at the margin. Restore those
                # verified by -J before a mobile client joins these rows.
                padding = len(chunk) - len(plain[index])
                padded[index] += ' ' * max(0, padding)
            index += 1
    if index != len(rows):
        return FrameText(body)
    return FrameText('\n'.join(padded)+'\n', wrapped)


async def capture_with_cursor(session_name: str, ansi: bool = True, lines: int = 0) -> tuple[str, tuple[int, int, bool] | None]:
    """Screen (optionally with history) + cursor in ONE tmux invocation.

    capture-pane output carries no cursor location, so frames rendered from it
    leave the client cursor at the end of the content — wrong place for typing.
    Chaining display-message onto the same call keeps the per-poll subprocess
    count unchanged. Returns (text, (x, y, visible)) with 0-based viewport
    coords, or (text, None) if the cursor line is missing (e.g. tmux error).
    """
    # Snapshot history and cursor must come from the same tmux command queue,
    # too. Reading the cursor before a second history capture races new output.
    args = ["capture-pane", "-t", session_name, "-p", "-S", f"-{lines}"]
    if ansi:
        args.append("-e")
    args += [";", "display-message", "-t", session_name, "-p", _JOINED_SENTINEL.rstrip('\n'),
             ";", "capture-pane", "-t", session_name, "-p", "-J", "-S", f"-{lines}",
             ";", "display-message", "-t", session_name, "-p",
             _CURSOR_SENTINEL + "#{cursor_x};#{cursor_y};#{cursor_flag};#{pane_width}"]
    raw = await tmux_run(args)
    body, sep, tail = raw.rpartition(_CURSOR_SENTINEL)
    if not sep:
        return raw, None
    parts = tail.strip().split(";")
    original, split, joined = body.partition(_JOINED_SENTINEL)
    if split:
        body = original
    try:
        if split and len(parts) >= 4:
            body = _with_soft_wraps(original, joined, int(parts[3]))
        return body, (int(parts[0]), int(parts[1]), parts[2] == "1")
    except (IndexError, ValueError):
        return body, None


async def history_info(session_name: str) -> tuple[int, int]:
    """(lines currently in the pane's scrollback, pane's scrollback capacity)."""
    raw = (await tmux_run([
        "display-message", "-t", session_name, "-p", "#{history_size}|#{history_limit}"
    ])).strip()
    parts = raw.split("|")
    size = int(parts[0]) if parts and parts[0].isdigit() else 0
    limit = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
    return size, limit


async def send_keys(session_name: str, keys: str, literal: bool = False) -> None:
    args = ["send-keys", "-t", session_name]
    if literal:
        args.append("-l")
    # End tmux options: literal '--' must be sent, and '--help' is text.
    args.append("--")
    args.append(keys)
    await tmux_run(args)


async def resize_window(session_name: str, cols: int, rows: int) -> None:
    await tmux_run(["resize-window", "-t", session_name, "-x", str(cols), "-y", str(rows)])


async def resize_window_height(session_name: str, rows: int) -> None:
    """Resize only height — safe, no scrollback reflow."""
    await tmux_run(["resize-window", "-t", session_name, "-y", str(rows)])


def clean_pane_title(title: str) -> str:
    # OSC titles can carry animated state, not part of the conversation name.
    title = re.sub(r"^[\s✳✻✽✶✢·●]+", "", title.strip())
    title = re.sub(r"^\[\s*[.!•*…]\s*\]\s*(?:(?:Action Required|Working|Thinking|Idle|Done)\s*\|\s*)?", "", title, flags=re.I)
    return title.strip()[:256]


async def display_info(session_name: str) -> dict:
    raw = await tmux_run([
        "display-message", "-t", session_name, "-p",
        "#{pane_current_path}|#{pane_current_command}|#{session_created}|#{pane_pid}|#{alternate_on}|#{pane_title}"
    ])
    parts = raw.strip().split("|", 5)
    return {
        "cwd": parts[0] if len(parts) > 0 else "",
        "process": parts[1] if len(parts) > 1 else "",
        "created_at": int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else 0,
        "pid": int(parts[3]) if len(parts) > 3 and parts[3].isdigit() else 0,
        # 1 while a full-screen app (vim/less/TUI) holds the alternate screen —
        # that buffer has no scrollback, so the client can't scroll it.
        "alt_screen": parts[4] == "1" if len(parts) > 4 else False,
        "auto_title": clean_pane_title(parts[5]) if len(parts) > 5 else "",
    }


async def list_sessions() -> list[dict]:
    raw = await tmux_run(["list-sessions", "-F", "#{session_name}|#{session_created}|#{pane_current_path}"])
    results = []
    for line in raw.strip().splitlines():
        parts = line.split("|")
        if len(parts) >= 3:
            results.append({"sessionName": parts[0], "createdAt": parts[1], "cwd": parts[2]})
    return results


async def pipe_pane_start(session_name: str, fifo_path: str) -> None:
    # tmux runs the pipe-pane command via /bin/sh -c, so the path must be shell-quoted.
    await tmux_run(["pipe-pane", "-t", session_name, f"cat > {shlex.quote(fifo_path)}"])


async def pipe_pane_stop(session_name: str) -> None:
    await tmux_run(["pipe-pane", "-t", session_name])


def _global_option_cmds() -> list[list[str]]:
    # history-limit is copied into a pane at creation time and alternate-screen
    # is checked when an app tries to enter it — both must be set BEFORE the
    # window/command exists to take effect.
    cmds = [["set-option", "-g", "history-limit", str(config.HISTORY_LIMIT)]]
    if config.NO_ALT_SCREEN:
        # Full-screen apps (Claude Code, vim, less) render into the normal
        # buffer instead → real tmux scrollback → client can scroll natively.
        cmds.append(["set-option", "-g", "-w", "alternate-screen", "off"])
    return cmds


async def apply_global_options() -> None:
    """Apply server-wide defaults (no-op if the tmux server isn't running)."""
    for cmd in _global_option_cmds():
        await tmux_run(cmd)


async def allow_alt_screen_exit(session_name: str) -> None:
    # `alternate-screen off` blocks the LEAVE sequence too, so a pane that
    # entered the alt-screen while the option was on gets stuck in it forever
    # (no scrollback accumulates). While a pane is in the alt-screen, a
    # window-LOCAL `on` lets the app's eventual exit be honored; the streamer
    # removes it again once the pane leaves (clear_alt_screen_override).
    await tmux_run(["set-option", "-w", "-t", session_name, "alternate-screen", "on"])


async def clear_alt_screen_override(session_name: str) -> None:
    """Drop the window-local override → back to the global `off` (blocks re-entry)."""
    await tmux_run(["set-option", "-w", "-t", session_name, "-u", "alternate-screen"])


async def new_session(session_name: str, cwd: str, cmd: str) -> None:
    # One chained tmux invocation: start-server ; set options ; new-session.
    # Chaining (";" argv tokens) matters on a cold tmux server — separate
    # set-option calls would fail with "no server running" and the very first
    # session would miss the options.
    args: list[str] = ["start-server"]
    for c in _global_option_cmds():
        args += [";", *c]
    args += [";", "new-session", "-d", "-s", session_name, "-c", cwd, cmd]
    # A cold tmux server (first session ever, or right after the last session
    # died) can take well over the default timeout to fork on a loaded box —
    # the first spawn after "kill all" used to fail spuriously.
    await tmux_run(args, timeout=15.0)


async def kill_session(session_name: str) -> None:
    await tmux_run(["kill-session", "-t", session_name])


async def paste_text(session_name: str, text: str) -> None:
    """Paste multi-line text into a pane via tmux buffer (sends as single block)."""
    tmp = Path(f"/tmp/agentboard-paste-{session_name}")
    tmp.write_text(text)
    await tmux_run(["load-buffer", str(tmp)])
    await tmux_run(["paste-buffer", "-t", session_name, "-d"])
    tmp.unlink(missing_ok=True)


async def pane_size(session_name: str) -> tuple[int, int] | None:
    raw = await tmux_run(['display-message', '-p', '-t', session_name, '#{pane_width};#{pane_height}'])
    try:
        cols, rows = raw.strip().split(';')
        return int(cols), int(rows)
    except (ValueError, TypeError):
        return None
