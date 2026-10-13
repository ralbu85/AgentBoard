"""Five durable work entries, independent of unread receipts and open tabs."""
from __future__ import annotations

import copy
import json
import os
import re
import tempfile
import time
import uuid
from pathlib import Path

from . import config
from .logger import log
from .session_state import identity

LIMIT = 5


def label(text):
    text = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', str(text or ''))
    first = next((line.strip() for line in text.splitlines() if line.strip()), '')
    return re.sub(r'[\x00-\x1f\x7f]', '', first)[:120]


class RecentWork:
    def __init__(self, path: Path):
        self.path = path
        self._state = None

    def _load(self):
        if self._state is None:
            try:
                value = json.loads(self.path.read_text())
            except FileNotFoundError:
                value = {'version': 1, 'revision': 0, 'items': [], 'observed': {}}
            if value.get('version') != 1 or not isinstance(value.get('items'), list) or not isinstance(value.get('observed'), dict):
                raise ValueError('Invalid recent work history')
            self._state = value
        return self._state

    def _commit(self, value):
        value['items'] = sorted(value['items'], key=lambda item: item['at'], reverse=True)[:LIMIT]
        if value == self._load():
            return
        value['revision'] = max(value['revision'] + 1, time.time_ns() // 1000)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(prefix='.recent-work-', dir=self.path.parent)
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
    def _entry(session, title, at, status, event=''):
        return {'id': uuid.uuid4().hex, 'owner': identity(session), 'sessionId': session['id'],
                'sessionName': session.get('sessionName') or session['id'],
                'createdAt': session.get('createdAt', 0), 'host': session.get('host') or 'local',
                'cwd': session.get('cwd') or '~', 'title': title or '터미널 작업',
                'command': session.get('cmd') or session.get('process') or 'terminal',
                'at': at, 'startedAt': at, 'status': status, 'event': event,
                'unread': False, 'fromInput': False}

    @staticmethod
    def _current(items, owner):
        return next((item for item in sorted(items, key=lambda item: item['startedAt'], reverse=True)
                     if item['owner'] == owner and not item['event'] and item['status'] != 'previous'), None)

    def sync(self, sessions, titles):
        value = copy.deepcopy(self._load())
        owners = {identity(session) for session in sessions}
        for item in value['items']:
            if item['owner'] not in owners:
                item['unread'] = False
        for session in sessions:
            if not session.get('createdAt') or not session.get('online', True):
                continue
            owner = identity(session)
            event = session.get('completionEvent') or ''
            previous = value['observed'].get(owner)
            working = session.get('aiState') == 'working'
            manual = label(titles.get(session['id']))
            if re.fullmatch(r'(?:(?:claude|codex|terminal|bash|zsh)[\s·#]*\d+|#\d+\s*(?:claude|codex|terminal|bash|zsh))', manual, re.I):
                manual = ''
            title = manual or label(session.get('autoTitle'))
            status = session.get('aiState') or 'idle'
            if session.get('status') in ('stopped', 'completed'):
                status = 'stopped'
            items = value['items']
            if previous is None:
                # Seed with actual known activity times, never make old idle
                # sessions appear to have just completed when the hub restarts.
                at = max(session.get('lastActivityAt') or 0, session.get('completionAt') or 0)
                if at or working:
                    item = self._entry(session, title, at or session['createdAt'],
                                       status if working or status == 'stopped' else 'completed' if event else status,
                                       '' if working else event)
                    if not any(row['owner'] == owner for row in items):
                        items.append(item)
            elif event and event != previous['event']:
                item = self._current(items, owner)
                if item is None:
                    item = self._entry(session, title, session.get('completionAt') or time.time(), 'completed')
                    items.append(item)
                item.update(event=event, status='completed', at=session.get('completionAt') or time.time())
                if not item.get('fromInput') and not item.get('renamed') and title:
                    item['title'] = title
            elif working and not previous['working']:
                item = self._current(items, owner)
                if item is None:
                    items.append(self._entry(session, title, time.time(), 'working'))

            current = self._current(items, owner)
            if current and status in ('working', 'waiting', 'stopped'):
                current['status'] = status
            elif current and status == 'idle' and current['status'] in ('working', 'waiting'):
                current['status'] = 'idle'
            for item in items:
                if item['owner'] == owner:
                    item['sessionId'] = session['id']
                    item['unread'] = bool(item['event'] and item['event'] == event and session.get('completionUnread'))
                    if item['title'] == '터미널 작업' and not item['fromInput'] and not item.get('renamed') and title:
                        item['title'] = title
            value['observed'][owner] = {'event': event, 'working': working}
        # Only metadata for current/recent incarnations is needed for replay
        # deduplication. Preserve insertion order without growing indefinitely.
        value['observed'] = dict(list(value['observed'].items())[-2000:])
        self._commit(value)
        return self.snapshot()

    def submitted(self, session, title, started_at, baseline):
        if not title or not session.get('createdAt'):
            return
        value = copy.deepcopy(self._load())
        owner = identity(session)
        # A very fast result may have arrived during the send's await. Attach
        # the request title to that entry instead of creating a duplicate.
        item = next((row for row in value['items'] if row['owner'] == owner and not row['fromInput']
                     and row['at'] >= started_at and (not row['event'] or row['event'] != baseline)), None)
        if item is None:
            newer = any(row['owner'] == owner and row['startedAt'] > started_at for row in value['items'])
            for row in value['items']:
                if row['owner'] == owner and not row['event'] and row['startedAt'] <= started_at:
                    row['status'] = 'previous'
            item = self._entry(session, title, started_at, 'previous' if newer else 'submitted')
            value['items'].append(item)
        item.update(title=title, fromInput=True, startedAt=started_at)
        value['observed'].setdefault(owner, {'event': baseline, 'working': False})
        self._commit(value)

    def rename(self, entry_id, title):
        title = label(title)
        if not title:
            raise ValueError('작업명을 입력해 주세요.')
        value = copy.deepcopy(self._load())
        item = next((row for row in value['items'] if row['id'] == entry_id), None)
        if item is None:
            raise KeyError(entry_id)
        item.update(title=title, renamed=True)
        self._commit(value)

    def snapshot(self):
        value = self._load()
        return {'revision': value['revision'], 'items': [
            {key: field for key, field in item.items() if key not in ('owner', 'fromInput', 'renamed', 'startedAt')}
            for item in value['items']]}


state = RecentWork(config.STATE_DIR / '.recent-work.json')


def prepare_input(session_id, text):
    """Capture identity before delivery; failed sends never enter the history."""
    title = label(text)
    if not title:
        return None
    try:
        from . import session_state
        snapshot = session_state.state.snapshot(session_state.sessions())
        session = next((s for s in snapshot['sessions'] if s['id'] == session_id), None)
        if session:
            return session, title, time.time(), session.get('completionEvent', '')
    except (OSError, ValueError):
        log.warning('Recent work input context could not be read')
    return None


def finish_input(context):
    if context is None:
        return
    try:
        state.submitted(*context)
        from .session_state import snapshot
        from .ws import broadcast
        broadcast(snapshot())
    except (OSError, ValueError):
        # Delivery has already succeeded. Never report it as failed and invite
        # the user to execute the same command again for a history write error.
        log.warning('Recent work input could not be saved')
