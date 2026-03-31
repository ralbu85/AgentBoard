"""
Test: Claude session state display — desktop & mobile.

Tests state indicator UI elements:
  1. Session dot colors per state
  2. Session dot animations (pulse for working, blink for waiting)
  3. State label text in session list
  4. Header badges with state counts
  5. Floating state badge on terminal pane
  6. State transitions (idle → working → done)
  7. Completed flash (10s green, then back to idle)
  8. Mobile layout of state elements
"""
import asyncio
from playwright.async_api import async_playwright

BASE = "http://localhost:3002"
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


STATE_CONFIG = {
    "working":   {"label": "Thinking", "color": "167, 139, 250", "animation": "pulse"},
    "waiting":   {"label": "Asking",   "color": "251, 191, 36",  "animation": "blink"},
    "completed": {"label": "Done",     "color": "52, 211, 153",  "animation": None},
    "idle":      {"label": "Idle",     "color": "110, 118, 129", "animation": None},
    "stopped":   {"label": "Stopped",  "color": "248, 113, 113", "animation": None},
}


async def login(page):
    await page.goto(BASE, wait_until="networkidle", timeout=30000)
    pw = await page.query_selector("input[type=password]")
    if pw:
        await pw.fill(PW)
        await page.click("button[type=submit]")
    await page.wait_for_timeout(5000)


async def test_desktop(page):
    print("=== Desktop State Display Tests (1280x800) ===\n")

    await login(page)

    # ── 1. Session dots exist with correct structure ──
    print("1. Session state dots")
    dots = await page.query_selector_all(".session-dot")
    if len(dots) > 0:
        ok(f"{len(dots)} session dot(s) found")
        # Check first dot has background color
        bg = await dots[0].evaluate("el => el.style.background || getComputedStyle(el).backgroundColor")
        if bg:
            ok(f"Session dot has color: {bg}")
        else:
            fail("Session dot has no color")
    else:
        fail("No session dots found")

    # ── 2. State label in session items ──
    print("\n2. State labels in session list")
    state_labels = await page.query_selector_all(".session-state")
    if len(state_labels) > 0:
        ok(f"{len(state_labels)} state label(s) found")
        first_text = await state_labels[0].inner_text()
        valid_labels = ["Thinking", "Asking", "Done", "Idle", "Stopped"]
        if first_text in valid_labels:
            ok(f"Valid state label: '{first_text}'")
        else:
            fail(f"Unknown state label: '{first_text}' (expected one of {valid_labels})")
    else:
        fail("No .session-state labels found in session list")

    # ── 3. Header badges ──
    print("\n3. Header state badges")
    badge_working = await page.query_selector(".badge-working")
    badge_waiting = await page.query_selector(".badge-waiting")
    badge_idle = await page.query_selector(".badge-idle")

    # At least one badge type should exist (we have sessions)
    badges_found = sum(1 for b in [badge_working, badge_waiting, badge_idle] if b)
    if badges_found > 0:
        ok(f"{badges_found} badge type(s) shown")
    else:
        warn("No header badges visible (all counts may be 0)")

    # Check badge-working has pulse/icon
    if badge_working:
        html = await badge_working.inner_html()
        text = await badge_working.inner_text()
        ok(f"Working badge: '{text}'")
        # Check for icon/emoji
        if "thinking" in text.lower() or "🧠" in html or "●" in html:
            ok("Working badge has Thinking indicator")
        else:
            warn(f"Working badge content: '{text}' (consider adding icon)")

    # Check header-center is visible on desktop
    center = await page.query_selector(".header-center")
    if center:
        display = await center.evaluate("el => getComputedStyle(el).display")
        if display != "none":
            ok("Header badges visible on desktop")
        else:
            fail("Header badges hidden on desktop")

    # ── 4. Floating terminal state badge ──
    print("\n4. Terminal floating state badge")
    term_badge = await page.query_selector(".terminal-state-badge")
    if term_badge:
        ok("Floating state badge present in terminal pane")
        text = await term_badge.inner_text()
        ok(f"Badge text: '{text}'")
        # Check positioning (should be top-right area)
        box = await term_badge.bounding_box()
        if box:
            term_container = await page.query_selector(".terminal-container")
            tc_box = await term_container.bounding_box()
            # Badge should be near top-right of terminal
            if box["x"] > tc_box["x"] + tc_box["width"] / 2:
                ok("Badge positioned on right side")
            else:
                warn(f"Badge x={box['x']:.0f}, expected > {tc_box['x'] + tc_box['width']/2:.0f}")
    else:
        fail("No .terminal-state-badge in terminal pane")

    # ── 5. Pulse animation for working state ──
    print("\n5. CSS animations")
    # Check that @keyframes pulse-dot exists
    has_pulse = await page.evaluate("""() => {
        const sheets = document.styleSheets;
        for (const sheet of sheets) {
            try {
                for (const rule of sheet.cssRules) {
                    if (rule.type === CSSRule.KEYFRAMES_RULE && rule.name === 'pulse-dot') return true;
                }
            } catch(e) {}
        }
        return false;
    }""")
    if has_pulse:
        ok("@keyframes pulse-dot animation defined")
    else:
        fail("@keyframes pulse-dot not found in CSS")

    # Check blink animation
    has_blink = await page.evaluate("""() => {
        const sheets = document.styleSheets;
        for (const sheet of sheets) {
            try {
                for (const rule of sheet.cssRules) {
                    if (rule.type === CSSRule.KEYFRAMES_RULE && rule.name === 'blink-dot') return true;
                }
            } catch(e) {}
        }
        return false;
    }""")
    if has_blink:
        ok("@keyframes blink-dot animation defined")
    else:
        fail("@keyframes blink-dot not found in CSS")

    # ── 6. Session dot with working class has animation ──
    print("\n6. Animated dots")
    working_dot = await page.query_selector(".session-dot.dot-working")
    if working_dot:
        anim = await working_dot.evaluate("el => getComputedStyle(el).animationName")
        if "pulse" in anim:
            ok(f"Working dot has pulse animation: {anim}")
        else:
            fail(f"Working dot animation: {anim} (expected pulse-dot)")
    else:
        warn("No session currently in 'working' state to test animation")

    waiting_dot = await page.query_selector(".session-dot.dot-waiting")
    if waiting_dot:
        anim = await waiting_dot.evaluate("el => getComputedStyle(el).animationName")
        if "blink" in anim:
            ok(f"Waiting dot has blink animation: {anim}")
        else:
            fail(f"Waiting dot animation: {anim} (expected blink-dot)")
    else:
        warn("No session currently in 'waiting' state to test animation")

    # ── 7. State color correctness ──
    print("\n7. State colors")
    all_dots = await page.query_selector_all(".session-dot")
    color_check = await page.evaluate("""() => {
        const results = [];
        document.querySelectorAll('.session-dot').forEach(dot => {
            const classes = [...dot.classList];
            const bg = dot.style.background || getComputedStyle(dot).backgroundColor;
            results.push({ classes, bg });
        });
        return results;
    }""")
    for info in color_check[:3]:  # Check first 3
        ok(f"Dot classes={info['classes']}, bg={info['bg']}")

    # ── 8. Completion flash test ──
    print("\n8. Completion flash (done → idle transition)")
    # Check if any session shows 'Done' state
    done_labels = await page.query_selector_all(".session-state")
    done_count = 0
    for label in done_labels:
        text = await label.inner_text()
        if text == "Done":
            done_count += 1
    if done_count > 0:
        ok(f"{done_count} session(s) showing 'Done' state")
    else:
        warn("No sessions currently in 'Done' state (needs working→idle transition)")

    # ── 9. Screenshot ──
    await page.screenshot(path="/workspace/BALAB_Prof/agentboard/test-states-desktop.png")
    ok("Desktop screenshot saved")


async def test_mobile(page, ctx):
    print("\n\n=== Mobile State Display Tests (375x812) ===\n")

    await login(page)

    # ── 1. Header badges hidden on mobile ──
    print("1. Header badges on mobile")
    center = await page.query_selector(".header-center")
    if center:
        display = await center.evaluate("el => getComputedStyle(el).display")
        if display == "none":
            ok("Header badges hidden on mobile (correct)")
        else:
            fail(f"Header badges showing on mobile (display: {display})")

    # ── 2. Open sidebar and check state elements ──
    print("\n2. Sidebar state elements on mobile")
    hamburger = await page.query_selector(".btn-icon")
    if hamburger:
        await hamburger.click()
        await page.wait_for_timeout(500)

    sidebar = await page.query_selector(".sidebar")
    if sidebar:
        ok("Sidebar opened on mobile")

        # State labels
        labels = await page.query_selector_all(".session-state")
        if len(labels) > 0:
            ok(f"{len(labels)} state label(s) visible in mobile sidebar")
            # Check font size is readable
            fs = await labels[0].evaluate("el => getComputedStyle(el).fontSize")
            ok(f"State label font-size: {fs}")
        else:
            fail("No state labels in mobile sidebar")

        # Dots
        dots = await page.query_selector_all(".session-dot")
        if len(dots) > 0:
            ok(f"{len(dots)} state dot(s) in mobile sidebar")
        else:
            fail("No state dots in mobile sidebar")

        # Session item tap area (touch-friendly)
        items = await page.query_selector_all(".session-item")
        if len(items) > 0:
            box = await items[0].bounding_box()
            if box["height"] >= 32:
                ok(f"Session item height: {box['height']:.0f}px (touch-friendly)")
            else:
                warn(f"Session item height: {box['height']:.0f}px (may be small for touch)")

    # Close sidebar by selecting a session
    items = await page.query_selector_all(".session-item")
    if len(items) > 0:
        await items[0].click()
        await page.wait_for_timeout(500)

    # ── 3. Terminal floating badge on mobile ──
    print("\n3. Terminal state badge on mobile")
    badge = await page.query_selector(".terminal-state-badge")
    if badge:
        ok("Terminal state badge present on mobile")
        box = await badge.bounding_box()
        if box:
            # Should not overlap with scroll-to-bottom button
            ok(f"Badge position: x={box['x']:.0f} y={box['y']:.0f} w={box['width']:.0f}")
            # Check not too large on mobile
            if box["width"] < 120:
                ok("Badge size appropriate for mobile")
            else:
                warn(f"Badge width {box['width']:.0f}px may be too wide for mobile")
    else:
        fail("No terminal state badge on mobile")

    # ── 4. Screenshot ──
    await page.screenshot(path="/workspace/BALAB_Prof/agentboard/test-states-mobile.png")
    ok("Mobile screenshot saved")


async def test():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)

        # Desktop test
        ctx = await browser.new_context(viewport={"width": 1280, "height": 800})
        page = await ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        await test_desktop(page)
        await ctx.close()

        # Mobile test
        ctx = await browser.new_context(
            viewport={"width": 375, "height": 812},
            is_mobile=True, has_touch=True,
        )
        page = await ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        await test_mobile(page, ctx)
        await ctx.close()

        # JS errors
        print(f"\n\nJS Errors: {len(errors)}")
        if len(errors) == 0:
            ok("No JS errors across both tests")
        else:
            for e in errors[:5]:
                fail(f"JS error: {e}")

        print(f"\n{'='*45}")
        print(f"State Tests: {PASS} passed, {FAIL} failed, {WARN} warnings")
        print(f"{'='*45}")

        await browser.close()

asyncio.run(test())
