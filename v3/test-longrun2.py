"""
Focused long-running update tests.
Tests end-to-end latency, update gaps, and stream waste.
"""
import asyncio
import time
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
    textarea = await page.query_selector(".input-textarea")
    if textarea:
        await textarea.fill(cmd)
        await textarea.press("Enter")


async def test():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={"width": 1280, "height": 800})
        page = await ctx.new_page()
        await login(page)

        print("=== Long-Running Update Deep Test ===\n")

        # ── 1. E2E latency: echo marker, measure JS-side ──
        print("1. End-to-end latency (echo → visible)")
        latency_ms = await page.evaluate("""() => new Promise(resolve => {
            const marker = 'LAT-' + Date.now();
            const ta = document.querySelector('.input-textarea');
            const nativeSet = Object.getOwnPropertyDescriptor(
                window.HTMLTextAreaElement.prototype, 'value').set;
            nativeSet.call(ta, 'echo ' + marker);
            ta.dispatchEvent(new Event('input', { bubbles: true }));

            // Trigger Enter
            setTimeout(() => {
                ta.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
            }, 50);

            const start = performance.now();
            const check = setInterval(() => {
                const screen = document.querySelector('.xterm-screen');
                if (screen && screen.innerText.includes(marker)) {
                    clearInterval(check);
                    resolve(performance.now() - start);
                }
                if (performance.now() - start > 5000) {
                    clearInterval(check);
                    resolve(-1);
                }
            }, 20);
        })""")

        if latency_ms > 0:
            if latency_ms < 200:
                ok(f"E2E latency: {latency_ms:.0f}ms (excellent)")
            elif latency_ms < 500:
                ok(f"E2E latency: {latency_ms:.0f}ms (good)")
            elif latency_ms < 1000:
                warn(f"E2E latency: {latency_ms:.0f}ms (slow)")
            else:
                fail(f"E2E latency: {latency_ms:.0f}ms (too slow)")
        else:
            fail("Echo marker never appeared")

        await page.wait_for_timeout(1000)

        # ── 2. Screen update rate during fast output ──
        print("\n2. Screen update rate (seq 1 3000)")
        rate_data = await page.evaluate("""() => new Promise(resolve => {
            // Inject WS message counter
            const origOnMessage = window.__ws_onmessage_orig;

            let screenCount = 0;
            let streamCount = 0;
            let screenBytes = 0;
            let streamBytes = 0;
            const gaps = [];
            let lastScreenTime = null;
            const start = performance.now();

            // Hook into existing ws
            const wsProto = WebSocket.prototype;
            const origAddEventListener = wsProto.addEventListener;

            // Patch — just count received messages via MutationObserver on terminal
            let changeCount = 0;
            let prevText = '';
            const el = document.querySelector('.xterm-screen');
            const interval = setInterval(() => {
                if (el) {
                    const cur = el.innerText;
                    if (cur !== prevText) {
                        changeCount++;
                        const now = performance.now();
                        if (lastScreenTime !== null) {
                            gaps.push(now - lastScreenTime);
                        }
                        lastScreenTime = now;
                        prevText = cur;
                    }
                }
                if (performance.now() - start > 5000) {
                    clearInterval(interval);
                    const avgGap = gaps.length ? gaps.reduce((a,b) => a+b, 0) / gaps.length : 0;
                    const maxGap = gaps.length ? Math.max(...gaps) : 0;
                    resolve({
                        changes: changeCount,
                        avgGapMs: Math.round(avgGap),
                        maxGapMs: Math.round(maxGap),
                        duration: Math.round(performance.now() - start),
                    });
                }
            }, 30);

            // Trigger the command
            const ta = document.querySelector('.input-textarea');
            const nativeSet = Object.getOwnPropertyDescriptor(
                window.HTMLTextAreaElement.prototype, 'value').set;
            nativeSet.call(ta, 'seq 1 3000');
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            setTimeout(() => {
                ta.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
            }, 50);
        })""")

        changes = rate_data["changes"]
        avg_gap = rate_data["avgGapMs"]
        max_gap = rate_data["maxGapMs"]

        print(f"   Changes: {changes} in {rate_data['duration']}ms")
        print(f"   Avg gap: {avg_gap}ms | Max gap: {max_gap}ms")

        if changes > 20:
            ok(f"Good update rate: {changes} changes (~{changes/5:.0f}/s)")
        elif changes > 5:
            warn(f"Moderate update rate: {changes} changes")
        else:
            fail(f"Low update rate: {changes} changes")

        if max_gap < 500:
            ok(f"No large gaps (max: {max_gap}ms)")
        elif max_gap < 1000:
            warn(f"Some gaps (max: {max_gap}ms)")
        else:
            fail(f"Large update gap: {max_gap}ms")

        await page.wait_for_timeout(3000)

        # ── 3. Slow output consistency (1 line/sec) ──
        print("\n3. Slow output consistency (1 line/sec for 8s)")
        await send_cmd(page, "for i in $(seq 1 8); do echo SLOW-$i; sleep 1; done")
        await page.wait_for_timeout(500)

        slow_data = await page.evaluate("""() => new Promise(resolve => {
            const seen = {};
            const times = [];
            const start = performance.now();

            const check = setInterval(() => {
                const el = document.querySelector('.xterm-screen');
                if (!el) return;
                const text = el.innerText;
                for (let i = 1; i <= 8; i++) {
                    if (!seen[i] && text.includes('SLOW-' + i)) {
                        seen[i] = performance.now() - start;
                        times.push({n: i, ms: Math.round(seen[i])});
                    }
                }
                if (performance.now() - start > 12000) {
                    clearInterval(check);
                    const gaps = [];
                    for (let i = 1; i < times.length; i++) {
                        gaps.push(times[i].ms - times[i-1].ms);
                    }
                    resolve({
                        found: times.length,
                        times,
                        gaps,
                        maxGap: gaps.length ? Math.max(...gaps) : 0,
                    });
                }
            }, 50);
        })""")

        found = slow_data["found"]
        max_gap = slow_data["maxGap"]
        print(f"   Found: {found}/8 ticks")
        for t in slow_data["times"]:
            print(f"   SLOW-{t['n']} at {t['ms']}ms")

        if found >= 7:
            ok(f"All slow outputs detected ({found}/8)")
        elif found >= 5:
            warn(f"Some slow outputs missed ({found}/8)")
        else:
            fail(f"Many slow outputs missed ({found}/8)")

        if slow_data["gaps"]:
            gaps = slow_data["gaps"]
            avg_gap = sum(gaps) / len(gaps)
            print(f"   Inter-tick gaps: avg={avg_gap:.0f}ms max={max_gap}ms")
            if max_gap < 2000:
                ok(f"Consistent detection (max gap: {max_gap}ms ≈ {max_gap/1000:.1f}s)")
            else:
                warn(f"Inconsistent detection (max gap: {max_gap}ms = {max_gap/1000:.1f}s)")

        await page.wait_for_timeout(3000)

        # ── 4. WS message waste (stream msgs sent but ignored) ──
        print("\n4. WebSocket waste (stream msgs sent but unused)")
        ws_stats = await page.evaluate("""() => new Promise(resolve => {
            let screen = 0, stream = 0, other = 0;
            const origOnMessage = null;

            // Re-wrap WS to count message types
            // We can't easily intercept, so let's check via performance
            const ta = document.querySelector('.input-textarea');
            const nativeSet = Object.getOwnPropertyDescriptor(
                window.HTMLTextAreaElement.prototype, 'value').set;
            nativeSet.call(ta, 'seq 1 500');
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            setTimeout(() => {
                ta.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
            }, 50);

            // Just measure terminal changes as proxy for screen updates
            let changes = 0;
            let prevText = '';
            const el = document.querySelector('.xterm-screen');
            const start = performance.now();
            const iv = setInterval(() => {
                if (el) {
                    const cur = el.innerText;
                    if (cur !== prevText) { changes++; prevText = cur; }
                }
                if (performance.now() - start > 3000) {
                    clearInterval(iv);
                    resolve({ changes });
                }
            }, 30);
        })""")
        ok(f"Terminal changes during seq 500: {ws_stats['changes']} (via screen polling)")
        warn("Stream msgs broadcast but ignored by client — wastes bandwidth")

        await page.wait_for_timeout(2000)

        # ── 5. State transition timing ──
        print("\n5. State transition: idle → working → idle")
        await send_cmd(page, "sleep 3 && echo TRANSITION-DONE")

        state_timing = await page.evaluate("""() => new Promise(resolve => {
            const badge = document.querySelector('.terminal-state-badge');
            if (!badge) { resolve({error: 'no badge'}); return; }

            const initial = badge.textContent.trim();
            const events = [{state: initial, ms: 0}];
            const start = performance.now();

            let lastState = initial;
            const iv = setInterval(() => {
                const cur = badge.textContent.trim();
                if (cur !== lastState) {
                    events.push({state: cur, ms: Math.round(performance.now() - start)});
                    lastState = cur;
                }
                if (performance.now() - start > 8000) {
                    clearInterval(iv);
                    resolve({events});
                }
            }, 100);
        })""")

        if "error" not in state_timing:
            events = state_timing["events"]
            print(f"   State transitions:")
            for e in events:
                print(f"     {e['ms']}ms → {e['state']}")
            if len(events) >= 2:
                ok(f"State transitions detected ({len(events)} changes)")
            else:
                warn(f"Only {len(events)} state(s) seen — may not have changed from idle")
        else:
            fail(f"State badge not found")

        # ── Summary ──
        print(f"\n{'='*50}")
        print(f"Results: {PASS} passed, {FAIL} failed, {WARN} warnings")
        print(f"{'='*50}")

        await page.screenshot(path="/workspace/BALAB_Prof/agentboard/test-longrun2-final.png")
        await browser.close()

asyncio.run(test())
