"""Browser isolation policy. Never retry a failed sandbox with weaker flags."""
from __future__ import annotations
import os
from urllib.parse import urlsplit
from .security_audit import audit

UNSAFE_SWITCHES = {'--no-sandbox', '--disable-setuid-sandbox', '--disable-namespace-sandbox',
                   '--disable-seccomp-filter-sandbox', '--disable-web-security'}


class BrowserSecurityError(ValueError):
    pass


def worker_endpoint(value: str) -> str:
    parsed = urlsplit(value)
    if (parsed.scheme not in ('ws', 'wss') or not parsed.hostname or parsed.username or parsed.password
            or (parsed.scheme == 'ws' and parsed.hostname not in ('127.0.0.1', '::1', 'localhost'))):
        raise BrowserSecurityError('브라우저 작업자는 로컬 연결 또는 암호화된 전용 연결이 필요합니다.')
    return value


def assert_safe_arguments(arguments):
    if not isinstance(arguments, list) or not arguments or any(not isinstance(a, str) for a in arguments):
        raise BrowserSecurityError('브라우저 보호 설정을 확인하지 못했습니다.')
    if any(a.split('=', 1)[0] in UNSAFE_SWITCHES for a in arguments):
        raise BrowserSecurityError('보호 설정이 꺼진 브라우저에는 연결할 수 없습니다.')


async def launch_browser(playwright):
    endpoint = os.getenv('AGENTBOARD_BROWSER_WS_ENDPOINT', '').strip()
    if endpoint:
        # The supplied worker also refuses root and always enables the sandbox.
        # A remote endpoint is an operator-managed trust boundary; verify its
        # effective browser switches before creating any page or loading state.
        browser = await playwright.chromium.connect(worker_endpoint(endpoint))
        try:
            cdp = await browser.new_browser_cdp_session()
            try:
                command = await cdp.send('Browser.getBrowserCommandLine')
                assert_safe_arguments(command.get('arguments'))
            finally:
                await cdp.detach()
        except Exception:
            await browser.close()
            raise BrowserSecurityError('브라우저 격리를 확인하지 못해 연결을 차단했습니다.') from None
        return browser
    if hasattr(os, 'geteuid') and os.geteuid() == 0:
        audit.write('browser.launch', result='root_blocked')
        raise BrowserSecurityError('서버의 루트 브라우저 실행을 차단했습니다. 데스크톱 앱 또는 격리된 브라우저 작업자를 이용해 주세요.')
    try:
        return await playwright.chromium.launch(channel='chromium', headless=True, chromium_sandbox=True)
    except Exception:
        raise BrowserSecurityError('안전한 Chromium 실행 환경이 준비되지 않았습니다. 샌드박스를 지원하는 브라우저 작업자가 필요합니다.') from None
