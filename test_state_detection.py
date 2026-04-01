"""
AgentBoard State Detection Test Suite

Tests that AI agent states (idle/working/waiting) are correctly detected
from actual terminal output captured via tmux capture-pane.

Usage:
    # Unit tests only (no live sessions needed):
    backend/.venv/bin/python test_state_detection.py unit

    # Live test with real Claude Code session:
    backend/.venv/bin/python test_state_detection.py live

    # Capture samples from all running sessions:
    backend/.venv/bin/python test_state_detection.py capture
"""

import asyncio
import json
import sys
import time
import subprocess
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from backend.state_detector import detect_state, strip_ansi


# ─── Real terminal output samples ─── #

# Captured from actual Claude Code sessions
SAMPLE_CLAUDE_IDLE_1 = """\
───────────────────────────────────────────────── mail-hwp-claude-integration ──
❯
────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)
"""

SAMPLE_CLAUDE_IDLE_2 = """\
● 네, 로컬도 동기화 완료되었습니다.

─────────────────────────────────────────────────────────────────────────────────
❯
─────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)
"""

SAMPLE_CLAUDE_IDLE_3 = """\
❯
─────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)                  2% until auto-compact
"""

# Claude idle but with "How is Claude doing" feedback prompt
SAMPLE_CLAUDE_IDLE_WITH_FEEDBACK = """\
● How is Claude doing this session? (optional)
  1: Bad    2: Fine   3: Good   0: Dismiss

───────────────────────────────────────────────── mail-hwp-claude-integration ──
❯
────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)
"""

# Claude idle but status bar only visible (no ❯ prompt on screen) — edge case
SAMPLE_CLAUDE_IDLE_NO_PROMPT = """\
─────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)


"""

# Simulated Claude working (reading file, running tool)
SAMPLE_CLAUDE_WORKING_1 = """\
  I'll read the configuration file to understand the current setup.

⏺ Reading backend/config.py…

────────────────────────────────────────────────────────────────────────────────
  Esc to interrupt
"""

SAMPLE_CLAUDE_WORKING_2 = """\
  Let me fix this issue in the state detector.

⏺ Writing to backend/state_detector.py…

────────────────────────────────────────────────────────────────────────────────
  esc to interrupt
"""

SAMPLE_CLAUDE_WORKING_3 = """\
⏺ Bash(npm run build)
  ⎿  Running...

────────────────────────────────────────────────────────────────────────────────
  Esc to interrupt
"""

# Claude working with truncated status bar (narrow terminal)
SAMPLE_CLAUDE_WORKING_TRUNCATED = """\
⏺ Reading backend/streamer.py…

──────────────────────────────────────────────
  esc to inte
"""

# Claude waiting for permission
SAMPLE_CLAUDE_WAITING_PERMISSION = """\
⏺ I need to modify the configuration file.

  Do you want to proceed? (Y/n)
"""

SAMPLE_CLAUDE_WAITING_ALLOW = """\
⏺ Bash(rm -rf node_modules && npm install)

  Allow? (Y/n)
"""

SAMPLE_CLAUDE_WAITING_YESNO = """\
  This will delete existing data.

  Continue? (y/n)
"""

# Claude waiting for interactive menu selection
SAMPLE_CLAUDE_WAITING_MENU = """\
  Which approach should I use?
  ❯ 1. Refactor the existing code
    2. Write new implementation
    3. Both
"""

# Shell prompts (bash/zsh)
SAMPLE_BASH_IDLE = """\
root@machine:/workspace#
"""

SAMPLE_ZSH_IDLE = """\
➜  agentboard git:(main) ✓
"""

SAMPLE_BASH_RUNNING = """\
Building project...
[=====>          ] 35% compiling modules
"""

# Codex idle
SAMPLE_CODEX_IDLE = """\
codex>
"""

# Codex working
SAMPLE_CODEX_WORKING = """\
Thinking...

Reading files:
  src/main.ts
  src/utils.ts
"""

# Edge case: Claude with ANSI escape codes
SAMPLE_CLAUDE_IDLE_ANSI = """\
\x1b[38;5;37m────────────────────────\x1b[39m
\x1b[39m❯ \x1b[7m \x1b[0m\x1b[39m\x1b[49m
\x1b[38;5;37m────────────────────────\x1b[39m
  \x1b[38;5;211m⏵⏵\x1b[39m \x1b[38;5;211mbypass\x1b[39m \x1b[38;5;211mpermissions\x1b[39m \x1b[38;5;211mon\x1b[38;5;246m (shift+tab\x1b[39m \x1b[38;5;246mto\x1b[39m \x1b[38;5;246mcycle)\x1b[39m
"""

# Edge case: Empty output
SAMPLE_EMPTY = ""

# Edge case: Just whitespace
SAMPLE_WHITESPACE = """


"""

# Edge case: Claude "Checking for updates" during startup
SAMPLE_CLAUDE_UPDATING = """\
Checking for updates...
"""

# Edge case: Claude compact notification
SAMPLE_CLAUDE_COMPACT = """\
  Context window 95% full — auto-compacting...

────────────────────────────────────────────────────────────────────────────────
  Esc to interrupt
"""


# ─── Unit Tests ─── #

def test_unit():
    """Test detect_state() with known samples."""
    results = []

    def check(name, output, process, expected, stable_seconds=-1.0):
        actual = detect_state(output, process, stable_seconds)
        ok = actual == expected
        status = "✓" if ok else "✗"
        results.append((name, ok, expected, actual))
        print(f"  {status} {name}: expected={expected}, got={actual}" +
              (f" (stable={stable_seconds}s)" if stable_seconds >= 0 else ""))
        return ok

    # ── Legacy mode (no velocity data, stable_seconds=-1) ──
    print("\n=== Legacy Mode (pattern-only) ===\n")

    check("claude_idle_1", SAMPLE_CLAUDE_IDLE_1, "claude", "idle")
    check("claude_idle_no_prompt", SAMPLE_CLAUDE_IDLE_NO_PROMPT, "claude", "idle")
    check("claude_working_read", SAMPLE_CLAUDE_WORKING_1, "claude", "working")
    check("claude_working_truncated", SAMPLE_CLAUDE_WORKING_TRUNCATED, "claude", "working")
    check("claude_waiting_proceed", SAMPLE_CLAUDE_WAITING_PERMISSION, "claude", "waiting")
    check("claude_waiting_menu", SAMPLE_CLAUDE_WAITING_MENU, "claude", "waiting")
    check("bash_idle", SAMPLE_BASH_IDLE, "bash", "idle")
    check("zsh_idle", SAMPLE_ZSH_IDLE, "zsh", "idle")
    check("bash_running", SAMPLE_BASH_RUNNING, "bash", "working")
    check("codex_idle", SAMPLE_CODEX_IDLE, "codex", "idle")
    check("empty_output", SAMPLE_EMPTY, "claude", "idle")

    # ── Velocity mode: output recently changed (working) ──
    print("\n=== Velocity Mode: Output Just Changed (stable < 2s) ===\n")

    # Just changed 0.1s ago → working (regardless of content)
    check("any_output_just_changed", SAMPLE_CLAUDE_IDLE_1, "claude", "working", stable_seconds=0.1)
    check("bash_output_just_changed", SAMPLE_BASH_IDLE, "bash", "working", stable_seconds=0.1)

    # Changed 1s ago, but shows prompt → still working (threshold is 2s)
    # UNLESS prompt is visible AND stable > 0.5s → early idle detection
    check("prompt_visible_0.8s", SAMPLE_CLAUDE_IDLE_1, "claude", "idle", stable_seconds=0.8)
    check("idle_bar_visible_0.8s", SAMPLE_CLAUDE_IDLE_NO_PROMPT, "claude", "idle", stable_seconds=0.8)
    check("no_prompt_0.8s", SAMPLE_CLAUDE_WORKING_1, "claude", "working", stable_seconds=0.8)

    # Force-working patterns override velocity
    check("esc_to_interrupt_stable", SAMPLE_CLAUDE_COMPACT, "claude", "working", stable_seconds=5.0)

    # ── Velocity mode: output stable (idle) ──
    print("\n=== Velocity Mode: Output Stable (stable > 2s) ===\n")

    check("claude_stable_3s", SAMPLE_CLAUDE_IDLE_1, "claude", "idle", stable_seconds=3.0)
    check("claude_stable_10s", SAMPLE_CLAUDE_IDLE_2, "claude", "idle", stable_seconds=10.0)
    check("bash_stable_5s", SAMPLE_BASH_IDLE, "bash", "idle", stable_seconds=5.0)
    check("unknown_content_stable", SAMPLE_CODEX_WORKING, "codex", "idle", stable_seconds=5.0)

    # ── Velocity mode: waiting always wins ──
    print("\n=== Velocity Mode: Waiting Patterns Always Win ===\n")

    check("waiting_just_changed", SAMPLE_CLAUDE_WAITING_PERMISSION, "claude", "waiting", stable_seconds=0.1)
    check("waiting_stable", SAMPLE_CLAUDE_WAITING_ALLOW, "claude", "waiting", stable_seconds=10.0)
    check("waiting_menu", SAMPLE_CLAUDE_WAITING_MENU, "claude", "waiting", stable_seconds=0.5)

    # Summary
    passed = sum(1 for _, ok, _, _ in results if ok)
    total = len(results)
    failed = [(n, e, a) for n, ok, e, a in results if not ok]

    print(f"\n{'='*50}")
    print(f"Results: {passed}/{total} passed")

    if failed:
        print(f"\nFAILED ({len(failed)}):")
        for name, expected, actual in failed:
            print(f"  ✗ {name}: expected={expected}, got={actual}")

    return len(failed) == 0


# ─── Live Capture Test ─── #

def capture_session(session_name: str) -> str:
    """Capture current terminal output from a tmux session."""
    result = subprocess.run(
        ["tmux", "capture-pane", "-t", session_name, "-p"],
        capture_output=True, text=True, timeout=5
    )
    return result.stdout if result.returncode == 0 else ""


def capture_session_ansi(session_name: str) -> str:
    """Capture with ANSI codes."""
    result = subprocess.run(
        ["tmux", "capture-pane", "-t", session_name, "-p", "-e"],
        capture_output=True, text=True, timeout=5
    )
    return result.stdout if result.returncode == 0 else ""


def test_capture():
    """Capture and analyze state from all running sessions."""
    result = subprocess.run(
        ["tmux", "list-sessions", "-F", "#{session_name}"],
        capture_output=True, text=True, timeout=5
    )
    if result.returncode != 0:
        print("No tmux sessions found")
        return

    sessions = result.stdout.strip().split("\n")

    print(f"\n=== Live Session State Capture ({len(sessions)} sessions) ===\n")

    for name in sessions:
        output = capture_session(name)
        tail = "\n".join(output.strip().splitlines()[-15:]) if output.strip() else ""

        # Guess process type
        process = "claude" if name.startswith("term-") else ""
        if name == "agentboard":
            process = "bash"

        state = detect_state(output, process)

        # Show last 3 lines for context
        last3 = output.strip().splitlines()[-3:] if output.strip() else ["(empty)"]

        print(f"  {name} [{process}] → {state}")
        for line in last3:
            display = line[:80] + ("..." if len(line) > 80 else "")
            print(f"    | {display}")
        print()


# ─── Live State Transition Test ─── #

async def test_live_transitions():
    """
    Test state transitions by sending commands to a Claude Code session
    and monitoring state changes via WebSocket.

    Requires: A running AgentBoard instance + at least one Claude session
    """
    try:
        import websockets
    except ImportError:
        print("Installing websockets...")
        subprocess.run([sys.executable, "-m", "pip", "install", "websockets", "-q"])
        import websockets

    import http.cookies

    # Login to get auth cookie
    port = 3002

    # Get password from .env
    env_path = Path("/root/TermHub/.env")
    password = ""
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            if line.startswith("DASHBOARD_PASSWORD="):
                password = line.split("=", 1)[1].strip().strip('"')

    if not password:
        print("Cannot find DASHBOARD_PASSWORD in /root/TermHub/.env")
        return False

    import urllib.request
    import urllib.parse

    # Login
    login_data = json.dumps({"pw": password}).encode()
    req = urllib.request.Request(
        f"http://localhost:{port}/api/login",
        data=login_data,
        headers={"Content-Type": "application/json"}
    )

    try:
        resp = urllib.request.urlopen(req)
    except Exception as e:
        print(f"Login failed: {e}")
        print("Is AgentBoard running? (./start.sh)")
        return False

    # Extract cookie
    cookie_header = resp.headers.get("Set-Cookie", "")
    token = ""
    for part in cookie_header.split(";"):
        if part.strip().startswith("token="):
            token = part.strip().split("=", 1)[1]

    if not token:
        print("No auth token received")
        return False

    print(f"  ✓ Logged in (token={token[:8]}...)")

    # Get sessions list
    req2 = urllib.request.Request(
        f"http://localhost:{port}/api/workers",
        headers={"Cookie": f"token={token}"}
    )
    resp2 = urllib.request.urlopen(req2)
    workers = json.loads(resp2.read())

    claude_sessions = [w for w in workers if w.get("process", "").startswith("claude")]
    if not claude_sessions:
        # Check all sessions
        print(f"  Sessions: {[w.get('sessionName', w.get('id')) for w in workers]}")
        print("  No Claude sessions found. Using first available session for basic test.")
        if not workers:
            print("  No sessions at all!")
            return False
        test_session = workers[0]
    else:
        test_session = claude_sessions[0]

    sid = test_session["id"]
    sname = test_session.get("sessionName", sid)
    print(f"  Using session: {sname} (id={sid})")

    # Connect WebSocket and monitor state changes
    states_received = []

    async def monitor_ws():
        uri = f"ws://localhost:{port}/ws"
        async with websockets.connect(uri, additional_headers={"Cookie": f"token={token}"}) as ws:
            # Tell server we're watching this session
            await ws.send(json.dumps({"type": "active", "id": str(sid)}))

            start = time.time()
            while time.time() - start < 30:  # 30 second timeout
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=1.0)
                    data = json.loads(msg)
                    if data.get("type") == "aiState" and str(data.get("id")) == str(sid):
                        elapsed = time.time() - start
                        state = data["state"]
                        states_received.append((elapsed, state))
                        print(f"    [{elapsed:.1f}s] aiState → {state}")
                except asyncio.TimeoutError:
                    continue
                except Exception as e:
                    print(f"    WS error: {e}")
                    break

    print(f"\n  Monitoring state changes for 30 seconds...")
    print(f"  (Interact with the session in another terminal to see transitions)\n")

    await monitor_ws()

    print(f"\n  States received: {len(states_received)}")
    if states_received:
        for elapsed, state in states_received:
            print(f"    [{elapsed:.1f}s] {state}")
    else:
        print("    No state changes detected during monitoring period.")
        print("    This might mean:")
        print("    - Session state was stable (not necessarily a bug)")
        print("    - State detection is not triggering broadcasts")
        print("    - Polling is not running for this session")

    return True


# ─── Triggered State Transition Test ─── #

async def test_triggered_transitions():
    """
    Spawn a bash session, send commands to trigger state changes,
    and verify state detection follows correctly.
    """
    import urllib.request

    port = 3002
    env_path = Path("/root/TermHub/.env")
    password = ""
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            if line.startswith("DASHBOARD_PASSWORD="):
                password = line.split("=", 1)[1].strip().strip('"')

    # Login
    login_data = json.dumps({"pw": password}).encode()
    req = urllib.request.Request(
        f"http://localhost:{port}/api/login",
        data=login_data, headers={"Content-Type": "application/json"}
    )
    resp = urllib.request.urlopen(req)
    cookie_header = resp.headers.get("Set-Cookie", "")
    token = ""
    for part in cookie_header.split(";"):
        if part.strip().startswith("token="):
            token = part.strip().split("=", 1)[1]

    print("  ✓ Logged in")

    def api_call(endpoint, data=None):
        url = f"http://localhost:{port}/api/{endpoint}"
        body = json.dumps(data).encode() if data else None
        r = urllib.request.Request(url, data=body,
            headers={"Cookie": f"token={token}", "Content-Type": "application/json"})
        return json.loads(urllib.request.urlopen(r).read())

    # Spawn a test bash session
    print("  Spawning test bash session...")
    res = api_call("spawn", {"cwd": "/tmp", "cmd": "bash"})
    if not res.get("ok"):
        print(f"  ✗ Spawn failed: {res}")
        return False
    sid = str(res["id"])
    sname = res.get("sessionName", "")
    print(f"  ✓ Spawned session: {sname} (id={sid})")

    # Wait for session to appear
    time.sleep(1.5)

    # Connect WebSocket
    try:
        import websockets
    except ImportError:
        subprocess.run([sys.executable, "-m", "pip", "install", "websockets", "-q"])
        import websockets

    states = []
    results = []

    async def monitor_and_trigger():
        uri = f"ws://localhost:{port}/ws"
        async with websockets.connect(uri, additional_headers={"Cookie": f"token={token}"}) as ws:
            await ws.send(json.dumps({"type": "active", "id": sid}))
            time.sleep(0.5)

            # Collect initial state
            start = time.time()

            async def collect_states(duration):
                t0 = time.time()
                while time.time() - t0 < duration:
                    try:
                        msg = await asyncio.wait_for(ws.recv(), timeout=0.5)
                        data = json.loads(msg)
                        if data.get("type") == "aiState" and str(data.get("id")) == sid:
                            elapsed = time.time() - start
                            states.append((elapsed, data["state"]))
                            print(f"    [{elapsed:.1f}s] aiState → {data['state']}")
                    except asyncio.TimeoutError:
                        continue

            # Phase 1: Check initial idle state
            print("\n  Phase 1: Initial state (should be idle)...")
            await collect_states(3)

            # Phase 2: Send a long-running command → should become working
            print("\n  Phase 2: Running 'sleep 5' → should be working...")
            api_call("input", {"id": sid, "text": "sleep 5"})
            await collect_states(3)

            # Phase 3: Wait for sleep to finish → should return to idle
            print("\n  Phase 3: Waiting for completion → should return to idle...")
            await collect_states(5)

            # Phase 4: Send a command with (y/n) prompt simulation
            print("\n  Phase 4: Echo a (Y/n) prompt → should detect waiting...")
            api_call("input", {"id": sid, "text": "echo 'Proceed? (Y/n)'"})
            await collect_states(3)

            # Phase 5: Back to idle after echo completes
            print("\n  Phase 5: Should return to idle...")
            await collect_states(2)

    await monitor_and_trigger()

    # Cleanup: kill the test session
    print(f"\n  Cleaning up session {sid}...")
    try:
        api_call("kill", {"id": sid})
        time.sleep(0.5)
        api_call("remove", {"id": sid})
    except Exception:
        pass

    # Analyze results
    print(f"\n  === Results ===")
    print(f"  Total state changes: {len(states)}")

    state_values = [s for _, s in states]

    # Check if we got basic state transitions
    had_idle = "idle" in state_values
    had_working = "working" in state_values

    print(f"  Detected idle: {'✓' if had_idle else '✗'}")
    print(f"  Detected working: {'✓' if had_working else '✗'}")

    if not had_idle:
        print("  ⚠ Never detected idle — state detector may not recognize bash prompt")
    if not had_working:
        print("  ⚠ Never detected working — polling may not be running for new sessions")

    # The echo '(Y/n)' test is tricky — it's echo output, not a real prompt,
    # so after echo completes the prompt returns and state goes back to idle
    # quickly. The waiting state may be too brief to catch.

    return had_idle and had_working


# ─── Polling Accuracy Test ─── #

def test_polling_accuracy():
    """
    Rapidly capture terminal output and run detect_state() to check
    if state detection is consistent over multiple captures.
    """
    result = subprocess.run(
        ["tmux", "list-sessions", "-F", "#{session_name}"],
        capture_output=True, text=True, timeout=5
    )
    sessions = [s for s in result.stdout.strip().split("\n") if s.startswith("term-")]

    if not sessions:
        print("No term-* sessions found")
        return

    print(f"\n=== Polling Accuracy Test ({len(sessions)} sessions, 10 captures each) ===\n")

    for name in sessions[:5]:  # Test up to 5 sessions
        states = []
        for i in range(10):
            output = capture_session(name)
            state = detect_state(output, "claude")
            states.append(state)
            time.sleep(0.1)

        unique = set(states)
        consistent = len(unique) == 1
        status = "✓" if consistent else "⚠"
        print(f"  {status} {name}: {states[0]} (consistent={consistent}, unique={unique})")

    print()


# ─── Main ─── #

if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "unit"

    if mode == "unit":
        ok = test_unit()
        sys.exit(0 if ok else 1)

    elif mode == "capture":
        test_capture()

    elif mode == "poll":
        test_polling_accuracy()

    elif mode == "live":
        asyncio.run(test_live_transitions())

    elif mode == "trigger":
        ok = asyncio.run(test_triggered_transitions())
        sys.exit(0 if ok else 1)

    elif mode == "all":
        print("=" * 60)
        print("AgentBoard State Detection - Full Test Suite")
        print("=" * 60)

        ok = test_unit()
        print()
        test_capture()
        test_polling_accuracy()

        if not ok:
            print("\n⚠ Unit tests had failures — fix before live testing")
            sys.exit(1)

        print("\nRun 'live' mode separately to test WS state transitions:")
        print(f"  {sys.executable} {__file__} live")

    else:
        print(f"Usage: {sys.argv[0]} [unit|capture|poll|live|all]")
        sys.exit(1)
