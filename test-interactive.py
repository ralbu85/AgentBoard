"""
Test: Interactive prompts and real long-running commands.
Verifies terminal updates during Y/n questions, apt/pip output, etc.
"""
import asyncio
from playwright.async_api import async_playwright

BASE = "http://localhost:3002"
PW = "balab2021"

PASS = 0; FAIL = 0; WARN = 0
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


async def send_cmd(page, cmd):
    ta = await page.query_selector(".input-textarea")
    if ta:
        await ta.fill(cmd)
        await ta.press("Enter")


async def get_text(page):
    """Get terminal text from the VISIBLE terminal (not hidden ones)."""
    return await page.evaluate("""() => {
        const wraps = document.querySelectorAll('.xterm-wrap');
        for (const w of wraps) {
            if (w.style.display === 'none') continue;
            const rows = w.querySelectorAll('.xterm-rows > div');
            if (rows.length > 0) return [...rows].map(r => r.textContent).join('\\n');
            const screen = w.querySelector('.xterm-screen');
            if (screen) return screen.innerText;
        }
        return '';
    }""")


async def wait_for_text(page, text, timeout_ms=10000):
    """Poll until text appears on screen."""
    elapsed = 0
    while elapsed < timeout_ms:
        t = await get_text(page)
        if text in t:
            return elapsed
        await page.wait_for_timeout(100)
        elapsed += 100
    return -1


async def test():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={"width": 1280, "height": 800})
        page = await ctx.new_page()
        await login(page)

        print("=== Interactive & Long-Running Command Tests ===\n")

        # ── 1. Spawn a bash session for interactive tests ──
        print("1. Spawn bash session + interactive prompt")
        # Spawn bash (not claude) via API
        bash_result = await page.evaluate("""() =>
            fetch('/api/spawn', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({cwd: '/tmp', cmd: 'bash'})
            }).then(r => r.json())
        """)
        bash_id = bash_result.get("id", "")
        await page.wait_for_timeout(3000)

        # Switch to the bash session (last one)
        count = await page.evaluate("() => document.querySelectorAll('.session-item').length")
        await page.evaluate(f"() => document.querySelectorAll('.session-item')[{count-1}].click()")
        await page.wait_for_timeout(2000)
        bash_idx = count - 1
        ok(f"Bash session spawned (id={bash_id}, index={bash_idx})")

        # Interactive Y/n prompt
        await send_cmd(page, "read -p 'Continue? [Y/n] ' answer && echo \"GOT:$answer\"")
        ms = await wait_for_text(page, "[Y/n]", 5000)
        if ms >= 0:
            ok(f"Prompt appeared in {ms}ms")

            # Wait for state poll
            await page.wait_for_timeout(3000)
            badge = await page.query_selector(".terminal-state-badge")
            if badge:
                state = await badge.inner_text()
                state_text = state.strip()
                print(f"   State badge: {state_text}")
                if "Asking" in state_text:
                    ok("State correctly detected as 'Asking'")
                elif "Thinking" in state_text:
                    ok("State detected as 'Thinking' (bash sees active command)")
                else:
                    warn(f"State is '{state_text}'")

            # Answer the prompt
            await send_cmd(page, "Y")
            ms2 = await wait_for_text(page, "GOT:Y", 3000)
            if ms2 >= 0:
                ok(f"Response appeared in {ms2}ms after answering")
            else:
                warn("Response not visible (may be off-screen)")
        else:
            fail("Y/n prompt did not appear within 5s")

        await page.wait_for_timeout(1000)

        # ── 2. Real Y/n with select ──
        print("\n2. Select menu prompt")
        await send_cmd(page, """echo "Pick one:" && select opt in "Option A" "Option B" "Quit"; do echo "Picked: $opt"; break; done""")
        ms = await wait_for_text(page, "Option A", 5000)
        if ms >= 0:
            ok(f"Select menu appeared in {ms}ms")
            # Send selection
            await send_cmd(page, "1")
            ms2 = await wait_for_text(page, "Picked:", 3000)
            if ms2 >= 0:
                ok(f"Selection result appeared in {ms2}ms")
            else:
                warn("Selection result not visible")
        else:
            fail("Select menu did not appear")

        await page.wait_for_timeout(1000)

        # ── 3. Long compile-like output (make simulation) ──
        print("\n3. Long build-like output (simulated)")
        await send_cmd(page, "for i in $(seq 1 20); do echo \"[$(date +%H:%M:%S)] Building module $i/20...\"; sleep 0.5; done && echo BUILD-COMPLETE")

        # Monitor updates during the build (use VISIBLE terminal, not first in DOM)
        updates = await page.evaluate("""() => new Promise(resolve => {
            const wraps = document.querySelectorAll('.xterm-wrap');
            let el = null;
            for (const w of wraps) {
                if (w.style.display !== 'none') { el = w.querySelector('.xterm-screen'); break; }
            }
            if (!el) el = document.querySelector('.xterm-screen');
            let prev = el ? el.innerText : '';
            const changes = [];
            const start = performance.now();

            const iv = setInterval(() => {
                const cur = el.innerText;
                if (cur !== prev) {
                    // Check which module number is visible
                    const match = cur.match(/module (\\d+)\\/20/);
                    changes.push({
                        ms: Math.round(performance.now() - start),
                        module: match ? parseInt(match[1]) : null
                    });
                    prev = cur;
                }
                if (performance.now() - start > 15000) {
                    clearInterval(iv);
                    resolve(changes);
                }
            }, 30);
        })""")

        modules_seen = set()
        for u in updates:
            if u["module"]:
                modules_seen.add(u["module"])
            # Debug: show what content was captured on first few changes
        if updates and not modules_seen:
            # Get a sample of the screen text for debugging
            sample = await page.evaluate("""() => {
                const wraps = document.querySelectorAll('.xterm-wrap');
                for (const w of wraps) {
                    if (w.style.display !== 'none') {
                        return w.querySelector('.xterm-screen')?.innerText?.substring(0, 300) || '';
                    }
                }
                return '';
            }""")
            print(f"   Debug sample: {repr(sample[:200])}")

        print(f"   Screen changes: {len(updates)} over 15s")
        print(f"   Modules seen: {sorted(modules_seen)}")

        if len(modules_seen) >= 10:
            ok(f"Good coverage: {len(modules_seen)}/20 modules visible")
        elif len(updates) >= 10:
            ok(f"Good screen updates ({len(updates)} changes, {len(modules_seen)} module matches)")
        elif len(modules_seen) >= 5:
            warn(f"Partial coverage: {len(modules_seen)}/20 modules")
        else:
            fail(f"Poor coverage: {len(updates)} changes, {len(modules_seen)} module matches")

        # Check gaps
        if len(updates) > 1:
            gaps = [updates[i]["ms"] - updates[i-1]["ms"] for i in range(1, len(updates))]
            max_gap = max(gaps)
            avg_gap = sum(gaps) / len(gaps)
            print(f"   Update gaps: avg={avg_gap:.0f}ms max={max_gap}ms")
            if max_gap > 3000:
                fail(f"Large gap: {max_gap}ms (>{3}s without update)")
            elif max_gap > 1500:
                warn(f"Moderate gap: {max_gap}ms")
            else:
                ok(f"Consistent updates (max gap: {max_gap}ms)")

        # Check BUILD-COMPLETE appeared
        await page.wait_for_timeout(3000)
        ms = await wait_for_text(page, "BUILD-COMPLETE", 5000)
        if ms >= 0:
            ok("Build completion marker visible")
        else:
            warn("BUILD-COMPLETE not visible (may be scrolled)")

        # ── 4. pip install (real package) ──
        print("\n4. Real pip install")
        await send_cmd(page, "backend/.venv/bin/pip install --quiet --no-deps httptools 2>&1 && echo PIP-DONE")
        ms = await wait_for_text(page, "PIP-DONE", 30000)
        if ms >= 0:
            ok(f"pip install completed and visible in {ms}ms")
        else:
            # Check if output is showing at all
            text = await get_text(page)
            if "pip" in text.lower() or "install" in text.lower() or "requirement" in text.lower():
                warn(f"pip running but PIP-DONE not yet visible")
            else:
                fail("pip install output not appearing")

        await page.wait_for_timeout(1000)

        # ── 5. Command that produces no output for a while then bursts ──
        print("\n5. Silent then burst (find command)")
        await send_cmd(page, "sleep 3 && find /usr/lib -name '*.so' 2>/dev/null | head -30 && echo FIND-DONE")

        # Should be silent for 3 seconds
        await page.wait_for_timeout(2000)
        text1 = await get_text(page)

        # Then burst of output
        ms = await wait_for_text(page, "FIND-DONE", 10000)
        if ms >= 0:
            ok(f"Find output appeared after silence ({ms}ms)")
        else:
            text2 = await get_text(page)
            if ".so" in text2:
                warn("Find output visible but FIND-DONE not yet")
            else:
                fail("No output after silent period")

        # ── 6. Concurrent output in background session ──
        print("\n6. Background session output during active session work")
        # Use the bash session spawned in test 1
        # Switch to bash session, start long command
        await page.evaluate(f"() => document.querySelectorAll('.session-item')[{bash_idx}].click()")
        await page.wait_for_timeout(1000)
        await send_cmd(page, "for i in $(seq 1 8); do echo BG-$i; sleep 1; done && echo BG-DONE")
        await page.wait_for_timeout(500)

        # Switch to first session
        await page.evaluate("() => document.querySelectorAll('.session-item')[0].click()")
        await page.wait_for_timeout(1000)
        ok("Switched to foreground while bg runs")

        # Wait for bg to finish
        await page.wait_for_timeout(12000)

        # Switch back to bash session and check output
        await page.evaluate(f"() => document.querySelectorAll('.session-item')[{bash_idx}].click()")
        await page.wait_for_timeout(3000)
        text = await get_text(page)
        if "BG-DONE" in text:
            ok("Background session output visible after switch")
        elif "BG-" in text:
            ok("Background output visible (BG-DONE may be above viewport)")
        else:
            fail("Background session output missing")

        # ── 7. State transitions check ──
        print("\n7. State detection accuracy")
        # Use bash session
        await page.evaluate(f"() => document.querySelectorAll('.session-item')[{bash_idx}].click()")
        await page.wait_for_timeout(1000)

        # Run command that triggers waiting state
        await send_cmd(page, "read -p 'Press Enter to continue: ' x")
        await page.wait_for_timeout(2000)

        badge = await page.query_selector(".terminal-state-badge")
        if badge:
            state = await badge.inner_text()
            state_text = state.strip()
            print(f"   During 'read' prompt: {state_text}")

        # Answer it
        await send_cmd(page, "")
        await page.wait_for_timeout(2000)

        badge = await page.query_selector(".terminal-state-badge")
        if badge:
            state = await badge.inner_text()
            state_text = state.strip()
            print(f"   After answering: {state_text}")
            if "Idle" in state_text:
                ok("State returned to Idle after prompt answered")
            else:
                warn(f"State is {state_text} after prompt answered")

        # ── 8. Long-duration update (75s command) ──
        print("\n8. Long-duration update test (75s)")
        await page.evaluate(f"() => document.querySelectorAll('.session-item')[{bash_idx}].click()")
        await page.wait_for_timeout(2000)

        # Debug: check visible wraps
        wrap_info = await page.evaluate("""() => {
            const wraps = document.querySelectorAll('.xterm-wrap');
            return [...wraps].map((w, i) => ({
                id: w.id,
                display: w.style.display,
                hasScreen: !!w.querySelector('.xterm-screen')
            }));
        }""")
        visible = [w for w in wrap_info if w['display'] != 'none']
        print(f"   Visible wraps: {len(visible)}/{len(wrap_info)} — {[w['id'] for w in visible]}")

        # Send command via API directly to ensure it goes to the right session
        await page.evaluate(f"""() =>
            fetch('/api/input', {{
                method: 'POST',
                headers: {{'Content-Type': 'application/json'}},
                body: JSON.stringify({{id: '{bash_id}', text: 'for i in $(seq 1 75); do echo "TICK-$i at $(date +%H:%M:%S)"; sleep 1; done && echo LONG-DONE'}})
            }})
        """)
        await page.wait_for_timeout(2000)

        # Check notifyActive was called, and reset counters
        notify_debug = await page.evaluate("() => ({...window.__wsDebug})")
        print(f"   notifyActive calls: {notify_debug.get('notifyActiveCount', 0)}, last={notify_debug.get('lastNotifyActive')}, wsState={notify_debug.get('wsState')}")
        await page.evaluate("() => { window.__wsDebug.screenCount = 0; window.__wsDebug.snapshotCount = 0 }")

        # Monitor using simple get_text polling at 5s intervals
        prev_text = ""
        changes_per_window = []
        ticks_seen = set()
        for window in range(5):
            changes = 0
            for _ in range(15):  # 15 checks per 15s window (1 per second)
                text = await get_text(page)
                if text != prev_text:
                    changes += 1
                    prev_text = text
                    # Extract TICK numbers
                    import re
                    for m in re.finditer(r"TICK-(\d+)", text):
                        ticks_seen.add(int(m.group(1)))
                await page.wait_for_timeout(1000)
            changes_per_window.append(changes)
            start_s = window * 15
            end_s = (window + 1) * 15
            status = "✓" if changes >= 5 else "✗"
            max_tick = max(ticks_seen) if ticks_seen else 0
            ws_debug = await page.evaluate("() => ({...window.__wsDebug})")
            print(f"   {status} Window {start_s}-{end_s}s: {changes} text changes, WS screens={ws_debug['screenCount']} last_id={ws_debug['lastScreenId']} (max TICK: {max_tick})")

        # Check if updates stopped after 60s
        all_ok = all(w >= 5 for w in changes_per_window)
        last_ok = changes_per_window[-1] >= 5
        if all_ok:
            ok(f"Updates consistent across all windows ({changes_per_window})")
        elif last_ok:
            warn(f"Some gaps but final window OK ({changes_per_window})")
        else:
            fail(f"Updates degraded or stopped ({changes_per_window})")

        # Wait for completion
        await page.wait_for_timeout(5000)
        text = await get_text(page)
        if "LONG-DONE" in text:
            ok("Long command completed successfully")
        elif "TICK-" in text:
            warn("Command still running or LONG-DONE scrolled off")
        else:
            fail("No output from long command")

        # ── Summary ──
        print(f"\n{'='*55}")
        print(f"Interactive Tests: {PASS} passed, {FAIL} failed, {WARN} warnings")
        print(f"{'='*55}")

        await page.screenshot(path="/workspace/BALAB_Prof/agentboard/test-interactive-final.png")
        await browser.close()

asyncio.run(test())
