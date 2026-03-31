"""
Mobile test: File browser, preview (PDF/code/markdown), upload.
"""
import asyncio
import os
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
    test_dir = "/tmp/agentboard-test-files"
    os.makedirs(test_dir, exist_ok=True)
    with open(f"{test_dir}/hello.py", "w") as f:
        f.write('def greet(name):\n    """Say hello."""\n    print(f"Hello, {name}!")\n\ngreet("world")\n')
    with open(f"{test_dir}/README.md", "w") as f:
        f.write("# Test Project\n\nThis is a **test** markdown file.\n\n## Features\n- File browsing\n- Preview\n")
    with open(f"{test_dir}/data.json", "w") as f:
        f.write('{"name": "test", "version": 1, "items": [1, 2, 3]}\n')
    os.makedirs(f"{test_dir}/subdir", exist_ok=True)
    with open(f"{test_dir}/subdir/nested.txt", "w") as f:
        f.write("Nested file content\n")
    # Create a small test PDF (minimal valid PDF)
    pdf_bytes = b"""%PDF-1.0
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<<>>>>endobj
xref
0 4
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
trailer<</Size 4/Root 1 0 R>>
startxref
206
%%EOF"""
    with open(f"{test_dir}/test.pdf", "wb") as f:
        f.write(pdf_bytes)

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={"width": 375, "height": 812}, is_mobile=True, has_touch=True)
        page = await ctx.new_page()
        await login(page)

        print("=== Mobile File Browser Tests ===\n")

        # ── 1. Open file browser ──
        print("1. Open file browser from session")
        # Click the file browser button (folder icon in input card area)
        file_btn = await page.query_selector(".file-browse-btn")
        if not file_btn:
            # Try finding any folder/file icon button
            file_btn = await page.query_selector("[data-action='browse']")
        if file_btn:
            await file_btn.click()
            await page.wait_for_timeout(1000)
            ok("File browser button found and clicked")
        else:
            fail("File browser button not found — checking if panel exists anyway")

        # Check if file panel is open
        file_panel = await page.query_selector(".file-panel")
        if not file_panel:
            fail("File panel not rendered")
            await browser.close()
            return

        ok("File panel opened")

        # ── 2. Navigate to test directory ──
        print("\n2. Navigate to test directory")
        # Use the path bar or navigate via API
        nav_result = await page.evaluate(f"""() =>
            fetch('/api/files?path={test_dir}').then(r => r.json())
        """)
        if nav_result.get("entries"):
            ok(f"API returns {len(nav_result['entries'])} entries for test dir")
        else:
            fail("API returned no entries")

        # Navigate in the UI
        path_input = await page.query_selector(".file-path-input")
        if path_input:
            await path_input.fill(test_dir)
            await path_input.press("Enter")
            await page.wait_for_timeout(1000)
            ok("Navigated via path input")
        else:
            # Try clicking breadcrumb or using other navigation
            await page.evaluate(f"""() => {{
                const event = new CustomEvent('navigate-path', {{ detail: '{test_dir}' }});
                window.dispatchEvent(event);
            }}""")
            await page.wait_for_timeout(500)

        # ── 3. Directory listing ──
        print("\n3. Directory listing")
        entries = await page.query_selector_all(".fp-entry")
        if len(entries) > 0:
            ok(f"{len(entries)} entries displayed")
            # Check for expected files
            entry_names = await page.evaluate("""() =>
                [...document.querySelectorAll('.fp-entry .file-name')].map(e => e.textContent)
            """)
            expected = ["subdir", "data.json", "hello.py", "README.md", "test.pdf"]
            found = [e for e in expected if e in entry_names]
            if len(found) >= 4:
                ok(f"Expected files found: {found}")
            else:
                fail(f"Missing files. Found: {entry_names}, Expected: {expected}")

            # Check directory icon vs file icon
            dir_entries = await page.query_selector_all(".fp-entry.is-dir")
            file_entries_el = await page.query_selector_all(".fp-entry.is-file")
            if len(dir_entries) >= 1:
                ok(f"Directory entries styled differently ({len(dir_entries)} dirs)")
            else:
                warn("No directory entries with .is-dir class")
        else:
            fail("No file entries displayed")

        # ── 4. Navigate into subdirectory ──
        print("\n4. Subdirectory navigation")
        subdir_entry = await page.query_selector(".fp-entry.is-dir")
        if subdir_entry:
            await subdir_entry.click()
            await page.wait_for_timeout(1000)
            # Check path changed
            current_path = await page.evaluate("""() =>
                document.querySelector('.file-path-input')?.value ||
                document.querySelector('.file-breadcrumb')?.textContent || ''
            """)
            if "subdir" in current_path:
                ok(f"Navigated into subdir (path: {current_path})")
            else:
                warn(f"Path unclear after navigation: {current_path}")

            # Check nested.txt is visible
            nested = await page.evaluate("""() =>
                [...document.querySelectorAll('.file-name')].some(e => e.textContent.includes('nested'))
            """)
            if nested:
                ok("Nested file visible")
            else:
                fail("Nested file not visible after navigation")

            # Go back (parent directory) — first nav-btn is the back arrow
            back_btn = await page.query_selector(".file-back-btn") or await page.query_selector(".file-nav-btn")
            if back_btn:
                await back_btn.click()
                await page.wait_for_timeout(500)
                ok("Back button works")
            else:
                # Navigate back via path input
                await page.evaluate(f"""() => {{
                    const inp = document.querySelector('.file-path-input');
                    if (inp) {{ inp.value = '{test_dir}'; inp.dispatchEvent(new Event('change')); inp.dispatchEvent(new KeyboardEvent('keydown', {{key:'Enter'}})); }}
                }}""")
                await page.wait_for_timeout(500)
                warn("No back button found, navigated via path")
        else:
            warn("No subdirectory entry to click")

        # ── 5. Code file preview ──
        print("\n5. Code file preview (hello.py)")
        py_entry = await page.evaluate("""() => {
            const entries = document.querySelectorAll('.fp-entry');
            for (const e of entries) {
                if (e.querySelector('.file-name')?.textContent?.includes('hello.py')) {
                    e.click();
                    return true;
                }
            }
            return false;
        }""")
        if py_entry:
            await page.wait_for_timeout(1000)
            preview = await page.query_selector(".file-viewer")
            if preview:
                ok("Preview panel opened")
                body = await preview.query_selector(".fv-body")
                content = await body.inner_text() if body else await preview.inner_text()
                if "def greet" in content:
                    ok("Python code content displayed")
                else:
                    fail(f"Code content not visible: {content[:100]}")

                # Check syntax highlighting or code block
                code_el = await preview.query_selector("pre, code, .fv-code")
                if code_el:
                    ok("Code displayed in pre/code element")
                else:
                    warn("No pre/code element (plain text display)")
            else:
                fail("Preview panel not opened for .py file")
        else:
            fail("Could not click hello.py")

        # Close preview
        close_btn = await page.query_selector(".fv-back")
        if close_btn:
            await close_btn.click()
            await page.wait_for_timeout(300)

        # ── 6. Markdown preview ──
        print("\n6. Markdown preview (README.md)")
        md_entry = await page.evaluate("""() => {
            const entries = document.querySelectorAll('.fp-entry');
            for (const e of entries) {
                if (e.querySelector('.file-name')?.textContent?.includes('README.md')) {
                    e.click();
                    return true;
                }
            }
            return false;
        }""")
        if md_entry:
            await page.wait_for_timeout(1000)
            preview = await page.query_selector(".file-viewer")
            if preview:
                # Check for rendered markdown (h1, bold, list)
                body = await preview.query_selector(".fv-body")
                el = body or preview
                has_heading = await el.query_selector("h1, h2")
                has_bold = await el.evaluate("el => el.innerHTML.includes('<strong>') || el.innerHTML.includes('<b>')")
                has_list = await el.query_selector("ul, ol, li")
                content = await el.inner_text()

                if "Test Project" in content:
                    ok("Markdown content displayed")
                else:
                    fail(f"Markdown content missing: {content[:100]}")

                if has_heading:
                    ok("Markdown headings rendered")
                elif "# " not in content:
                    ok("Markdown appears rendered (no raw # symbols)")
                else:
                    warn("Markdown may not be rendered (raw # visible)")

                if has_bold or "**" not in content:
                    ok("Markdown bold rendered")
                else:
                    warn("Markdown bold not rendered")
            else:
                fail("Preview not opened for .md file")
        else:
            fail("Could not click README.md")

        close_btn = await page.query_selector(".fv-back")
        if close_btn:
            await close_btn.click()
            await page.wait_for_timeout(300)

        # ── 7. PDF preview ──
        print("\n7. PDF preview (test.pdf)")
        pdf_entry = await page.evaluate("""() => {
            const entries = document.querySelectorAll('.fp-entry');
            for (const e of entries) {
                if (e.querySelector('.file-name')?.textContent?.includes('test.pdf')) {
                    e.click();
                    return true;
                }
            }
            return false;
        }""")
        if pdf_entry:
            await page.wait_for_timeout(1500)
            preview = await page.query_selector(".file-viewer")
            if preview:
                # PDF rendered via pdf.js canvas elements
                await page.wait_for_timeout(3000)  # Wait for pdf.js rendering
                pdf_canvas = await preview.query_selector(".pdf-pages canvas")
                pdf_container = await preview.query_selector(".pdf-container")
                if pdf_canvas:
                    ok("PDF rendered via pdf.js (canvas)")
                    page_count = await preview.evaluate("() => document.querySelectorAll('.pdf-pages canvas').length")
                    ok(f"PDF pages rendered: {page_count}")
                elif pdf_container:
                    # Might still be loading or errored
                    fallback = await preview.query_selector(".fv-pdf-fallback")
                    if fallback:
                        text = await fallback.inner_text()
                        fail(f"PDF failed to render: {text}")
                    else:
                        warn("PDF container present but no canvas yet (still loading?)")
                else:
                    fail("No PDF viewer element found")
            else:
                fail("Preview not opened for .pdf file")
        else:
            fail("Could not click test.pdf")

        close_btn = await page.query_selector(".fv-back")
        if close_btn:
            await close_btn.click()
            await page.wait_for_timeout(300)

        # ── 8. File upload ──
        print("\n8. File upload")
        upload_btn = await page.query_selector(".file-upload-btn, [data-action='upload']")
        if upload_btn:
            ok("Upload button found")

            # Create a test file to upload
            upload_file = "/tmp/upload-test.txt"
            with open(upload_file, "w") as f:
                f.write("Uploaded from mobile test!\n")

            # Trigger file input
            file_input = await page.query_selector("input[type='file']")
            if file_input:
                await file_input.set_input_files(upload_file)
                await page.wait_for_timeout(2000)

                # Check if uploaded file appears in listing
                uploaded_visible = await page.evaluate("""() =>
                    [...document.querySelectorAll('.file-name')].some(e => e.textContent.includes('upload-test'))
                """)
                if uploaded_visible:
                    ok("Uploaded file appears in listing")
                else:
                    # Check via API
                    check = await page.evaluate(f"""() =>
                        fetch('/api/files?path={test_dir}').then(r => r.json())
                    """)
                    names = [e["name"] for e in check.get("entries", [])]
                    if "upload-test.txt" in names:
                        ok("File uploaded successfully (visible via API)")
                    else:
                        fail("Uploaded file not found")
            else:
                fail("No file input element found")
        else:
            fail("Upload button not found")

        # ── 9. File size display ──
        print("\n9. File metadata")
        size_el = await page.query_selector(".file-size")
        if size_el:
            size_text = await size_el.inner_text()
            ok(f"File size displayed: {size_text}")
        else:
            warn("No file size display")

        # ── 10. Swipe/scroll in file list ──
        print("\n10. File list scrollable on mobile")
        file_list = await page.query_selector(".file-list")
        if file_list:
            scrollable = await file_list.evaluate("el => el.scrollHeight > el.clientHeight || el.style.overflowY === 'auto'")
            ok(f"File list element present (scrollable={scrollable})")
        else:
            warn("No .file-list element")

        # ── Summary ──
        print(f"\n{'='*50}")
        print(f"File Browser Tests: {PASS} passed, {FAIL} failed, {WARN} warnings")
        print(f"{'='*50}")

        await page.screenshot(path="/workspace/BALAB_Prof/agentboard/test-files-final.png")
        await browser.close()

    # Cleanup
    import shutil
    shutil.rmtree(test_dir, ignore_errors=True)

asyncio.run(test())
