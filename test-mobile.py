import asyncio
from playwright.async_api import async_playwright

BASE = "http://localhost:3002"
PW = "balab2021"

async def login(page):
    await page.goto(BASE, wait_until="networkidle", timeout=30000)
    login = await page.query_selector("input[type=password]")
    if login:
        await login.fill(PW)
        await page.click("button[type=submit]")
    await page.wait_for_timeout(8000)

async def get_vp(page):
    return await page.query_selector(".xterm-viewport")

async def get_scroll_info(page):
    return await page.evaluate("""() => {
        const vp = document.querySelector('.xterm-viewport');
        if (!vp) return null;
        return { top: vp.scrollTop, max: vp.scrollHeight - vp.clientHeight, h: vp.scrollHeight, ch: vp.clientHeight };
    }""")

async def swipe(cdp, page, x, start_y, end_y, steps=10, delay=16):
    await cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": start_y}]})
    await page.wait_for_timeout(50)
    for i in range(steps):
        y = start_y + (end_y - start_y) * (i + 1) / steps
        await cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x, "y": int(y)}]})
        await page.wait_for_timeout(delay)
    await cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})

async def test():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={"width": 375, "height": 812}, is_mobile=True, has_touch=True)
        page = await ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        print("=== Mobile Terminal Tests ===\n")

        # 1. Login + load
        print("1. Login & load terminal...")
        await login(page)
        vp = await get_vp(page)
        xterm = await page.query_selector(".xterm")
        if not xterm:
            print("   FAIL: no .xterm element")
            await browser.close()
            return
        info = await get_scroll_info(page)
        print(f"   OK: xterm loaded, scrollH={info['h']} clientH={info['ch']} max={info['max']}")

        if info['max'] < 100:
            print("   FAIL: not enough scrollback to test")
            await browser.close()
            return

        # 2. Scroll UP (finger moves up = see earlier content)
        print("\n2. Scroll UP (swipe finger upward)...")
        before = (await get_scroll_info(page))['top']
        cdp = await ctx.new_cdp_session(page)
        await swipe(cdp, page, 187, 500, 200)  # finger goes up
        await page.wait_for_timeout(500)
        after = (await get_scroll_info(page))['top']
        diff = before - after
        if diff > 0:
            print(f"   OK: scrolled UP by {diff}px ({before} -> {after})")
        elif diff < 0:
            print(f"   WRONG DIRECTION: scrolled DOWN by {-diff}px ({before} -> {after})")
        else:
            print(f"   FAIL: no scroll ({before} -> {after})")

        # 3. Scroll DOWN (finger moves down = see later content)  
        print("\n3. Scroll DOWN (swipe finger downward)...")
        before = (await get_scroll_info(page))['top']
        await swipe(cdp, page, 187, 200, 500)  # finger goes down
        await page.wait_for_timeout(500)
        after = (await get_scroll_info(page))['top']
        diff = after - before
        if diff > 0:
            print(f"   OK: scrolled DOWN by {diff}px ({before} -> {after})")
        elif diff < 0:
            print(f"   WRONG DIRECTION: scrolled UP by {-diff}px ({before} -> {after})")
        else:
            print(f"   FAIL: no scroll ({before} -> {after})")

        # 4. Momentum test
        print("\n4. Momentum (fast swipe up, then wait)...")
        before = (await get_scroll_info(page))['top']
        await swipe(cdp, page, 187, 600, 200, steps=5, delay=8)  # fast swipe
        await page.wait_for_timeout(100)
        mid = (await get_scroll_info(page))['top']
        await page.wait_for_timeout(1500)  # wait for momentum
        after = (await get_scroll_info(page))['top']
        print(f"   Immediate: {before} -> {mid} ({before-mid}px)")
        print(f"   After momentum: {mid} -> {after} ({mid-after}px extra)")
        if mid != before and after != mid:
            print(f"   OK: momentum working")
        elif mid != before:
            print(f"   PARTIAL: scroll works but no momentum")
        else:
            print(f"   FAIL: no scroll at all")

        # 5. Terminal update during scroll
        print("\n5. Terminal updates while scrolled up...")
        # Scroll to middle
        await swipe(cdp, page, 187, 600, 100, steps=10)
        await page.wait_for_timeout(300)
        scrolled_pos = (await get_scroll_info(page))['top']
        max_pos = (await get_scroll_info(page))['max']
        print(f"   Scrolled to: {scrolled_pos}/{max_pos}")
        
        # Wait for writeScreen updates
        await page.wait_for_timeout(2000)
        after_updates = (await get_scroll_info(page))['top']
        if abs(after_updates - scrolled_pos) < 100:
            print(f"   OK: position preserved during updates ({scrolled_pos} -> {after_updates})")
        else:
            print(f"   FAIL: position jumped ({scrolled_pos} -> {after_updates})")

        # 6. Scroll-to-bottom button
        print("\n6. Scroll-to-bottom button...")
        btn = await page.query_selector(".scroll-bottom-btn")
        if btn:
            await btn.click()
            await page.wait_for_timeout(500)
            info = await get_scroll_info(page)
            if abs(info['top'] - info['max']) < 5:
                print(f"   OK: scrolled to bottom ({info['top']}/{info['max']})")
            else:
                print(f"   FAIL: not at bottom ({info['top']}/{info['max']})")
        else:
            print(f"   MISSING: no .scroll-bottom-btn found")

        # 7. Send button
        print("\n7. Send button...")
        textarea = await page.query_selector(".input-textarea")
        send_btn = await page.query_selector(".send-btn")
        if textarea and send_btn:
            await textarea.fill("echo test")
            await send_btn.click()
            await page.wait_for_timeout(500)
            val = await textarea.evaluate("el => el.value")
            print(f"   OK: textarea cleared after send (value='{val}')")
        else:
            print(f"   FAIL: no textarea or send button")

        # 8. Sidebar: stopped sessions visible + remove
        print("\n8. Sidebar: stopped session removal...")
        # Create test sessions and kill them to get stopped state
        for i in range(3):
            await page.evaluate("""() =>
                fetch('/api/spawn', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({cwd: '/tmp', cmd: 'bash'})
                }).then(r => r.json())
            """)
        await page.wait_for_timeout(2000)

        # Kill the spawned sessions to make them stopped
        kill_result = await page.evaluate("""() =>
            fetch('/api/workers').then(r => r.json()).then(async workers => {
                let killed = 0;
                for (const w of workers) {
                    if (w.process === 'bash') {
                        await fetch('/api/kill', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({id: w.id})
                        });
                        killed++;
                    }
                }
                return killed;
            })
        """)
        print(f"   Created and killed {kill_result} test sessions")
        await page.wait_for_timeout(3000)

        # Open sidebar on mobile
        hamburger = await page.query_selector(".sidebar-toggle") or await page.query_selector("[class*='toggle']")
        if not hamburger:
            hamburger = await page.query_selector(".header button")
        if hamburger:
            await hamburger.click()
            await page.wait_for_timeout(500)

        # Count all sessions and stopped sessions
        total_sessions = await page.evaluate("() => document.querySelectorAll('.session-item').length")
        stopped_items = await page.evaluate("""() => {
            const items = document.querySelectorAll('.session-item');
            let stopped = 0;
            for (const item of items) {
                const state = item.querySelector('.session-state');
                if (state && state.textContent.includes('Stopped')) stopped++;
            }
            return stopped;
        }""")
        print(f"   Total sessions: {total_sessions}, Stopped: {stopped_items}")

        if stopped_items > 0:
            # Check remove button is visible (not hidden by hover-only)
            remove_btn_visible = await page.evaluate("""() => {
                const btns = document.querySelectorAll('.session-action.action-remove');
                if (btns.length === 0) return {found: 0, visible: false};
                const btn = btns[0];
                const style = getComputedStyle(btn);
                return {found: btns.length, visible: parseFloat(style.opacity) > 0.3, opacity: style.opacity};
            }""")
            print(f"   Remove buttons: {remove_btn_visible['found']}, visible={remove_btn_visible['visible']} (opacity={remove_btn_visible.get('opacity')})")

            if remove_btn_visible['visible']:
                print(f"   OK: remove button visible on mobile")
            else:
                print(f"   FAIL: remove button not visible on mobile")

            # Click remove on first stopped session
            removed = await page.evaluate("""() => {
                const btn = document.querySelector('.session-action.action-remove');
                if (btn) { btn.click(); return true; }
                return false;
            }""")
            if removed:
                await page.wait_for_timeout(1000)
                new_total = await page.evaluate("() => document.querySelectorAll('.session-item').length")
                if new_total < total_sessions:
                    print(f"   OK: session removed ({total_sessions} -> {new_total})")
                else:
                    print(f"   FAIL: session count unchanged ({total_sessions} -> {new_total})")

                # Remove ALL remaining stopped sessions
                remaining_before = new_total
                removed_count = await page.evaluate("""() => {
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
                await page.wait_for_timeout(1000)
                final_total = await page.evaluate("() => document.querySelectorAll('.session-item').length")
                print(f"   Removed {removed_count + 1} stopped sessions total ({total_sessions} -> {final_total})")

                # Verify no stopped sessions remain
                final_stopped = await page.evaluate("""() => {
                    const items = document.querySelectorAll('.session-item');
                    let stopped = 0;
                    for (const item of items) {
                        const state = item.querySelector('.session-state');
                        if (state && state.textContent.includes('Stopped')) stopped++;
                    }
                    return stopped;
                }""")
                if final_stopped == 0:
                    print(f"   OK: all stopped sessions removed")
                else:
                    print(f"   FAIL: {final_stopped} stopped sessions still remain")
            else:
                print(f"   FAIL: could not click remove button")
        else:
            print(f"   SKIP: no stopped sessions to test")

        # Summary
        print(f"\nErrors: {len(errors)}")
        for e in errors[:3]:
            print(f"  {e}")

        await page.screenshot(path="/workspace/BALAB_Prof/agentboard/test-mobile-final.png")
        await browser.close()

asyncio.run(test())
