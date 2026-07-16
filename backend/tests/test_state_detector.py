from backend.state_detector import detect_state, strip_ansi

# Realistic pane tails. detect_state looks at the last 15 lines.
CLAUDE_BUSY = "✻ Thinking…\n\nesc to interrupt"
CLAUDE_PROMPT = "Some earlier output\n\n❯"
CLAUDE_IDLE_BAR = "output text\n\n? for shortcuts · shift+tab to cycle"
CLAUDE_ASKING = "Do you want to proceed?\n❯ 1. Yes\n  2. No"


# ── waiting beats everything ──

def test_waiting_menu():
    assert detect_state(CLAUDE_ASKING, "claude", 10.0) == "waiting"


def test_waiting_y_n():
    assert detect_state("Overwrite file? (y/n)", "bash", 5.0) == "waiting"


def test_waiting_wins_over_force_working():
    out = "esc to interrupt\nDo you want to proceed?"
    assert detect_state(out, "claude", 0.0) == "waiting"


# ── explicit busy markers ──

def test_force_working_even_when_stable():
    assert detect_state(CLAUDE_BUSY, "claude", 30.0) == "working"


def test_force_working_truncated_marker():
    assert detect_state("… esc to inte", "claude", 30.0) == "working"


# ── velocity-based ──

def test_changing_output_is_working():
    assert detect_state("streaming output...", "claude", 0.1) == "working"


def test_stable_output_is_idle():
    assert detect_state("done.", "claude", 5.0) == "idle"


def test_fast_idle_on_prompt():
    # Prompt visible + >0.5s stable → idle without waiting the full threshold.
    assert detect_state(CLAUDE_PROMPT, "claude", 1.0) == "idle"


def test_fast_idle_on_idle_bar():
    assert detect_state(CLAUDE_IDLE_BAR, "claude", 1.0) == "idle"


def test_no_fast_idle_below_half_second():
    assert detect_state(CLAUDE_PROMPT, "claude", 0.3) == "working"


# ── legacy fallback (stable_seconds unknown) ──

def test_legacy_shell_prompt_is_idle():
    assert detect_state("some output\nuser@host:~$", "bash") == "idle"


def test_legacy_shell_midcommand_is_working():
    assert detect_state("compiling everything...", "bash") == "working"


def test_legacy_agent_output_is_working():
    assert detect_state("Writing tests now", "claude") == "working"


def test_legacy_idle_bar_is_idle():
    assert detect_state(CLAUDE_IDLE_BAR, "claude") == "idle"


# ── edge cases ──

def test_empty_output_is_idle():
    assert detect_state("", "claude", 0.0) == "idle"


def test_ansi_is_stripped_before_matching():
    colored = "\x1b[1m\x1b[32mDo you want to proceed?\x1b[0m"
    assert detect_state(colored, "claude", 5.0) == "waiting"


def test_strip_ansi_removes_sgr_and_osc():
    assert strip_ansi("\x1b[31mred\x1b[0m \x1b]0;title\x07plain") == "red plain"
