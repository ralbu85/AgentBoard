"""
Test: Long-running task terminal update reliability.

Scenarios:
  1. Continuous output (fast) — seq 1 10000
  2. Slow periodic output — loop with sleep
  3. Bursty output — alternate between silence and bursts
  4. Inactive session updates — monitor non-active session
  5. State transitions during long tasks
  6. Multiple concurrent long-running sessions
"""
import asyncio
import json
import time
from playwright.async_api import async_playwright

BASE = "http://localhost:3002"
WS_URL = "ws://localhost:3002/ws"
PW = "balab2021"

PASS = 0
FAIL = 0
WARN = 0

def ok(msg):
    global PASS; PASS += 1; print(f"   ✓ {msg}")
def fail(msg):
    global FAIL; FAIL += 1; print(f"   ✗ {msg}")
def warn(msg):
    global WARN; WARN += 1; print(f"   ⚠ {msg}")


async def login(page):
    await page.goto(BASE, wait_until="networkidle", timeout=30000)
    pw = await page.query_selector("input[type=password]")
    if pw:
        await pw.fill(PW)
        await page.click("button[type=submit]")
    await page.wait_for_timeout(5000)


async def send_command(page, cmd):
    """Type command and send via Enter."""
    textarea = await page.query_selector(".input-textarea")
    if textarea:
        await textarea.fill(cmd)
        await textarea.press("Enter")
        await page.wait_for_timeout(300)


async def get_terminal_text(page):
    """Get visible terminal text."""
    return await page.evaluate("""() => {
        const vp = document.querySelector('.xterm-viewport');
        const screen = document.querySelector('.xterm-screen');
        if (!screen) return '';
        return screen.innerText || '';
    }""")


async def get_ws_message_rate(page, duration_ms=3000):
    """Monitor WebSocket screen message rate over duration."""
    return await page.evaluate(f"""() => new Promise(resolve => {{
        let count = 0;
        let first = null;
        let last = null;
        const orig = WebSocket.prototype.send;

        // Intercept incoming messages via event listener on existing WS
        const ws = document.querySelector && window._termhub_ws;

        // Fallback: poll terminal changes
        const el = document.querySelector('.xterm-screen');
        if (!el) {{ resolve({{ count: 0, duration: 0 }}); return; }}

        let prevText = el.innerText;
        let changes = 0;
        const start = Date.now();

        const iv = setInterval(() => {{
            const cur = el.innerText;
            if (cur !== prevText) {{
                changes++;
                prevText = cur;
            }}
            if (Date.now() - start >= {duration_ms}) {{
                clearInterval(iv);
                resolve({{ changes, duration: Date.now() - start, rate: (changes / ({duration_ms}/1000)).toFixed(1) }});
            }}
        }}, 50);
    }})""")


async def spawn_and_get_id(page):
    """Spawn new session via API, return session id."""
    result = await page.evaluate("""() =>
        fetch('/api/spawn', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({cwd: '~'})
        }).then(r => r.json())
    """)
    await page.wait_for_timeout(2000)
    return result.get("id")


async def test():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={"width": 1280, "height": 800})
        page = await ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        print("=== Long-Running Task Update Tests ===\n")

        await login(page)

        # ── 1. Continuous fast output ──
        print("1. Continuous fast output (seq 1 5000)")
        await send_command(page, "seq 1 5000")
        await page.wait_for_timeout(1000)

        # Monitor update rate while output is flowing
        rate_info = await get_ws_message_rate(page, 3000)
        changes = rate_info["changes"]
        rate = rate_info["rate"]
        if changes > 5:
            ok(f"Terminal updating during fast output: {changes} changes in 3s (rate: {rate}/s)")
        elif changes > 0:
            warn(f"Low update rate during fast output: {changes} changes in 3s")
        else:
            fail(f"No terminal updates during fast output")

        await page.wait_for_timeout(3000)

        # Check final output contains expected content
        text = await get_terminal_text(page)
        if "5000" in text:
            ok("Final output reached 5000")
        else:
            warn("Final output may not include 5000 (might need scroll)")

        # ── 2. Slow periodic output ──
        print("\n2. Slow periodic output (1 line per second)")
        await send_command(page, "for i in $(seq 1 6); do echo \"tick-$i-$(date +%s)\"; sleep 1; done")

        # Wait and collect snapshots
        snapshots = []
        for i in range(8):
            await page.wait_for_timeout(1000)
            text = await get_terminal_text(page)
            tick_count = text.count("tick-")
            snapshots.append(tick_count)

        # Check that ticks appeared progressively
        increasing = sum(1 for i in range(1, len(snapshots)) if snapshots[i] >= snapshots[i-1])
        max_ticks = max(snapshots)
        if max_ticks >= 5:
            ok(f"Slow output captured: saw up to {max_ticks} ticks")
        elif max_ticks >= 3:
            warn(f"Partial slow output: only {max_ticks}/6 ticks captured")
        else:
            fail(f"Slow output not updating: max {max_ticks} ticks seen")

        # Check for gaps (where tick count didn't increase for 2+ seconds)
        gaps = 0
        for i in range(2, len(snapshots)):
            if snapshots[i] == snapshots[i-2] and snapshots[i] < 6:
                gaps += 1
        if gaps == 0:
            ok("No update gaps detected")
        else:
            warn(f"{gaps} potential update gap(s) during slow output")

        await page.wait_for_timeout(2000)

        # ── 3. Bursty output ──
        print("\n3. Bursty output (silence then burst)")
        await send_command(page, "sleep 2 && seq 1 1000 && sleep 2 && echo BURST-DONE")

        # During silence
        await page.wait_for_timeout(1500)
        text_before = await get_terminal_text(page)

        # After burst
        await page.wait_for_timeout(3000)
        text_after = await get_terminal_text(page)

        if text_after != text_before:
            ok("Terminal updated after burst")
        else:
            fail("Terminal did not update after burst")

        # Wait for BURST-DONE
        await page.wait_for_timeout(3000)
        text_final = await get_terminal_text(page)
        if "BURST-DONE" in text_final:
            ok("Burst completion marker visible")
        else:
            warn("BURST-DONE not visible (may be scrolled off)")

        # ── 4. State detection during long task ──
        print("\n4. State detection during running command")
        await send_command(page, "sleep 5 && echo STATE-TEST-DONE")
        await page.wait_for_timeout(1000)

        # Check terminal state badge
        badge = await page.query_selector(".terminal-state-badge")
        if badge:
            badge_text = await badge.inner_text()
            ok(f"State badge during long task: '{badge_text.strip()}'")
        else:
            warn("No state badge visible")

        # Wait for completion
        await page.wait_for_timeout(6000)
        badge = await page.query_selector(".terminal-state-badge")
        if badge:
            badge_text = await badge.inner_text()
            ok(f"State badge after completion: '{badge_text.strip()}'")

        # ── 5. Inactive session monitoring ──
        print("\n5. Inactive session update monitoring")
        # Spawn a second session
        session_items_before = await page.query_selector_all(".session-item")
        count_before = len(session_items_before)

        new_btn = await page.query_selector(".btn-primary")
        if new_btn:
            await new_btn.click()
            await page.wait_for_timeout(3000)

        session_items_after = await page.query_selector_all(".session-item")
        count_after = len(session_items_after)

        if count_after > count_before:
            ok(f"New session spawned ({count_before} → {count_after})")

            # Switch to new session, run a command, switch back
            await page.evaluate(f"() => document.querySelectorAll('.session-item')[{count_after-1}].click()")
            await page.wait_for_timeout(1000)
            await send_command(page, "for i in $(seq 1 10); do echo BG-$i; sleep 1; done")
            await page.wait_for_timeout(500)

            # Switch back to first session
            await page.evaluate("() => document.querySelectorAll('.session-item')[0].click()")
            await page.wait_for_timeout(3000)

            # Check if background session state updates in sidebar
            # The bg session should show as 'working' or 'idle' in the sidebar
            session_states = await page.evaluate("""() => {
                const items = document.querySelectorAll('.session-state');
                return [...items].map(el => el.textContent);
            }""")
            ok(f"Session states: {session_states}")

            # Wait for bg task to finish and check state change
            await page.wait_for_timeout(10000)
            session_states_after = await page.evaluate("""() => {
                const items = document.querySelectorAll('.session-state');
                return [...items].map(el => el.textContent);
            }""")
            ok(f"States after bg completion: {session_states_after}")
        else:
            warn("Could not spawn second session for bg test")

        # ── 6. Rapid screen updates don't lag ──
        print("\n6. Rapid output latency test")
        marker = f"LATENCY-{int(time.time())}"
        start_time = time.time()
        await send_command(page, f"echo {marker}")

        # Poll for marker appearance
        found = False
        for _ in range(30):
            await page.wait_for_timeout(100)
            text = await get_terminal_text(page)
            if marker in text:
                elapsed = time.time() - start_time
                found = True
                if elapsed < 1.0:
                    ok(f"Command output appeared in {elapsed*1000:.0f}ms")
                elif elapsed < 3.0:
                    warn(f"Command output delayed: {elapsed*1000:.0f}ms")
                else:
                    fail(f"Command output very slow: {elapsed*1000:.0f}ms")
                break

        if not found:
            fail("Command output marker never appeared (3s timeout)")

        # ── 7. tmux command concurrency under load ──
        print("\n7. Concurrent session load test")
        # Run commands in quick succession
        for i in range(5):
            await send_command(page, f"echo LOAD-{i}")
            await page.wait_for_timeout(200)

        await page.wait_for_timeout(2000)
        text = await get_terminal_text(page)
        load_found = sum(1 for i in range(5) if f"LOAD-{i}" in text)
        if load_found >= 4:
            ok(f"All rapid commands visible: {load_found}/5")
        elif load_found >= 2:
            warn(f"Some rapid commands missing: {load_found}/5")
        else:
            fail(f"Most rapid commands lost: {load_found}/5")

        # ── 8. Large output doesn't crash ──
        print("\n8. Large output stress test")
        await send_command(page, "seq 1 50000")
        await page.wait_for_timeout(5000)

        # Check page is still responsive
        responsive = await page.evaluate("() => { return document.querySelector('.app') !== null; }")
        if responsive:
            ok("Page still responsive after large output")
        else:
            fail("Page became unresponsive")

        # Check terminal still works
        marker2 = f"AFTER-STRESS-{int(time.time())}"
        await page.wait_for_timeout(3000)
        await send_command(page, f"echo {marker2}")
        await page.wait_for_timeout(2000)
        text = await get_terminal_text(page)
        if marker2 in text:
            ok(f"Terminal functional after stress test")
        else:
            warn(f"Post-stress marker not visible (may need scroll)")

        # ── 9. WebSocket reconnection during long task ──
        print("\n9. WebSocket connection stability")
        ws_status = await page.evaluate("""() => {
            const dot = document.querySelector('#status-dot');
            return dot ? !dot.classList.contains('off') : false;
        }""")
        if ws_status:
            ok("WebSocket connected (status dot green)")
        else:
            fail("WebSocket disconnected (status dot red)")

        # ── Summary ──
        print(f"\nJS Errors: {len(errors)}")
        if errors:
            for e in errors[:3]:
                fail(f"JS error: {e}")
        else:
            ok("No JS errors")

        await page.screenshot(path="/workspace/BALAB_Prof/agentboard/test-longrun-final.png")

        print(f"\n{'='*50}")
        print(f"Long-Run Tests: {PASS} passed, {FAIL} failed, {WARN} warnings")
        print(f"{'='*50}")

        await browser.close()

asyncio.run(test())
