from __future__ import annotations

import asyncio
import os
import shlex
from pathlib import Path

TMUX_TIMEOUT = 5.0


async def tmux_run(args: list[str]) -> str:
    proc = await asyncio.create_subprocess_exec(
        "tmux", *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=TMUX_TIMEOUT)
        return stdout.decode("utf-8", errors="replace") if proc.returncode == 0 else ""
    except asyncio.TimeoutError:
        proc.kill()
        return ""


async def is_alive(session_name: str) -> bool:
    proc = await asyncio.create_subprocess_exec(
        "tmux", "has-session", "-t", session_name,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    await proc.wait()
    return proc.returncode == 0


async def capture_pane(session_name: str, lines: int = 50, ansi: bool = True) -> str:
    args = ["capture-pane", "-t", session_name, "-p", "-S", f"-{lines}"]
    if ansi:
        args.append("-e")
    return await tmux_run(args)


async def history_size(session_name: str) -> int:
    """Number of lines currently in the pane's scrollback (above visible area)."""
    raw = (await tmux_run(["display-message", "-t", session_name, "-p", "#{history_size}"])).strip()
    return int(raw) if raw.isdigit() else 0


async def send_keys(session_name: str, keys: str, literal: bool = False) -> None:
    args = ["send-keys", "-t", session_name]
    if literal:
        args.append("-l")
    args.append(keys)
    await tmux_run(args)


async def resize_window(session_name: str, cols: int, rows: int) -> None:
    await tmux_run(["resize-window", "-t", session_name, "-x", str(cols), "-y", str(rows)])


async def resize_window_height(session_name: str, rows: int) -> None:
    """Resize only height — safe, no scrollback reflow."""
    await tmux_run(["resize-window", "-t", session_name, "-y", str(rows)])


async def display_info(session_name: str) -> dict:
    raw = await tmux_run([
        "display-message", "-t", session_name, "-p",
        "#{pane_current_path}|#{pane_current_command}|#{session_created}|#{pane_pid}"
    ])
    parts = raw.strip().split("|")
    return {
        "cwd": parts[0] if len(parts) > 0 else "",
        "process": parts[1] if len(parts) > 1 else "",
        "created_at": int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else 0,
        "pid": int(parts[3]) if len(parts) > 3 and parts[3].isdigit() else 0,
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


async def new_session(session_name: str, cwd: str, cmd: str) -> None:
    await tmux_run(["new-session", "-d", "-s", session_name, "-c", cwd, cmd])


async def kill_session(session_name: str) -> None:
    await tmux_run(["kill-session", "-t", session_name])


async def paste_text(session_name: str, text: str) -> None:
    """Paste multi-line text into a pane via tmux buffer (sends as single block)."""
    tmp = Path(f"/tmp/agentboard-paste-{session_name}")
    tmp.write_text(text)
    await tmux_run(["load-buffer", str(tmp)])
    await tmux_run(["paste-buffer", "-t", session_name, "-d"])
    tmp.unlink(missing_ok=True)
