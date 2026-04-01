"""
Agent state detection — velocity-based approach.

Primary signal: Is terminal output changing?
  - Changing → working
  - Stable → idle or waiting

Secondary signal: Pattern matching (only for idle vs waiting distinction,
and as override for slow-output working states).

This approach works universally for any agent, not just Claude Code.
"""
import re

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07|\x1b[()][AB012]")


def strip_ansi(text: str) -> str:
    return _ANSI_RE.sub("", text)


# ── Patterns ──

# Waiting: agent is asking user a question
_WAITING_PATTERNS = [
    "Do you want to proceed?",
    "Allow?",
    "(Y/n)", "(y/n)", "[Y/n]", "[y/n]",
    "? Yes",
    "? No",
    "❯ 1.",              # Interactive menu
    "press Enter",
    "Press Enter",
]

# Force-working: agent explicitly shows it's busy
# (override for when output is momentarily stable during slow operations)
_FORCE_WORKING = [
    "Esc to cancel",
    "esc to interrupt",
    "Esc to interrupt",
    "esc to inte",       # truncated in narrow terminal
    "Checking for updates",
]

# Prompt patterns that indicate idle
_PROMPT_RE = [
    re.compile(r"[\$#%❯›»>➜→]\s*$"),
    re.compile(r"➜\s+\S+"),              # zsh theme: ➜  project git:(main)
    re.compile(r"codex>\s*$"),            # Codex CLI
]

# Idle bar patterns (Claude Code specific, useful as secondary signal)
_IDLE_BAR = [
    "bypass permissions",
    "shift+tab to cycle",
    "auto-compact",
]

# Seconds of stable output before considering idle
STABLE_THRESHOLD = 2.0


def detect_state(output: str, process: str = "", stable_seconds: float = -1.0) -> str:
    """
    Detect agent state.

    Args:
        output: Terminal pane content (may include ANSI codes).
        process: Foreground process name (e.g. 'claude', 'bash').
        stable_seconds: Seconds since last output change.
                        -1 = unknown (legacy fallback to pure pattern matching).
    """
    cleaned = strip_ansi(output)
    lines = cleaned.strip().splitlines()
    if not lines:
        return "idle"

    tail = "\n".join(lines[-15:])
    last_line = lines[-1].strip()

    # ── 1. Waiting always wins ──
    for p in _WAITING_PATTERNS:
        if p in tail:
            return "waiting"

    # ── 2. Explicit working patterns (agent says it's busy) ──
    has_force_working = any(p in tail for p in _FORCE_WORKING)
    if has_force_working:
        return "working"

    # ── 3. Velocity-based detection ──
    if stable_seconds >= 0:
        # Output actively changing → working
        if stable_seconds < STABLE_THRESHOLD:
            # Exception: if we see a prompt in the last line AND idle bar,
            # the agent just finished — go straight to idle without waiting
            # for the full threshold (faster idle detection)
            if stable_seconds > 0.5:
                if _is_prompt(last_line, process):
                    return "idle"
                if any(p in tail for p in _IDLE_BAR):
                    return "idle"
            return "working"

        # Output has been stable → idle
        return "idle"

    # ── 4. Legacy fallback (no velocity data) ──
    # Used by background poller when stable_seconds is unknown

    # Idle bar or prompt → idle
    if any(p in tail for p in _IDLE_BAR):
        return "idle"

    if process in ("bash", "zsh", "fish", "sh", "dash", "ksh", "tcsh", "csh"):
        if _is_prompt(last_line, process):
            return "idle"
        return "working" if last_line else "idle"

    if _is_prompt(last_line, process):
        return "idle"

    return "working"


def _is_prompt(last_line: str, process: str) -> bool:
    """Check if a line looks like a shell/agent prompt."""
    if not last_line:
        return True
    for r in _PROMPT_RE:
        if r.search(last_line):
            return True
    return False
