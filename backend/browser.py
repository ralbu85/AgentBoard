"""Authenticated remote Chromium workbench. No public CDP/debugging port."""
from __future__ import annotations

import asyncio
from contextlib import suppress
import base64
import hashlib
import json
import os
import re
import shutil
import time
from pathlib import Path
from urllib.parse import urlsplit

from playwright.async_api import async_playwright

from . import config

MAX_TABS = max(1, min(10, int(os.getenv('AGENTBOARD_BROWSER_TABS', '3'))))
DATA_DIR = config.STATE_DIR / '.browser-state'


def web_url(value: str) -> str:
    if not isinstance(value, str) or len(value) > 8192 or re.search(r'[\x00-\x20]', value):
        raise ValueError('HTTP 또는 HTTPS 주소를 입력해 주세요.')
    parsed = urlsplit(value)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError('HTTP 또는 HTTPS 주소만 열 수 있습니다.')
    return value


def validate_identity(tab_id: str, workspace: str):
    if not re.fullmatch(r'browser:[a-zA-Z0-9-]{1,100}', tab_id):
        raise ValueError('잘못된 웹 탭 ID입니다.')
    try:
        owner = json.loads(workspace)
        if not isinstance(owner, list) or len(owner) != 2 or not all(isinstance(v, str) and 0 < len(v) <= 4096 for v in owner):
            raise ValueError()
    except (ValueError, TypeError):
        raise ValueError('잘못된 워크스페이스입니다.')


def browser_memory_mb():
    # RSS sum includes shared pages, so this is an estimate, not unique RAM.
    try:
        rows={}
        for path in Path('/proc').glob('[0-9]*/status'):
            try:
                fields=dict(line.split(':',1) for line in path.read_text().splitlines() if ':' in line)
                rows[int(path.parent.name)]=(int(fields['PPid']),fields['Name'].strip(),int(fields.get('VmRSS','0 kB').split()[0]))
            except (OSError,ValueError,KeyError):continue
        descendants={os.getpid()}
        while True:
            next_ids={pid for pid,(parent,_,_) in rows.items() if parent in descendants}
            if next_ids<=descendants:break
            descendants|=next_ids
        return round(sum(rss for pid,(_,name,rss) in rows.items() if pid in descendants and ('chrome' in name or 'chromium' in name))/1024)
    except OSError:return None


class WebTab:
    def __init__(self, manager, tab_id, workspace, page, cdp):
        self.manager, self.id, self.workspace = manager, tab_id, workspace
        self.page, self.cdp = page, cdp
        self.clients = set()
        self.frame = b''
        self.frame_no = 0
        self.width, self.height = 1000, 700
        self.metadata = {'url': '', 'title': '', 'back': False, 'forward': False}
        self.error = ''
        self.chooser = None
        self.dialog = None
        self.downloads = []
        self.lock = asyncio.Lock()
        self.last_used = time.time()
        self.closed = False
        self.casting = False
        self.tasks = set()
        self.navigation_task = None
        cdp.on('Page.screencastFrame', self.on_frame)
        page.on('filechooser', lambda chooser: setattr(self, 'chooser', chooser))
        page.on('dialog', lambda dialog: setattr(self, 'dialog', dialog))
        page.on('download', lambda download: self.task(self.save_download(download)))
        page.on('popup', lambda popup: self.task(self.adopt_popup(popup)))
        page.on('crash', lambda: setattr(self, 'error', '브라우저 탭이 중단됐습니다. 종료 후 다시 열어 주세요.'))

    def task(self, coro):
        task = asyncio.create_task(coro)
        self.tasks.add(task)
        def done(task):
            self.tasks.discard(task)
            if not task.cancelled() and task.exception():
                self.error = '페이지 작업을 완료하지 못했습니다.'
        task.add_done_callback(done)

    async def on_frame(self, event):
        try:
            self.frame = base64.b64decode(event['data'])
            self.frame_no += 1
            await self.cdp.send('Page.screencastFrameAck', {'sessionId': event['sessionId']})
        except Exception:
            pass  # tab/connection closed

    async def casting_enabled(self, enabled):
        async with self.lock:
            if self.closed or self.casting == enabled:
                return
            if enabled:
                await self.cdp.send('Page.startScreencast', {'format': 'jpeg', 'quality': 70, 'maxWidth':1600, 'maxHeight':1200, 'everyNthFrame':1})
                self.frame = await self.page.screenshot(type='jpeg', quality=70, timeout=5000)
                self.frame_no += 1
            else:
                await self.cdp.send('Page.stopScreencast')
            self.casting = enabled

    async def status(self):
        if not self.closed:
            # During navigation the old document's execution context disappears.
            # Keep streaming; a title-read race is not a connection failure.
            self.metadata['url']=self.page.url
            with suppress(Exception):
                history=await self.cdp.send('Page.getNavigationHistory')
                index,entries=history['currentIndex'],history['entries']
                self.metadata.update(back=index>0,forward=index<len(entries)-1)
            if not self.dialog:
                with suppress(Exception):
                    self.metadata['title']=await asyncio.wait_for(self.page.title(),2)
        return {'type':'state', **self.metadata, 'width':self.width, 'height':self.height,
                'error':self.error, 'fileChooser':self.chooser is not None,
                'dialog':{'type':self.dialog.type, 'message':self.dialog.message} if self.dialog else None,
                'downloads':self.downloads[-10:], 'closed':self.closed}

    async def navigate(self, url):
        url = web_url(url)
        self.error = ''
        try:
            await self.page.goto(url, wait_until='domcontentloaded', timeout=20000)
        except Exception as exc:
            # A download intentionally interrupts navigation.
            if 'ERR_ABORTED' not in str(exc):
                self.error = '페이지를 열지 못했거나 응답이 지연되고 있습니다. 주소를 확인하거나 새로고침해 주세요.'
        await self.manager.save_profile(self.workspace)

    async def adopt_popup(self, popup):
        url=popup.url
        await popup.close()
        if url.startswith(('http://','https://')):
            await self.command({'action':'navigate','url':url})

    async def save_download(self, download):
        # Downloads stay in the app state directory until explicitly saved to a
        # workspace. A web page cannot choose or overwrite a server file path.
        directory = DATA_DIR / 'downloads' / hashlib.sha256(self.id.encode()).hexdigest()
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        name = Path(download.suggested_filename.replace('\\','/')).name or 'download'
        token = os.urandom(12).hex()
        path = directory / token
        await download.save_as(path)
        self.downloads.append({'id':token, 'name':name, 'size':path.stat().st_size, 'path':str(path)})

    async def command(self, data):
        if not isinstance(data,dict):raise ValueError('잘못된 명령입니다.')
        if self.closed:raise ValueError('종료된 탭입니다.')
        action = data.get('action')
        self.last_used = time.time()
        if action in ('navigate','back','forward','reload'):
            if action=='navigate':web_url(data.get('url',''))
            async def navigation():
                try:
                    self.error=''
                    if action=='navigate':await self.navigate(data['url'])
                    else:
                        method={'back':self.page.go_back,'forward':self.page.go_forward,'reload':self.page.reload}[action]
                        await method(wait_until='domcontentloaded',timeout=20000)
                except Exception:
                    self.error='페이지 이동을 완료하지 못했습니다. 다시 시도해 주세요.'
            if self.navigation_task:self.navigation_task.cancel()
            self.navigation_task=asyncio.create_task(navigation())
            return None
        if action == 'dialog':
            dialog,self.dialog=self.dialog,None
            if dialog:
                if data.get('accept'): await dialog.accept(str(data.get('text',''))[:10000])
                else: await dialog.dismiss()
            return None
        async with self.lock:
            if self.closed:
                raise ValueError('종료된 탭입니다.')
            if action == 'resize':
                width = max(320,min(1600,int(data.get('width',1000))))
                height = max(200,min(1200,int(data.get('height',700))))
                if (width,height) != (self.width,self.height):
                    await self.page.set_viewport_size({'width':width,'height':height})
                    self.width,self.height=width,height
                    if not self.dialog:
                        self.frame=await self.page.screenshot(type='jpeg',quality=70,timeout=5000)
                        self.frame_no+=1
            elif action == 'click':
                x,y=self.coords(data)
                await self.page.mouse.click(x,y,click_count=2 if data.get('double') else 1)
            elif action == 'pointer':
                x,y=self.coords(data)
                await self.page.mouse.move(x,y)
                if data.get('kind')=='down': await self.page.mouse.down()
                elif data.get('kind')=='up': await self.page.mouse.up()
            elif action == 'wheel':
                x,y=self.coords(data)
                await self.page.mouse.move(x,y)
                await self.page.mouse.wheel(max(-2000,min(2000,float(data.get('dx',0)))),max(-2000,min(2000,float(data.get('dy',0)))))
            elif action == 'text':
                text=data.get('text','')
                if not isinstance(text,str) or len(text)>100000: raise ValueError('입력 내용이 너무 깁니다.')
                await self.page.keyboard.insert_text(text)
            elif action == 'key':
                key=data.get('key','')
                if not isinstance(key,str) or len(key)>80 or not re.fullmatch(r'(Control\+|Meta\+|Alt\+|Shift\+)*(Enter|Tab|Backspace|Delete|Escape|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|[a-zA-Z0-9])',key):
                    raise ValueError('지원하지 않는 키입니다.')
                await self.page.keyboard.press(key)
            elif action == 'dialog':
                dialog,self.dialog=self.dialog,None
                if dialog:
                    if data.get('accept'): await dialog.accept(str(data.get('text',''))[:10000])
                    else: await dialog.dismiss()
            elif action == 'copy':
                # Only explicit copy requests read page selection; no clipboard polling.
                return {'type':'clipboard','text':await self.page.evaluate('window.getSelection()?.toString() || ""')}
            else:
                raise ValueError('지원하지 않는 브라우저 명령입니다.')
        return None

    def coords(self, data):
        return (max(0,min(self.width-1,float(data.get('x',0)))),max(0,min(self.height-1,float(data.get('y',0)))))


class BrowserManager:
    def __init__(self):
        self.playwright = None
        self.browser = None
        self.contexts = {}
        self.tabs: dict[str,WebTab] = {}
        self.lock = asyncio.Lock()
        self.profile_lock = asyncio.Lock()

    def profile_path(self, workspace):
        return DATA_DIR / 'profiles' / (hashlib.sha256(workspace.encode()).hexdigest()+'.json')

    async def save_profile(self, workspace):
        async with self.profile_lock:
            context = self.contexts.get(workspace)
            if not context: return
            path = self.profile_path(workspace)
            path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
            try:
                state = await context.storage_state(indexed_db=True)
                temp=path.with_suffix('.tmp')
                temp.write_text(json.dumps(state))
                temp.chmod(0o600)
                temp.replace(path)
            except Exception:
                pass

    async def open(self, tab_id, workspace, url):
        validate_identity(tab_id,workspace)
        url=web_url(url)
        async with self.lock:
            if tab_id in self.tabs:
                tab=self.tabs[tab_id]
                if tab.workspace!=workspace: raise ValueError('워크스페이스가 일치하지 않습니다.')
                return tab
            if len(self.tabs)>=MAX_TABS:
                raise ValueError(f'Chromium 탭은 최대 {MAX_TABS}개까지 실행할 수 있습니다. 실행 목록에서 사용하지 않는 탭을 종료해 주세요.')
            if not self.browser or not self.browser.is_connected():
                if self.playwright: await self.playwright.stop()
                self.playwright=await async_playwright().start()
                self.browser=await self.playwright.chromium.launch(channel='chromium',headless=True)
            if workspace not in self.contexts:
                path=self.profile_path(workspace)
                self.contexts[workspace]=await self.browser.new_context(viewport={'width':1000,'height':700},accept_downloads=True,storage_state=str(path) if path.exists() else None)
                # No local-file/data navigations, including links and redirects.
                async def guard(route):
                    try: web_url(route.request.url)
                    except ValueError: await route.abort();return
                    await route.continue_()
                await self.contexts[workspace].route('**/*',guard)
            context=self.contexts[workspace]
            page=await context.new_page()
            cdp=await context.new_cdp_session(page)
            tab=WebTab(self,tab_id,workspace,page,cdp)
            self.tabs[tab_id]=tab
        await tab.command({'action':'navigate','url':url})
        return tab

    async def close(self, tab_id):
        async with self.lock:
            tab=self.tabs.pop(tab_id,None)
            if not tab:return
            tab.closed=True
            if tab.dialog:
                with suppress(Exception):await tab.dialog.dismiss()
                tab.dialog=None
            tasks=list(tab.tasks) + ([tab.navigation_task] if tab.navigation_task else [])
            for task in tasks:task.cancel()
            await asyncio.gather(*tasks,return_exceptions=True)
            with suppress(Exception):await asyncio.wait_for(self.save_profile(tab.workspace),5)
            with suppress(Exception):await tab.page.close()
            directory=DATA_DIR / 'downloads' / hashlib.sha256(tab.id.encode()).hexdigest()
            await asyncio.to_thread(shutil.rmtree,directory,True)
            if not any(t.workspace==tab.workspace for t in self.tabs.values()):
                context=self.contexts.pop(tab.workspace,None)
                if context:
                    with suppress(Exception):await context.close()
            if not self.tabs and self.browser:
                with suppress(Exception):await self.browser.close()
                self.browser=None
                self.contexts.clear()
                if self.playwright:await self.playwright.stop();self.playwright=None

    async def release_empty(self):
        async with self.lock:
            if self.tabs:return
            if self.browser:
                with suppress(Exception):await self.browser.close()
                self.browser=None
            self.contexts.clear()
            if self.playwright:
                await self.playwright.stop();self.playwright=None

    async def shutdown(self):
        for tab_id in list(self.tabs):await self.close(tab_id)
        await self.release_empty()


manager=BrowserManager()
