"""Bounded private audit records. Never log bodies, queries, cookies or secrets."""
from __future__ import annotations

import hashlib
import json
import os
import stat
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit

from . import config

FIELDS = {'route', 'method', 'status', 'peer', 'action', 'host', 'scheme', 'port', 'result'}
MAX_BYTES = 5 * 1024 * 1024


class Audit:
    def __init__(self, directory: Path):
        self.directory = directory
        self.lock = threading.Lock()
        self.failed = False
        self.last_warning = 0.0

    def _prepare(self):
        directory = self.directory
        if directory.is_symlink():
            raise OSError('Audit directory is a symlink')
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = directory.stat()
        if info.st_uid != os.geteuid() or not stat.S_ISDIR(info.st_mode):
            raise OSError('Audit directory owner/type mismatch')
        directory.chmod(0o700)

    def write(self, event: str, **fields):
        try:
            with self.lock:
                self._prepare()
                path = self.directory / 'events.jsonl'
                if path.is_symlink():
                    raise OSError('Audit file is a symlink')
                if path.exists() and path.stat().st_size >= MAX_BYTES:
                    for index in range(4, 0, -1):
                        source = self.directory / (f'events.{index-1}.jsonl' if index > 1 else 'events.jsonl')
                        target = self.directory / f'events.{index}.jsonl'
                        if source.is_symlink() or target.is_symlink():
                            raise OSError('Audit rotation symlink')
                        if source.exists():
                            source.replace(target)
                data = {'time': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'event': event}
                data.update({key: str(value)[:200] for key, value in fields.items() if key in FIELDS})
                encoded = (json.dumps(data, ensure_ascii=True, separators=(',', ':')) + '\n').encode()
                fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
                try:
                    info = os.fstat(fd)
                    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1:
                        raise OSError('Audit file owner/type/link mismatch')
                    os.fchmod(fd, 0o600)
                    os.write(fd, encoded)
                finally:
                    os.close(fd)
                self.failed = False
        except OSError:
            self.failed = True
            # No filesystem values or exception strings in public logs.
            if time.monotonic() - self.last_warning > 60:
                from .logger import log
                log.error('Security audit storage unavailable; check protected storage')
                self.last_warning = time.monotonic()


audit = Audit(Path(os.getenv('AGENTBOARD_AUDIT_DIR', str(config.STATE_DIR / '.security-audit'))))


def peer(address: str):
    # A keyed stable label supports correlation without publishing IP addresses.
    import hmac
    return hmac.new(config.AUTH_TOKEN.encode(), address.encode(), hashlib.sha256).hexdigest()[:20]


def destination(event: str, url: str, **fields):
    try:
        parsed = urlsplit(url)
        if parsed.scheme not in ('http', 'https', 'ws', 'wss') or not parsed.hostname:
            return
        audit.write(event, scheme=parsed.scheme, host=parsed.hostname, port=parsed.port or '', **fields)
    except ValueError:
        pass


class AuditMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        kind = scope['type']
        if kind not in ('http', 'websocket'):
            return await self.app(scope, receive, send)
        status = 500
        async def observe(message):
            nonlocal status
            if message['type'] == 'http.response.start':
                status = message['status']
                if scope.get('path', '').startswith('/api/conversations/'):
                    message = {**message, 'headers': [*(h for h in message.get('headers', []) if h[0].lower() != b'cache-control'),
                                                    (b'cache-control', b'no-store')]}
            elif message['type'] == 'websocket.accept':
                status = 101
                audit.write('ws.open', route=getattr(scope.get('route'), 'path', 'unmatched'),
                            peer=peer(str((scope.get('client') or ['unknown'])[0])))
            elif message['type'] == 'websocket.close':
                status = message.get('code', 1000)
            await send(message)
        try:
            await self.app(scope, receive, observe)
        finally:
            route = getattr(scope.get('route'), 'path', 'unmatched')
            # No raw URLs: route templates omit queries and path parameter data.
            if kind == 'websocket' or scope.get('path', '').startswith('/api/'):
                audit.write('ws.close' if kind == 'websocket' else 'http.request', route=route,
                            method=scope.get('method', 'WS'), status=status,
                            peer=peer(str((scope.get('client') or ['unknown'])[0])))
