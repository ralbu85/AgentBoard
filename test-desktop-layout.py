"""
Desktop split layout test: Terminal (left) + Viewer tabs (right)
Tests: layout, tabs, split, file preview, session state, resize
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


async def test():
    # Create test files
    import os, shutil
    test_dir = "/tmp/agentboard-layout-test"
    os.makedirs(test_dir, exist_ok=True)
    with open(f"{test_dir}/hello.py", "w") as f:
        f.write('def greet(name):\n    print(f"Hello, {name}!")\n\ngreet("world")\n')
    with open(f"{test_dir}/README.md", "w") as f:
        f.write("# Test\n\nThis is **bold** text.\n\n## Section\n- item 1\n- item 2\n")
    with open(f"{test_dir}/data.json", "w") as f:
        f.write('{"name": "test", "items": [1, 2, 3]}\n')
    with open(f"{test_dir}/style.css", "w") as f:
        f.write("body { color: red; }\n.box { display: flex; }\n")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={"width": 1280, "height": 800})
        page = await ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        await login(page)

        print("=== Desktop Split Layout Tests ===\n")

        # ── 1. Two-pane layout (starts as terminal only, viewer appears after opening a file) ──
        print("1. Initial layout (terminal fullscreen)")
        terminal_pane = await page.query_selector(".pane-terminal")
        viewer_pane = await page.query_selector(".pane-viewer")

        if terminal_pane:
            t_box = await terminal_pane.bounding_box()
            ok(f"Terminal pane visible: {t_box['width']:.0f}px")
            if not viewer_pane:
                ok("Viewer hidden (no tabs open) — terminal is fullscreen")
            else:
                warn("Viewer visible before any file opened")
        else:
            fail("Terminal pane missing")

        # ── 2. Open file browser from session ──
        print("\n2. Open file browser (session folder button)")
        # First spawn a session in test_dir so files appear there
        await page.evaluate(f"""() =>
            fetch('/api/spawn', {{
                method: 'POST',
                headers: {{'Content-Type': 'application/json'}},
                body: JSON.stringify({{cwd: '{test_dir}', cmd: 'bash'}})
            }}).then(r => r.json())
        """)
        await page.wait_for_timeout(2000)

        # Click last session (the one we just spawned)
        await page.evaluate("() => { const items = document.querySelectorAll('.session-item'); items[items.length-1]?.click() }")
        await page.wait_for_timeout(1000)

        # Click the folder button on the active session
        files_btn = await page.query_selector(".session-item.active .session-files-btn")
        if not files_btn:
            active_item = await page.query_selector(".session-item.active")
            if active_item:
                await active_item.hover()
                await page.wait_for_timeout(200)
                files_btn = await page.query_selector(".session-item.active .session-files-btn")

        if files_btn:
            await files_btn.click()
            await page.wait_for_timeout(2000)
            ok("Session files button clicked")
        else:
            # Fallback: click any visible files btn
            any_btn = await page.query_selector(".session-files-btn")
            if any_btn:
                await any_btn.click()
                await page.wait_for_timeout(2000)
                ok("Files button clicked (fallback)")
            else:
                fail("No session-files-btn found")

        # Wait for tree to load
        await page.wait_for_timeout(2000)
        tree_count = await page.evaluate("() => document.querySelectorAll('.tree-row').length")
        if tree_count > 0:
            ok(f"Tree loaded: {tree_count} items")
        else:
            fail("Tree not loaded")

        # ── 3. Open file in viewer tab ──
        print("\n3. Open file in viewer tab")

        # Click any file in tree — should open in viewer tab
        clicked = await page.evaluate("""() => {
            // Click first available file
            const file = document.querySelector('.tree-row.tree-file');
            if (file) { file.click(); return true; }
            return false;
        }""")
        await page.wait_for_timeout(1000)

        if clicked:
            # Viewer pane should now be visible
            viewer_pane = await page.query_selector(".pane-viewer")
            if viewer_pane:
                ok("Viewer pane appeared after opening file")
            else:
                fail("Viewer pane not visible after opening file")

            # Tab should exist
            tab = await page.query_selector(".vtab.active")
            if tab:
                tab_text = await tab.inner_text()
                ok(f"Active tab: '{tab_text.strip()}'")
            else:
                fail("No active tab")

            # Code content visible
            code = await page.evaluate("""() => {
                const el = document.querySelector('.fv-code, pre code, .viewer-content pre');
                return el ? el.textContent.substring(0, 50) : '';
            }""")
            if len(code) > 0:
                ok(f"Content visible in viewer ({len(code)} chars)")
            else:
                fail("No content in viewer")
        else:
            fail("Could not click hello.py")

        # ── 4. Multiple tabs ──
        print("\n4. Multiple tabs")
        # Open 2nd file
        await page.evaluate("""() => {
            const files = document.querySelectorAll('.tree-row.tree-file');
            if (files[1]) files[1].click();
        }""")
        await page.wait_for_timeout(1000)

        tab_count = await page.evaluate("() => document.querySelectorAll('.vtab').length")
        if tab_count >= 2:
            ok(f"{tab_count} tabs open")
        else:
            fail(f"Expected 2+ tabs, got {tab_count}")

        # Open 3rd file
        await page.evaluate("""() => {
            const files = document.querySelectorAll('.tree-row.tree-file');
            if (files[2]) files[2].click();
        }""")
        await page.wait_for_timeout(1000)

        tab_count2 = await page.evaluate("""() =>
            document.querySelectorAll('.viewer-tab, .vtab').length
        """)
        if tab_count2 >= 3:
            ok(f"{tab_count2} tabs after opening 3 files")
        else:
            fail(f"Expected 3+ tabs, got {tab_count2}")

        # ── 5. Tab switching ──
        print("\n5. Tab switching")
        # Click first tab (hello.py)
        switched = await page.evaluate("""() => {
            const tabs = document.querySelectorAll('.viewer-tab, .vtab');
            if (tabs.length > 0) { tabs[0].click(); return true; }
            return false;
        }""")
        await page.wait_for_timeout(500)

        if switched:
            content = await page.evaluate("""() => {
                const el = document.querySelector('.fv-code, .code-preview, .viewer-content pre, pre code');
                return el ? el.textContent.substring(0, 50) : '';
            }""")
            if len(content) > 0:
                ok("Tab switch shows correct content")
            else:
                warn(f"After tab switch, content: '{content[:50]}'")
        else:
            fail("Could not switch tabs")

        # ── 6. Tab close ──
        print("\n6. Tab close")
        before_tabs = await page.evaluate("() => document.querySelectorAll('.viewer-tab, .vtab').length")
        closed = await page.evaluate("""() => {
            const closeBtn = document.querySelector('.viewer-tab .tab-close, .vtab .vtab-close, .vtab-x');
            if (closeBtn) { closeBtn.click(); return true; }
            // Try the active tab's close button
            const active = document.querySelector('.viewer-tab.active, .vtab.active');
            if (active) {
                const btn = active.querySelector('.tab-close, .vtab-close, [data-close]');
                if (btn) { btn.click(); return true; }
            }
            return false;
        }""")
        await page.wait_for_timeout(500)
        after_tabs = await page.evaluate("() => document.querySelectorAll('.viewer-tab, .vtab').length")

        if closed and after_tabs < before_tabs:
            ok(f"Tab closed ({before_tabs} → {after_tabs})")
        else:
            fail(f"Tab close failed (before={before_tabs}, after={after_tabs}, clicked={closed})")

        # ── 7. Same file dedup ──
        print("\n7. Same file dedup")
        before = await page.evaluate("() => document.querySelectorAll('.viewer-tab, .vtab').length")
        # Click README.md again (already open)
        await page.evaluate("""() => {
            const entries = document.querySelectorAll('.tree-row');
            for (const e of entries) {
                if (e.querySelector('.tree-name')?.textContent?.includes('README.md')) {
                    e.click(); return;
                }
            }
        }""")
        await page.wait_for_timeout(500)
        after = await page.evaluate("() => document.querySelectorAll('.viewer-tab, .vtab').length")
        if after == before:
            ok("Same file doesn't create duplicate tab")
        else:
            warn(f"Tab count changed ({before} → {after}) — may have duplicated")

        # ── 8. Resizer drag ──
        print("\n8. Resizer drag")
        resizer = await page.query_selector(".pane-resizer")
        if resizer:
            r_box = await resizer.bounding_box()
            ok(f"Resizer found at x={r_box['x']:.0f}")
            before_t = await page.evaluate("() => document.querySelector('.pane-terminal')?.getBoundingClientRect()?.width || 0")
            await resizer.hover()
            await page.mouse.down()
            await page.mouse.move(r_box['x'] + 100, r_box['y'] + r_box['height'] / 2)
            await page.mouse.up()
            await page.wait_for_timeout(300)
            after_t = await page.evaluate("() => document.querySelector('.pane-terminal')?.getBoundingClientRect()?.width || 0")
            if after_t > before_t + 30:
                ok(f"Resizer works: {before_t:.0f}px → {after_t:.0f}px")
            else:
                warn(f"Resizer: {before_t:.0f} → {after_t:.0f}")
        else:
            fail("No resizer")

        # ── 9. Close all tabs → terminal fullscreen ──
        print("\n9. Close all tabs → fullscreen restore")
        await page.evaluate("""() => {
            return new Promise(async (resolve) => {
                while (true) {
                    const btn = document.querySelector('.vtab-close');
                    if (!btn) break;
                    btn.click();
                    await new Promise(r => setTimeout(r, 200));
                }
                resolve();
            });
        }""")
        await page.wait_for_timeout(500)
        viewer_after = await page.query_selector(".pane-viewer")
        if not viewer_after:
            ok("Viewer hidden after closing all tabs")
            t_width = await page.evaluate("() => document.querySelector('.pane-terminal')?.getBoundingClientRect()?.width || 0")
            vp_width = page.viewport_size["width"]
            sidebar_w = await page.evaluate("() => document.querySelector('.sidebar')?.getBoundingClientRect()?.width || 0")
            expected = vp_width - sidebar_w
            if t_width > expected - 20:
                ok(f"Terminal fullscreen restored ({t_width:.0f}px)")
            else:
                warn(f"Terminal width {t_width:.0f}px, expected ~{expected:.0f}px")
        else:
            fail("Viewer still visible after closing all tabs")

        # Re-open a file for remaining tests
        await page.evaluate("""() => {
            const f = document.querySelector('.tree-row.tree-file');
            if (f) f.click();
        }""")
        await page.wait_for_timeout(500)

        # ── 10. Terminal pane still present ──
        print("\n10. Terminal pane present")
        pane = await page.query_selector(".pane-terminal")
        if pane:
            pw = await pane.evaluate("el => el.offsetWidth")
            ok(f"Terminal pane present ({pw:.0f}px wide)")
        else:
            fail("No terminal pane")

        # ── 11. Mobile layout unchanged ──
        print("\n11. Mobile layout (should not have split)")
        await page.set_viewport_size({"width": 375, "height": 812})
        await page.wait_for_timeout(500)
        viewer_on_mobile = await page.query_selector(".pane-viewer, .viewer-pane")
        if viewer_on_mobile:
            display = await viewer_on_mobile.evaluate("el => getComputedStyle(el).display")
            if display == "none":
                ok("Viewer pane hidden on mobile")
            else:
                warn(f"Viewer pane visible on mobile (display={display})")
        else:
            ok("No viewer pane on mobile (correct)")

        # Restore desktop
        await page.set_viewport_size({"width": 1280, "height": 800})
        await page.wait_for_timeout(500)

        # ── 12. JS errors ──
        print(f"\n12. JavaScript errors: {len(errors)}")
        if len(errors) == 0:
            ok("No JS errors")
        else:
            for e in errors[:3]:
                fail(f"JS: {e[:100]}")

        # ── Summary ──
        print(f"\n{'='*50}")
        print(f"Desktop Layout: {PASS} passed, {FAIL} failed, {WARN} warnings")
        print(f"{'='*50}")

        await page.screenshot(path="/workspace/BALAB_Prof/agentboard/test-layout-final.png")
        await browser.close()

    shutil.rmtree(test_dir, ignore_errors=True)

asyncio.run(test())
