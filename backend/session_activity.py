"""Shared latest request titles and workspace recency, independent of unread state."""
from __future__ import annotations

import copy
import json
import os
import re
import tempfile
import time
from pathlib import Path

from . import config
from .logger import log
from .session_state import identity


def label(text):
    text = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', str(text or ''))
    first = next((line.strip() for line in text.splitlines() if line.strip()), '')
    return re.sub(r'[\x00-\x1f\x7f]', '', first)[:120]


def workspace_key(session):
    return json.dumps([session.get('host') or 'local', session.get('cwd') or '~'],
                      ensure_ascii=False, separators=(',', ':'))


class SessionActivity:
    def __init__(self, path: Path):
        self.path = path
        self._state = None

    def _load(self):
        if self._state is None:
            try:
                value = json.loads(self.path.read_text())
            except FileNotFoundError:
                value = {'version': 1, 'revision': 0, 'records': {}, 'workspaces': {}}
            if value.get('version') != 1 or not isinstance(value.get('records'), dict) or not isinstance(value.get('workspaces'), dict):
                raise ValueError('Invalid session activity')
            self._state = value
        return self._state

    def _commit(self, value):
        if value == self._load():
            return
        value['revision'] = max(value['revision'] + 1, time.time_ns() // 1000)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(prefix='.session-activity-', dir=self.path.parent)
        try:
            with os.fdopen(fd, 'w') as file:
                json.dump(value, file, ensure_ascii=False)
                file.flush()
                os.fsync(file.fileno())
            os.replace(name, self.path)
        finally:
            if os.path.exists(name):
                os.unlink(name)
        self._state = value

    @staticmethod
    def _touch(value, session, at):
        if at:
            key = workspace_key(session)
            value['workspaces'][key] = max(value['workspaces'].get(key, 0), at)

    def sync(self, sessions):
        value = copy.deepcopy(self._load())
        for session in sessions:
            if not session.get('createdAt') or not session.get('online', True):
                continue
            owner = identity(session)
            record = value['records'].setdefault(owner, {})
            event = session.get('completionEvent') or ''
            if event and event != record.get('event'):
                # Use the durable completion time. Opening, acknowledging,
                # reconnecting and output streaming never advance recency.
                record['event'] = event
                self._touch(value, session, session.get('completionAt') or 0)
        self._commit(value)
        return self.decorate(sessions)

    def submitted(self, session, title, started_at):
        if not title or not session.get('createdAt'):
            return
        value = copy.deepcopy(self._load())
        record = value['records'].setdefault(identity(session), {})
        # Concurrent/remote delivery can finish out of order. An older request
        # must not replace a newer request title or move a workspace backwards.
        if started_at >= record.get('requestAt', 0):
            record.update(title=label(title), requestAt=started_at)
        self._touch(value, session, started_at)
        self._commit(value)

    def decorate(self, sessions):
        value = self._load()
        return {'revision': value['revision'], 'workspaceActivity': dict(value['workspaces']),
                'sessions': [{**session, 'requestTitle': value['records'].get(identity(session), {}).get('title', '')}
                             for session in sessions]}


state = SessionActivity(config.STATE_DIR / '.session-activity.json')


async def prepare_input(session_id, text):
    """Capture identity before delivery; failed sends never change a title."""
    title = label(text)
    if not title:
        return None
    from . import session_state
    session = next((s for s in session_state.sessions() if s['id'] == session_id), None)
    if session and not session.get('createdAt') and session.get('host', 'local') == 'local':
        # A just-created terminal may receive input before its first info poll.
        from .sessions import store
        from . import tmux, streamer
        current = store.get(session_id)
        if current:
            try:
                info = await tmux.display_info(current.session_name)
                if store.get(session_id) is current and info.get('created_at'):
                    streamer._update_info(session_id, current, info)
                    session = current.to_dict()
            except (OSError, ValueError):
                log.warning('New session identity could not be read for its request title')
    if session:
        return session, title, time.time()
    return None


def finish_input(context):
    if context is None:
        return
    try:
        state.submitted(*context)
        from .session_state import snapshot
        from .ws import broadcast
        result = snapshot()
        broadcast(result)
        return result
    except (OSError, ValueError):
        # Delivery already succeeded. Never encourage duplicate execution by
        # reporting a metadata persistence failure as an input failure.
        log.warning('Latest request title could not be saved')
