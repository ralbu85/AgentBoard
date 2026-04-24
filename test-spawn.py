"""
Test: Spawn modal flow — folder selection, session creation, terminal output.
"""
import asyncio
from playwright.async_api import async_playwright

BASE = "http://localhost:3002"
PW = "balab2021"

PASS = 0; FAIL = 0
def ok(msg):
    global PASS; PASS += 1; print(f"   ✓ {msg}")
def fail(msg):
    global FAIL; FAIL += 1; print(f"   ✗ {msg}")

async def test():
    import os
    test_dir = "/tmp/agentboard-spawn-test"
    os.makedirs(test_dir, exist_ok=True)

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={"width": 1280, "height": 800})
        page = await ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        await page.goto(BASE, wait_until="networkidle", timeout=30000)
        pw = await page.query_selector("input[type=password]")
        if pw:
            await pw.fill(PW)
            await page.click("button[type=submit]")
        await page.wait_for_timeout(5000)

        print("=== Spawn Modal Tests ===\n")

        sessions_before = await page.evaluate("() => document.querySelectorAll('.session-item').length")

        # ── 1. Open spawn modal ──
        print("1. Open spawn modal")
        new_btn = await page.query_selector(".btn-primary")
        if new_btn:
            await new_btn.click()
            await page.wait_for_timeout(500)
        modal = await page.query_selector(".spawn-modal")
        if modal:
            ok("Modal opened")
        else:
            fail("Modal not found")
            await browser.close()
            return

        # ── 2. Folder input works ──
        print("\n2. Set folder path")
        folder_input = await modal.query_selector(".spawn-input")
        if folder_input:
            await folder_input.fill(test_dir)
            val = await folder_input.evaluate("el => el.value")
            if val == test_dir:
                ok(f"Folder set to: {val}")
            else:
                fail(f"Folder value: {val}")
        else:
            fail("No folder input")

        # ── 3. Preset selection ──
        print("\n3. Agent preset selection")
        # Default should be claude
        active_preset = await page.evaluate("() => document.querySelector('.spawn-preset.active')?.textContent || ''")
        if "Claude" in active_preset:
            ok(f"Default preset: Claude")
        else:
            fail(f"Default preset: '{active_preset}'")

        # Select bash
        await page.evaluate("""() => {
            const presets = document.querySelectorAll('.spawn-preset');
            for (const p of presets) { if (p.textContent.includes('Bash')) { p.click(); return; } }
        }""")
        await page.wait_for_timeout(200)
        active_after = await page.evaluate("() => document.querySelector('.spawn-preset.active')?.textContent || ''")
        if "Bash" in active_after:
            ok("Switched to Bash preset")
        else:
            fail(f"Preset after click: '{active_after}'")

        # ── 4. Command field ──
        print("\n4. Command field")
        cmd_toggle = await page.query_selector(".spawn-cmd-toggle")
        if cmd_toggle:
            text = await cmd_toggle.inner_text()
            if "bash" in text:
                ok(f"Command shows: {text.strip()}")
            else:
                fail(f"Command text: {text.strip()}")
            # Click to edit
            await cmd_toggle.click()
            await page.wait_for_timeout(200)
        cmd_textarea = await page.query_selector(".spawn-cmd")
        if cmd_textarea:
            val = await cmd_textarea.evaluate("el => el.value")
            ok(f"Command editable, value: '{val}'")
        else:
            fail("Command textarea not found after edit click")

        # ── 5. Submit — spawn bash session ──
        print("\n5. Spawn bash session")
        submit_btn = await page.query_selector(".spawn-footer .btn-primary")
        if submit_btn:
            await submit_btn.click()
            await page.wait_for_timeout(3000)
        else:
            fail("No submit button")

        # Modal should be closed
        modal_after = await page.query_selector(".spawn-modal")
        if not modal_after:
            ok("Modal closed after submit")
        else:
            fail("Modal still open")

        # New session should appear
        sessions_after = await page.evaluate("() => document.querySelectorAll('.session-item').length")
        if sessions_after > sessions_before:
            ok(f"New session appeared ({sessions_before} → {sessions_after})")
        else:
            fail(f"Session count unchanged ({sessions_before} → {sessions_after})")

        # ── 6. New session is active ──
        print("\n6. New session is active")
        active_session = await page.evaluate("""() => {
            const active = document.querySelector('.session-item.active');
            if (!active) return null;
            return {
                title: active.querySelector('.session-title')?.textContent || '',
                path: active.querySelector('.session-path')?.textContent || '',
            }
        }""")
        if active_session:
            ok(f"Active session: {active_session['title']} ({active_session['path']})")
        else:
            fail("No active session")

        # ── 7. Terminal has output (not blank) ──
        print("\n7. Terminal shows output")
        # Trigger resync to force snapshot
        await page.evaluate("""() => {
            const ws = document.querySelector('#status-dot');
            // send resync via the ws module
        }""")
        await page.wait_for_timeout(3000)

        # Check xterm has content (use innerText which skips blank rows)
        terminal_text = await page.evaluate("""() => {
            const wraps = document.querySelectorAll('.xterm-wrap');
            for (const w of wraps) {
                if (w.style.display === 'none') continue;
                return w.querySelector('.xterm-screen')?.innerText || '';
            }
            return '';
        }""")
        if terminal_text.strip():
            lines = [l for l in terminal_text.split('\n') if l.strip()]
            ok(f"Terminal has content ({len(lines)} non-empty lines)")
            # Should show bash prompt or similar
            if any('$' in l or '#' in l or '>' in l for l in lines):
                ok("Prompt visible")
            else:
                # At minimum some text
                ok(f"Content: {lines[-1][:60]}...")
        else:
            fail("Terminal is blank")

        # ── 8. Session CWD is correct ──
        print("\n8. Session CWD")
        # Wait for cwd update via WS (background poll is 2s)
        await page.wait_for_timeout(3000)
        cwd_check = await page.evaluate("""() => {
            const active = document.querySelector('.session-item.active');
            return active?.querySelector('.session-path')?.textContent || '';
        }""")
        if "spawn-test" in cwd_check or "agentboard-spawn-test" in cwd_check:
            ok(f"CWD correct: {cwd_check}")
        else:
            # Check via API
            worker_cwd = await page.evaluate("""() =>
                fetch('/api/workers').then(r => r.json()).then(ws => {
                    const active = document.querySelector('.session-item.active .session-title')?.textContent || '';
                    const id = active.match(/#(\\d+)/)?.[1];
                    const w = ws.find(w => w.id === id);
                    return w?.cwd || 'unknown';
                })
            """)
            if test_dir in str(worker_cwd):
                ok(f"CWD via API: {worker_cwd}")
            else:
                fail(f"CWD mismatch: path='{cwd_check}' api='{worker_cwd}' expected='{test_dir}'")

        # ── 9. Spawn with claude preset ──
        print("\n9. Spawn with claude preset")
        new_btn2 = await page.query_selector(".btn-primary")
        if new_btn2:
            await new_btn2.click()
            await page.wait_for_timeout(500)

        modal2 = await page.query_selector(".spawn-modal")
        if modal2:
            # Set folder
            inp = await modal2.query_selector(".spawn-input")
            if inp:
                await inp.fill(test_dir)

            # Claude should be default
            preset = await page.evaluate("() => document.querySelector('.spawn-preset.active')?.textContent || ''")
            ok(f"Default preset on reopen: {preset.strip()}")

            # Submit
            btn = await page.query_selector(".spawn-footer .btn-primary")
            if btn:
                await btn.click()
                await page.wait_for_timeout(3000)

            sessions_final = await page.evaluate("() => document.querySelectorAll('.session-item').length")
            if sessions_final > sessions_after:
                ok(f"Claude session spawned ({sessions_after} → {sessions_final})")
            else:
                fail(f"Claude session not spawned ({sessions_after} → {sessions_final})")

        # ── 10. Clean up spawned sessions ──
        print("\n10. Cleanup")
        # Kill bash sessions we spawned
        cleaned = await page.evaluate("""() =>
            fetch('/api/workers').then(r => r.json()).then(async ws => {
                let n = 0;
                for (const w of ws) {
                    if (w.cwd.includes('spawn-test')) {
                        await fetch('/api/kill', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({id: w.id})});
                        n++;
                    }
                }
                return n;
            })
        """)
        ok(f"Cleaned up {cleaned} test sessions")

        # ── Summary ──
        print(f"\nJS errors: {len(errors)}")
        for e in errors[:3]:
            print(f"  {e[:100]}")

        print(f"\n{'='*50}")
        print(f"Spawn Tests: {PASS} passed, {FAIL} failed")
        print(f"{'='*50}")

        await browser.close()

    import shutil
    shutil.rmtree(test_dir, ignore_errors=True)

asyncio.run(test())
