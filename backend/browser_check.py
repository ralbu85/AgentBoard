"""Safe connection check: python -m backend.browser_check. No external navigation."""
import asyncio
import json
from playwright.async_api import async_playwright
from .browser_security import launch_browser, BrowserSecurityError


async def check():
    async with async_playwright() as playwright:
        browser = await launch_browser(playwright)
        try:
            context = await browser.new_context()
            try:
                page = await context.new_page()
                await page.goto('about:blank')
                assert await page.evaluate('1 + 1') == 2
                return {'ok': True, 'page_execution': True, 'sandbox_required': True}
            finally:
                await context.close()
        finally:
            await browser.close()


if __name__ == '__main__':
    try:
        print(json.dumps(asyncio.run(check())))
    except Exception as error:
        # Playwright errors can contain a private worker endpoint. Never emit it.
        print(json.dumps({'ok': False, 'reason': str(error) if isinstance(error, BrowserSecurityError)
                          else 'Safe browser connection failed; check worker privately.'}, ensure_ascii=False))
        raise SystemExit(2)
