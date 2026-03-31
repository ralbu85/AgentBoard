import re

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07|\x1b[()][AB012]")


def strip_ansi(text: str) -> str:
    return _ANSI_RE.sub("", text)


_WAITING_PATTERNS = [
    "Do you want to proceed?",
    "Allow?",
    "(Y/n)", "(y/n)", "[Y/n]", "[y/n]",
    "? Yes",
    "? No",
    "❯ 1.",
    "press Enter",
    "Press Enter",
]

_WORKING_PATTERNS = [
    "Esc to cancel",
    "esc to interrupt",
    "Esc to interrupt",
    "esc to inte",
    "Checking for updates",
]

_CLAUDE_IDLE_PATTERNS = [
    "bypass permissions",
    "shift+tab to cycle",
    "auto-compact",
]

_IDLE_PATTERNS = [
    r"[\$#%❯›»>]\s*$",
]

_IDLE_RE = [re.compile(p) for p in _IDLE_PATTERNS]


def detect_state(output: str, process: str = "") -> str:
    cleaned = strip_ansi(output)
    lines = cleaned.strip().splitlines()
    if not lines:
        return "idle"

    tail = "\n".join(lines[-15:])

    # Claude Code: check idle first — status bar may contain truncated
    # "esc to inte…" even when idle, so we look for the ❯ prompt
    if process == "claude":
        has_prompt = any("❯" in line for line in lines[-6:])
        has_idle_bar = any(p in tail for p in _CLAUDE_IDLE_PATTERNS)
        if has_prompt or has_idle_bar:
            # Truly working Claude shows "Esc to interrupt" WITHOUT a ❯ prompt
            if has_prompt:
                return "idle"
            # Has idle bar patterns but no prompt — check for working indicators
            for p in _WORKING_PATTERNS:
                if p in tail:
                    return "working"
            return "idle"

    for p in _WAITING_PATTERNS:
        if p in tail:
            return "waiting"

    # Shell process: check if last line looks like a prompt (idle)
    # but only after ruling out waiting patterns above
    if process in ("bash", "zsh", "fish", "sh", "dash", "ksh", "tcsh", "csh"):
        last_line = lines[-1].strip()
        for r in _IDLE_RE:
            if r.search(last_line):
                return "idle"
        # Shell with no prompt visible — likely running a command
        if last_line:
            return "working"
        return "idle"

    for p in _WORKING_PATTERNS:
        if p in tail:
            return "working"

    last_line = lines[-1].strip()
    for r in _IDLE_RE:
        if r.search(last_line):
            return "idle"

    return "working"
