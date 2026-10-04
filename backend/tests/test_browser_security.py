import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock
import pytest
from backend import browser_security as security


def test_root_is_rejected_before_a_browser_is_launched(monkeypatch):
    monkeypatch.delenv('AGENTBOARD_BROWSER_WS_ENDPOINT', raising=False)
    monkeypatch.setattr(security.os, 'geteuid', lambda: 0)
    launch = AsyncMock()
    with pytest.raises(security.BrowserSecurityError, match='루트'):
        asyncio.run(security.launch_browser(SimpleNamespace(chromium=SimpleNamespace(launch=launch))))
    launch.assert_not_awaited()


def test_normal_user_requires_sandbox_and_never_retries_without_it(monkeypatch):
    monkeypatch.delenv('AGENTBOARD_BROWSER_WS_ENDPOINT', raising=False)
    monkeypatch.setattr(security.os, 'geteuid', lambda: 1000)
    launch = AsyncMock(side_effect=RuntimeError('namespace denied'))
    with pytest.raises(security.BrowserSecurityError, match='샌드박스'):
        asyncio.run(security.launch_browser(SimpleNamespace(chromium=SimpleNamespace(launch=launch))))
    launch.assert_awaited_once_with(channel='chromium', headless=True, chromium_sandbox=True)


@pytest.mark.parametrize('url', ['ws://public.example/secret','http://localhost/','wss://u:p@example.com/','file:///tmp/socket'])
def test_remote_connection_rejects_insecure_endpoints(url):
    with pytest.raises(security.BrowserSecurityError):security.worker_endpoint(url)


@pytest.mark.parametrize('flags', [['chrome','--no-sandbox'],['chrome','--disable-seccomp-filter-sandbox'],None])
def test_worker_with_disabled_or_unverifiable_sandbox_is_disconnected(monkeypatch,flags):
    monkeypatch.setenv('AGENTBOARD_BROWSER_WS_ENDPOINT','ws://127.0.0.1:3023/private')
    cdp=SimpleNamespace(send=AsyncMock(return_value={'arguments':flags}),detach=AsyncMock())
    browser=SimpleNamespace(new_browser_cdp_session=AsyncMock(return_value=cdp),close=AsyncMock())
    pw=SimpleNamespace(chromium=SimpleNamespace(connect=AsyncMock(return_value=browser)))
    with pytest.raises(security.BrowserSecurityError):asyncio.run(security.launch_browser(pw))
    browser.close.assert_awaited_once()
    cdp.detach.assert_awaited_once()


def test_verified_worker_connects_without_starting_root_local_browser(monkeypatch):
    monkeypatch.setenv('AGENTBOARD_BROWSER_WS_ENDPOINT','ws://127.0.0.1:3023/private')
    cdp=SimpleNamespace(send=AsyncMock(return_value={'arguments':['chrome','--enable-automation']}),detach=AsyncMock())
    browser=SimpleNamespace(new_browser_cdp_session=AsyncMock(return_value=cdp),close=AsyncMock())
    pw=SimpleNamespace(chromium=SimpleNamespace(connect=AsyncMock(return_value=browser)))
    assert asyncio.run(security.launch_browser(pw)) is browser
    browser.close.assert_not_awaited()
