import asyncio
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

import pytest

from backend import browser


@pytest.mark.parametrize('url',['file:///etc/passwd','javascript:alert(1)','data:text/html,test','https://user:pw@example.com','https://example.com/\n'])
def test_browser_rejects_non_web_urls(url):
    with pytest.raises(ValueError):browser.web_url(url)


def test_browser_identity_cannot_select_profile_paths():
    browser.validate_identity('browser:abc-123','["local","/workspace/project"]')
    for tab, owner in [('browser:../../secret','["local","/project"]'),('browser:test','{}'),('browser:test','[1,2]')]:
        with pytest.raises(ValueError):browser.validate_identity(tab,owner)


@pytest.mark.skipif(os.getenv('AGENTBOARD_BROWSER_TESTS')!='1',reason='Requires installed Chromium; opt in to real browser integration')
def test_real_chromium_lifecycle(tmp_path,monkeypatch):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            if self.path=='/download':
                self.send_header('Content-Disposition','attachment; filename="sample.txt"')
                self.end_headers();self.wfile.write(b'research data');return
            self.send_header('Content-Type','text/html; charset=utf-8')
            self.send_header('X-Frame-Options','DENY')
            self.end_headers()
            self.wfile.write(('<title>Fixture</title><h1>'+self.path+'</h1><input id="text"><a id="next" href="/next">next</a><input id="file" type="file"><a id="download" href="/download">download</a><button id="dialog" onclick="alert(\'hello\')">dialog</button>').encode())
        def log_message(self,*args):pass
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
    thread=Thread(target=server.serve_forever,daemon=True);thread.start()
    monkeypatch.setattr(browser,'DATA_DIR',tmp_path)
    monkeypatch.setattr(browser,'MAX_TABS',2)
    async def run():
        manager=browser.BrowserManager()
        owner=json.dumps(['local','/research'])
        url=f'http://127.0.0.1:{server.server_port}/start'
        try:
            tab=await manager.open('browser:first',owner,url)
            await tab.navigation_task
            assert await tab.page.title()=='Fixture'
            await tab.casting_enabled(True)
            assert tab.frame.startswith(b'\xff\xd8')
            await tab.page.locator('#text').focus()
            await tab.command({'action':'text','text':'한글 --test'})
            assert await tab.page.locator('#text').input_value()=='한글 --test'
            await tab.casting_enabled(False)
            again=await manager.open('browser:first',owner,url)
            assert again is tab
            assert await again.page.locator('#text').input_value()=='한글 --test'
            await tab.page.locator('#next').click()
            assert (await tab.status())['back']
            await tab.command({'action':'back'});await tab.navigation_task
            assert tab.page.url.endswith('/start')
            await tab.page.evaluate("localStorage.setItem('login-fixture','retained')")
            await tab.manager.save_profile(owner)
            other=await manager.open('browser:second',json.dumps(['local','/other']),url)
            await other.navigation_task
            assert await other.page.evaluate("localStorage.getItem('login-fixture')") is None
            with pytest.raises(ValueError,match='최대'):
                await manager.open('browser:third',owner,url)
            async with tab.page.expect_file_chooser():
                await tab.page.locator('#file').click()
            assert tab.chooser
            await tab.chooser.set_files({'name':'upload.txt','mimeType':'text/plain','buffer':b'hello'})
            assert await tab.page.locator('#file').evaluate('(el)=>el.files[0].name')=='upload.txt'
            await tab.page.locator('#download').click()
            for _ in range(100):
                if tab.downloads:break
                await asyncio.sleep(.05)
            assert tab.downloads and tab.downloads[0]['name']=='sample.txt'
            click=asyncio.create_task(tab.page.locator('#dialog').click())
            for _ in range(100):
                if tab.dialog:break
                await asyncio.sleep(.02)
            assert tab.dialog
            assert (await tab.status())['dialog']['message']=='hello'
            await tab.command({'action':'dialog','accept':True})
            await click
            await manager.close('browser:first')
            recreated=await manager.open('browser:first',owner,url)
            await recreated.navigation_task
            assert await recreated.page.evaluate("localStorage.getItem('login-fixture')")=='retained'
        finally:await manager.shutdown()
        assert not manager.tabs and manager.browser is None and manager.playwright is None
    try:asyncio.run(run())
    finally:server.shutdown();server.server_close()


def test_control_socket_rejects_missing_auth_and_foreign_origin(monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from backend import routes_browser, config
    monkeypatch.setattr(config,'AUTH_TOKEN','fixture-token')
    async def run():
        ws=SimpleNamespace(headers={'host':'app.test'},cookies={},accept=AsyncMock(),close=AsyncMock())
        await routes_browser.browser_ws(ws)
        ws.close.assert_awaited_once_with(code=4401)
        ws=SimpleNamespace(headers={'host':'app.test','origin':'https://other.test'},cookies={'token':'fixture-token'},accept=AsyncMock(),close=AsyncMock())
        await routes_browser.browser_ws(ws)
        ws.accept.assert_awaited_once()
        ws.close.assert_awaited_once_with(code=4403)
    asyncio.run(run())


def test_download_save_stays_inside_workspace_and_does_not_overwrite(tmp_path,monkeypatch):
    from types import SimpleNamespace
    from fastapi import HTTPException
    from backend import routes_browser, config
    root=tmp_path/'workspace';root.mkdir()
    source=tmp_path/'download';source.write_bytes(b'fixture')
    tab=SimpleNamespace(workspace=json.dumps(['local',str(root)]),downloads=[{'id':'d1','name':'file.txt','path':str(source)}])
    monkeypatch.setattr(routes_browser,'get_tab',lambda _:tab)
    monkeypatch.setattr(config,'ALLOWED_ROOTS',[root])
    async def run():
        first=await routes_browser.save_download('browser:test','d1')
        second=await routes_browser.save_download('browser:test','d1')
        assert first['path']!=second['path']
        for result in (first,second):
            path=__import__('pathlib').Path(result['path'])
            assert path.is_relative_to(root) and path.read_bytes()==b'fixture'
        tab.workspace=json.dumps(['local',str(tmp_path/'forbidden')])
        with pytest.raises(HTTPException) as exc:await routes_browser.save_download('browser:test','d1')
        assert exc.value.status_code==403
    asyncio.run(run())
