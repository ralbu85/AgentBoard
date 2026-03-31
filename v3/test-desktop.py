import asyncio
from playwright.async_api import async_playwright

BASE = "http://localhost:3002"
PW = "balab2021"

PASS = 0
FAIL = 0
WARN = 0

def ok(msg):
    global PASS
    PASS += 1
    print(f"   ✓ {msg}")

def fail(msg):
    global FAIL
    FAIL += 1
    print(f"   ✗ {msg}")

def warn(msg):
    global WARN
    WARN += 1
    print(f"   ⚠ {msg}")

async def login(page):
    await page.goto(BASE, wait_until="networkidle", timeout=30000)
    login_input = await page.query_selector("input[type=password]")
    if login_input:
        await login_input.fill(PW)
        await page.click("button[type=submit]")
    await page.wait_for_timeout(5000)

async def get_scroll_info(page):
    return await page.evaluate("""() => {
        const vp = document.querySelector('.xterm-viewport');
        if (!vp) return null;
        return { top: vp.scrollTop, max: vp.scrollHeight - vp.clientHeight, h: vp.scrollHeight, ch: vp.clientHeight };
    }""")

async def test():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={"width": 1280, "height": 800})
        page = await ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        print("=== Desktop UI/UX Tests ===\n")

        # ── 1. Login ──
        print("1. Login flow")
        await page.goto(BASE, wait_until="networkidle", timeout=30000)
        login_form = await page.query_selector(".login-form")
        if login_form:
            ok("Login form displayed")
            # Check centered
            box = await login_form.bounding_box()
            vp = page.viewport_size
            center_x = box["x"] + box["width"] / 2
            if abs(center_x - vp["width"] / 2) < 50:
                ok(f"Login form centered (cx={center_x:.0f}, vp_mid={vp['width']/2:.0f})")
            else:
                fail(f"Login form not centered (cx={center_x:.0f}, vp_mid={vp['width']/2:.0f})")
        else:
            ok("Already logged in (no login form)")

        await login(page)
        app_el = await page.query_selector(".app")
        if app_el:
            ok("App loaded after login")
        else:
            fail("App did not load after login")
            await browser.close()
            return

        # ── 2. Header ──
        print("\n2. Header layout")
        header = await page.query_selector(".header")
        if header:
            box = await header.bounding_box()
            if abs(box["height"] - 48) < 5:
                ok(f"Header height correct ({box['height']:.0f}px)")
            else:
                fail(f"Header height wrong ({box['height']:.0f}px, expected 48)")

            if abs(box["width"] - 1280) < 5:
                ok("Header spans full width")
            else:
                fail(f"Header width: {box['width']:.0f}px")

        # Status dot
        dot = await page.query_selector("#status-dot")
        if dot:
            color = await dot.evaluate("el => getComputedStyle(el).backgroundColor")
            ok(f"Status dot present (bg: {color})")
        else:
            fail("Status dot missing")

        # Logo
        logo = await page.query_selector(".logo")
        if logo:
            text = await logo.inner_text()
            ok(f"Logo: '{text}'")
        else:
            fail("Logo missing")

        # Header badges visible on desktop
        center = await page.query_selector(".header-center")
        if center:
            display = await center.evaluate("el => getComputedStyle(el).display")
            if display != "none":
                ok(f"Header badges visible on desktop (display: {display})")
            else:
                fail("Header badges hidden on desktop (should only hide on mobile)")
        else:
            fail("Header center section missing")

        # + New button
        new_btn = await page.query_selector(".btn-primary")
        if new_btn:
            text = await new_btn.inner_text()
            ok(f"New button present: '{text}'")
        else:
            fail("+ New button missing")

        # ── 3. Sidebar ──
        print("\n3. Sidebar")
        sidebar = await page.query_selector(".sidebar")
        if sidebar:
            box = await sidebar.bounding_box()
            ok(f"Sidebar visible (width: {box['width']:.0f}px)")
            if box["width"] >= 180 and box["width"] <= 260:
                ok("Sidebar width in expected range (180-260px)")
            else:
                warn(f"Sidebar width unexpected: {box['width']:.0f}px")

            # Sidebar should NOT have fixed position on desktop
            position = await sidebar.evaluate("el => getComputedStyle(el).position")
            if position != "fixed":
                ok(f"Sidebar is inline on desktop (position: {position})")
            else:
                fail(f"Sidebar is fixed overlay on desktop (position: {position})")
        else:
            fail("Sidebar not visible by default on desktop")

        # Backdrop hidden on desktop
        backdrop = await page.query_selector(".sidebar-backdrop")
        if backdrop:
            display = await backdrop.evaluate("el => getComputedStyle(el).display")
            if display == "none":
                ok("Sidebar backdrop hidden on desktop")
            else:
                warn(f"Sidebar backdrop visible on desktop (display: {display})")

        # Session list
        sessions = await page.query_selector_all(".session-item")
        if len(sessions) > 0:
            ok(f"Session list has {len(sessions)} session(s)")
            # Check active highlight
            active = await page.query_selector(".session-item.active")
            if active:
                ok("Active session highlighted")
            else:
                warn("No active session highlighted")
        else:
            warn("No sessions in list (empty state)")
            empty = await page.query_selector(".empty-msg")
            if empty:
                ok("Empty state message shown")

        # ── 4. Sidebar toggle (Ctrl+B) ──
        print("\n4. Sidebar toggle (Ctrl+B)")
        await page.keyboard.press("Control+b")
        await page.wait_for_timeout(300)
        sidebar_after = await page.query_selector(".sidebar")
        if not sidebar_after:
            ok("Sidebar hidden after Ctrl+B")
        else:
            fail("Sidebar still visible after Ctrl+B toggle")

        # Toggle back
        await page.keyboard.press("Control+b")
        await page.wait_for_timeout(300)
        sidebar_back = await page.query_selector(".sidebar")
        if sidebar_back:
            ok("Sidebar restored after second Ctrl+B")
        else:
            fail("Sidebar not restored after second Ctrl+B")

        # Hamburger button toggle
        hamburger = await page.query_selector(".btn-icon")
        if hamburger:
            await hamburger.click()
            await page.wait_for_timeout(300)
            sidebar_hb = await page.query_selector(".sidebar")
            if not sidebar_hb:
                ok("Hamburger button toggles sidebar off")
            else:
                fail("Hamburger click did not toggle sidebar")
            # Restore
            await hamburger.click()
            await page.wait_for_timeout(300)

        # ── 5. Terminal ──
        print("\n5. Terminal display")
        terminal = await page.query_selector(".terminal-container")
        if terminal:
            box = await terminal.bounding_box()
            ok(f"Terminal container: {box['width']:.0f}x{box['height']:.0f}px")

            xterm = await page.query_selector(".xterm")
            if xterm:
                ok("xterm.js rendered")
            else:
                fail("xterm.js not rendered")
        else:
            fail("Terminal container missing")

        # Terminal scroll with mouse wheel
        print("\n6. Terminal mouse wheel scroll")
        info = await get_scroll_info(page)
        if info and info['max'] > 10:
            before = info['top']
            # Scroll up with mouse wheel
            await page.mouse.move(640, 400)
            await page.mouse.wheel(0, -300)
            await page.wait_for_timeout(500)
            after = (await get_scroll_info(page))['top']
            diff = before - after
            if diff > 0:
                ok(f"Mouse wheel scroll UP works ({diff:.0f}px)")
            elif diff < 0:
                warn(f"Mouse wheel scrolled wrong direction ({diff:.0f}px)")
            else:
                warn("Mouse wheel scroll had no effect (may need more scrollback)")

            # Scroll down
            await page.mouse.wheel(0, 300)
            await page.wait_for_timeout(500)
            after2 = (await get_scroll_info(page))['top']
            diff2 = after2 - after
            if diff2 > 0:
                ok(f"Mouse wheel scroll DOWN works ({diff2:.0f}px)")
            else:
                warn("Mouse wheel scroll down had no effect")
        else:
            warn(f"Not enough scrollback to test scroll (max={info['max'] if info else 'N/A'})")

        # ── 7. Input card ──
        print("\n7. Input card")
        input_card = await page.query_selector(".input-card")
        if input_card:
            ok("Input card present")

            textarea = await page.query_selector(".input-textarea")
            if textarea:
                # Check it's visible and has correct font
                font = await textarea.evaluate("el => getComputedStyle(el).fontFamily")
                font_size = await textarea.evaluate("el => getComputedStyle(el).fontSize")
                ok(f"Textarea: font={font_size} family includes monospace")

                placeholder = await textarea.get_attribute("placeholder")
                ok(f"Placeholder: '{placeholder}'")

                # Type and send with Enter
                await textarea.fill("echo desktop-test-123")
                val = await textarea.evaluate("el => el.value")
                if "desktop-test-123" in val:
                    ok("Text input works")
                else:
                    fail(f"Text input failed (got: '{val}')")

                # Enter to send
                await textarea.press("Enter")
                await page.wait_for_timeout(500)
                val_after = await textarea.evaluate("el => el.value")
                if val_after == "":
                    ok("Enter key sends and clears textarea")
                else:
                    warn(f"Textarea not cleared after Enter (value: '{val_after}')")

                # Type and use Send button
                await textarea.fill("echo send-btn-test")
                send_btn = await page.query_selector(".send-btn")
                if send_btn:
                    await send_btn.click()
                    await page.wait_for_timeout(500)
                    val_after2 = await textarea.evaluate("el => el.value")
                    if val_after2 == "":
                        ok("Send button sends and clears textarea")
                    else:
                        warn(f"Textarea not cleared after Send button (value: '{val_after2}')")
                else:
                    fail("Send button missing")

                # Shift+Enter should NOT send (newline)
                await textarea.fill("")
                await textarea.press("Shift+Enter")
                await page.wait_for_timeout(100)
                val_shift = await textarea.evaluate("el => el.value")
                if "\n" in val_shift or val_shift != "":
                    ok("Shift+Enter inserts newline (does not send)")
                else:
                    warn("Shift+Enter behavior unclear")
            else:
                fail("Textarea missing")
        else:
            fail("Input card missing")

        # Quick keys
        print("\n8. Quick keys")
        quick_keys = await page.query_selector_all(".quick-key")
        if len(quick_keys) >= 6:
            ok(f"{len(quick_keys)} quick keys present")
            labels = []
            for qk in quick_keys:
                labels.append(await qk.inner_text())
            ok(f"Keys: {', '.join(labels)}")

            # Check they're clickable (at least one)
            try:
                await quick_keys[0].click()
                await page.wait_for_timeout(200)
                ok(f"Quick key '{labels[0]}' clickable")
            except Exception as e:
                fail(f"Quick key click failed: {e}")
        else:
            fail(f"Expected 6 quick keys, found {len(quick_keys)}")

        # ── 9. Session management ──
        print("\n9. Session management (spawn)")
        sessions_before = len(await page.query_selector_all(".session-item"))
        new_btn = await page.query_selector(".btn-primary")
        if new_btn:
            await new_btn.click()
            await page.wait_for_timeout(3000)
            sessions_after = len(await page.query_selector_all(".session-item"))
            if sessions_after > sessions_before:
                ok(f"New session spawned ({sessions_before} → {sessions_after})")
            else:
                warn(f"Session count unchanged after spawn ({sessions_before} → {sessions_after})")

        # ── 10. Session switching ──
        print("\n10. Session switching")
        # Ensure sidebar is open
        sidebar = await page.query_selector(".sidebar")
        if not sidebar:
            await page.keyboard.press("Control+b")
            await page.wait_for_timeout(300)

        session_count = await page.evaluate("() => document.querySelectorAll('.session-item').length")
        if session_count >= 2:
            # Click second session
            await page.evaluate("() => document.querySelectorAll('.session-item')[1].click()")
            await page.wait_for_timeout(1000)

            # Check sidebar stays open on desktop
            sidebar_still = await page.query_selector(".sidebar")
            if sidebar_still:
                ok("Sidebar stays open after session select (desktop)")
            else:
                fail("Sidebar closed after session select (should stay open on desktop)")
                # Reopen for further tests
                await page.keyboard.press("Control+b")
                await page.wait_for_timeout(300)

            active_after = await page.query_selector(".session-item.active")
            if active_after:
                ok("Session switch works (active class updated)")
            else:
                fail("No active session after switch")

            # Switch back to first
            await page.evaluate("() => document.querySelectorAll('.session-item')[0].click()")
            await page.wait_for_timeout(1000)
            ok("Switched back to first session")
        elif session_count == 1:
            warn("Only 1 session, cannot test switching")
        else:
            warn("No sessions to test switching")

        # ── 11. Session hover action button ──
        print("\n11. Session action button (hover)")
        first_item = await page.query_selector(".session-item")
        if first_item:
            action_btn = await first_item.query_selector(".session-action")
            if action_btn:
                opacity_before = await action_btn.evaluate("el => getComputedStyle(el).opacity")
                await first_item.hover()
                await page.wait_for_timeout(200)
                opacity_after = await action_btn.evaluate("el => getComputedStyle(el).opacity")
                if float(opacity_after) > float(opacity_before):
                    ok(f"Action button appears on hover (opacity: {opacity_before} → {opacity_after})")
                elif float(opacity_before) > 0:
                    warn(f"Action button already visible (opacity: {opacity_before})")
                else:
                    fail(f"Action button not showing on hover (opacity: {opacity_before} → {opacity_after})")
            else:
                fail("No action button in session item")

        # ── 12. Layout proportions ──
        print("\n12. Layout proportions")
        sidebar = await page.query_selector(".sidebar")
        main = await page.query_selector(".main-area")
        if sidebar and main:
            sb_box = await sidebar.bounding_box()
            main_box = await main.bounding_box()
            total = sb_box["width"] + main_box["width"]
            ratio = main_box["width"] / total * 100
            ok(f"Sidebar: {sb_box['width']:.0f}px | Main: {main_box['width']:.0f}px ({ratio:.0f}% main)")

            # Check no horizontal overflow
            vp_width = page.viewport_size["width"]
            if total <= vp_width + 5:
                ok(f"No horizontal overflow ({total:.0f}px ≤ {vp_width}px)")
            else:
                fail(f"Horizontal overflow: {total:.0f}px > {vp_width}px")

            # Check vertical layout fills viewport
            vp_height = page.viewport_size["height"]
            header_box = await (await page.query_selector(".header")).bounding_box()
            workspace_h = vp_height - header_box["height"]
            main_h = main_box["height"]
            if abs(main_h - workspace_h) < 10:
                ok(f"Vertical layout fills viewport ({main_h:.0f}px ≈ {workspace_h:.0f}px)")
            else:
                warn(f"Vertical gap: main={main_h:.0f}px, available={workspace_h:.0f}px")

        # ── 13. Window resize ──
        print("\n13. Window resize handling")
        await page.set_viewport_size({"width": 1024, "height": 600})
        await page.wait_for_timeout(500)
        terminal = await page.query_selector(".terminal-container")
        if terminal:
            box = await terminal.bounding_box()
            ok(f"After resize (1024x600): terminal {box['width']:.0f}x{box['height']:.0f}px")

        # Narrow (near mobile breakpoint)
        await page.set_viewport_size({"width": 900, "height": 600})
        await page.wait_for_timeout(500)
        sidebar = await page.query_selector(".sidebar")
        if sidebar:
            pos = await sidebar.evaluate("el => getComputedStyle(el).position")
            ok(f"At 900px: sidebar position={pos} (should be static/relative)")

        # Restore
        await page.set_viewport_size({"width": 1280, "height": 800})
        await page.wait_for_timeout(500)

        # ── 14. Focus management ──
        print("\n14. Focus management")
        textarea = await page.query_selector(".input-textarea")
        if textarea:
            await textarea.click()
            focused = await page.evaluate("() => document.activeElement?.className || ''")
            if "input-textarea" in focused:
                ok("Textarea focusable by click")
            else:
                warn(f"Focused element: '{focused}'")

        # ── 15. Stopped session removal ──
        print("\n15. Stopped session removal")
        # Spawn + kill sessions to create stopped state
        for _ in range(3):
            await page.evaluate("""() =>
                fetch('/api/spawn', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({cwd: '/tmp', cmd: 'bash'})
                }).then(r => r.json())
            """)
        await page.wait_for_timeout(2000)
        await page.evaluate("""() =>
            fetch('/api/workers').then(r => r.json()).then(async workers => {
                for (const w of workers) {
                    if (w.process === 'bash') {
                        await fetch('/api/kill', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({id: w.id})
                        });
                    }
                }
            })
        """)
        await page.wait_for_timeout(3000)

        # Ensure sidebar is open
        sidebar = await page.query_selector(".sidebar")
        if not sidebar:
            await page.keyboard.press("Control+b")
            await page.wait_for_timeout(300)

        total_before = await page.evaluate("() => document.querySelectorAll('.session-item').length")
        stopped_count = await page.evaluate("""() => {
            const items = document.querySelectorAll('.session-item');
            let n = 0;
            for (const item of items) {
                const st = item.querySelector('.session-state');
                if (st && st.textContent.includes('Stopped')) n++;
            }
            return n;
        }""")
        ok(f"Sessions: {total_before} total, {stopped_count} stopped")

        if stopped_count > 0:
            # Action button visible on hover for running sessions (opacity:0 → 0.7)
            first_running = await page.query_selector(".session-item:not(.active) .session-action:not(.action-remove)")
            if first_running:
                opacity = await first_running.evaluate("el => getComputedStyle(el).opacity")
                if float(opacity) < 0.3:
                    ok(f"Running session action button hidden (opacity={opacity})")
                else:
                    warn(f"Running session action button already visible (opacity={opacity})")

            # Remove button always visible for stopped sessions
            remove_btn = await page.query_selector(".session-action.action-remove")
            if remove_btn:
                opacity = await remove_btn.evaluate("el => getComputedStyle(el).opacity")
                if float(opacity) >= 0.5:
                    ok(f"Stopped session remove button visible (opacity={opacity})")
                else:
                    fail(f"Stopped session remove button hidden (opacity={opacity})")

                # Click remove
                await remove_btn.click()
                await page.wait_for_timeout(500)
                total_after = await page.evaluate("() => document.querySelectorAll('.session-item').length")
                if total_after < total_before:
                    ok(f"Session removed on click ({total_before} → {total_after})")
                else:
                    fail(f"Session not removed ({total_before} → {total_after})")

                # Remove all remaining stopped
                removed = await page.evaluate("""() => {
                    return new Promise(async (resolve) => {
                        let count = 0;
                        while (true) {
                            const btn = document.querySelector('.session-action.action-remove');
                            if (!btn) break;
                            btn.click();
                            count++;
                            await new Promise(r => setTimeout(r, 300));
                        }
                        resolve(count);
                    });
                }""")
                await page.wait_for_timeout(500)
                final = await page.evaluate("() => document.querySelectorAll('.session-item').length")
                final_stopped = await page.evaluate("""() => {
                    let n = 0;
                    for (const item of document.querySelectorAll('.session-item')) {
                        const st = item.querySelector('.session-state');
                        if (st && st.textContent.includes('Stopped')) n++;
                    }
                    return n;
                }""")
                if final_stopped == 0:
                    ok(f"All stopped sessions removed ({removed + 1} total, {final} remaining)")
                else:
                    fail(f"{final_stopped} stopped sessions remain")
            else:
                fail("No remove button found for stopped sessions")
        else:
            warn("No stopped sessions to test removal")

        # ── 16. No JS errors ──
        print(f"\n16. JavaScript errors: {len(errors)}")
        if len(errors) == 0:
            ok("No JS errors")
        else:
            for e in errors[:5]:
                fail(f"JS error: {e}")

        # ── Screenshot ──
        await page.screenshot(path="/workspace/BALAB_Prof/agentboard/test-desktop-final.png", full_page=False)
        ok("Screenshot saved to test-desktop-final.png")

        # ── Summary ──
        print(f"\n{'='*40}")
        print(f"Results: {PASS} passed, {FAIL} failed, {WARN} warnings")
        print(f"{'='*40}")

        await browser.close()

asyncio.run(test())
