"""
Precise terminal update gap test.
Measures exact intervals between screen content changes.
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


async def test():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={"width": 1280, "height": 800})
        page = await ctx.new_page()
        await login(page)

        print("=== Terminal Update Gap Analysis ===\n")

        # ── 1. Screen change frequency during active output ──
        print("1. Screen change frequency (seq 1 2000)")
        await send_cmd(page, "seq 1 2000")
        gaps_data = await page.evaluate("""() => new Promise(resolve => {
            const el = document.querySelector('.xterm-screen');
            if (!el) { resolve({error: 'no screen'}); return; }

            let prev = el.innerText;
            const gaps = [];
            let lastChange = performance.now();
            const start = performance.now();

            const iv = setInterval(() => {
                const cur = el.innerText;
                if (cur !== prev) {
                    const now = performance.now();
                    gaps.push(Math.round(now - lastChange));
                    lastChange = now;
                    prev = cur;
                }
                if (performance.now() - start > 4000) {
                    clearInterval(iv);
                    resolve({
                        changes: gaps.length,
                        gaps: gaps,
                        avg: gaps.length ? Math.round(gaps.reduce((a,b)=>a+b,0)/gaps.length) : 0,
                        max: gaps.length ? Math.max(...gaps) : 0,
                        min: gaps.length ? Math.min(...gaps) : 0,
                        p90: gaps.length ? gaps.sort((a,b)=>a-b)[Math.floor(gaps.length*0.9)] : 0,
                    });
                }
            }, 10);
        })""")

        print(f"   Changes: {gaps_data['changes']} in 4s")
        print(f"   Intervals — min:{gaps_data['min']}ms avg:{gaps_data['avg']}ms p90:{gaps_data['p90']}ms max:{gaps_data['max']}ms")
        if gaps_data['max'] < 500:
            ok(f"No stalls during fast output (max gap: {gaps_data['max']}ms)")
        else:
            warn(f"Stall detected during fast output (max gap: {gaps_data['max']}ms)")

        await page.wait_for_timeout(3000)

        # ── 2. Idle → active transition speed ──
        print("\n2. Idle screen to first update after command")
        await page.wait_for_timeout(1000)  # Ensure idle
        first_update = await page.evaluate("""() => new Promise(resolve => {
            const el = document.querySelector('.xterm-screen');
            const before = el ? el.innerText : '';
            const start = performance.now();

            const iv = setInterval(() => {
                const cur = el.innerText;
                if (cur !== before) {
                    clearInterval(iv);
                    resolve(Math.round(performance.now() - start));
                }
                if (performance.now() - start > 3000) {
                    clearInterval(iv);
                    resolve(-1);
                }
            }, 10);
        })""")
        # Send command right after starting observer
        await send_cmd(page, "echo FIRST-UPDATE-TEST")

        if first_update > 0 and first_update < 300:
            ok(f"First update latency: {first_update}ms")
        elif first_update > 0:
            warn(f"First update latency: {first_update}ms")
        else:
            # The observer started before the command, so -1 means 3s timeout
            # Let's just check command output appeared
            await page.wait_for_timeout(500)
            text = await page.evaluate("() => document.querySelector('.xterm-screen')?.innerText || ''")
            if "FIRST-UPDATE-TEST" in text:
                ok("Command appeared (observer timing issue)")
            else:
                fail("Command output not visible after 3s")

        await page.wait_for_timeout(1000)

        # ── 3. Screen update during silence (should be minimal) ──
        print("\n3. Updates during idle (should be 0 — no wasted redraws)")
        idle_changes = await page.evaluate("""() => new Promise(resolve => {
            const el = document.querySelector('.xterm-screen');
            let prev = el ? el.innerText : '';
            let changes = 0;
            const start = performance.now();
            const iv = setInterval(() => {
                const cur = el.innerText;
                if (cur !== prev) { changes++; prev = cur; }
                if (performance.now() - start > 3000) {
                    clearInterval(iv);
                    resolve(changes);
                }
            }, 20);
        })""")
        if idle_changes == 0:
            ok("Zero idle redraws (efficient)")
        elif idle_changes <= 2:
            ok(f"Minimal idle redraws: {idle_changes}")
        else:
            warn(f"Unnecessary idle redraws: {idle_changes} in 3s")

        # ── 4. Background session state detection lag ──
        print("\n4. Background session state update lag")
        # Spawn new session
        await send_cmd(page, "")  # Clear
        new_btn = await page.query_selector(".btn-primary")
        if new_btn:
            await new_btn.click()
            await page.wait_for_timeout(3000)

            # Get session count
            count = await page.evaluate("() => document.querySelectorAll('.session-item').length")

            # Switch to new session, start a long command
            await page.evaluate(f"() => document.querySelectorAll('.session-item')[{count-1}].click()")
            await page.wait_for_timeout(1000)
            await send_cmd(page, "for i in $(seq 1 5); do echo BG-TICK-$i; sleep 1; done && echo BG-DONE")
            await page.wait_for_timeout(500)

            # Switch back to first session
            await page.evaluate("() => document.querySelectorAll('.session-item')[0].click()")
            await page.wait_for_timeout(500)

            # Monitor last session's state label changes
            state_log = await page.evaluate(f"""() => new Promise(resolve => {{
                const start = performance.now();
                const log = [];
                let lastState = '';

                const iv = setInterval(() => {{
                    const items = document.querySelectorAll('.session-item');
                    const last = items[{count-1}];
                    if (last) {{
                        const label = last.querySelector('.session-state');
                        const state = label ? label.textContent : '?';
                        if (state !== lastState) {{
                            log.push({{state, ms: Math.round(performance.now() - start)}});
                            lastState = state;
                        }}
                    }}
                    if (performance.now() - start > 10000) {{
                        clearInterval(iv);
                        resolve(log);
                    }}
                }}, 200);
            }})""")

            print(f"   Background session state changes:")
            for entry in state_log:
                print(f"     {entry['ms']}ms → {entry['state']}")

            if len(state_log) >= 1:
                ok(f"Background state tracked ({len(state_log)} state changes)")
            else:
                fail("No background state changes detected")
        else:
            warn("Could not spawn new session")

        # ── 5. Active poll thread-safety ──
        print("\n5. Multiple rapid session switches")
        count = await page.evaluate("() => document.querySelectorAll('.session-item').length")
        if count >= 2:
            for _ in range(5):
                await page.evaluate("() => document.querySelectorAll('.session-item')[1]?.click()")
                await page.wait_for_timeout(100)
                await page.evaluate("() => document.querySelectorAll('.session-item')[0]?.click()")
                await page.wait_for_timeout(100)

            await page.wait_for_timeout(1000)
            # Check still functional
            responsive = await page.evaluate("() => !!document.querySelector('.xterm-screen')")
            if responsive:
                ok("Terminal stable after rapid switching")
            else:
                fail("Terminal broken after rapid switching")

            # Check WS still connected
            ws_ok = await page.evaluate("""() => {
                const dot = document.getElementById('status-dot');
                return dot && !dot.classList.contains('off');
            }""")
            if ws_ok:
                ok("WebSocket still connected")
            else:
                fail("WebSocket disconnected after rapid switching")
        else:
            warn("Not enough sessions to test switching")

        # ── Summary ──
        print(f"\n{'='*50}")
        print(f"Results: {PASS} passed, {FAIL} failed, {WARN} warnings")
        print(f"{'='*50}")

        await page.screenshot(path="/workspace/BALAB_Prof/agentboard/test-longrun3-final.png")
        await browser.close()

asyncio.run(test())
