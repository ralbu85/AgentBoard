"""Shared semantic task titles and workspace recency, independent of unread state."""
from __future__ import annotations

import copy
import hashlib
import json
import math
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


def request_hash(text):
    return hashlib.sha256(str(text).replace('\r\n', '\n').strip().encode()).hexdigest()


def summary_record(raw):
    """Remote agents may be older/buggy; malformed metadata cannot break status."""
    if not isinstance(raw, dict):
        return {}
    title = raw.get('title')
    if (not isinstance(title, str) or not 2 <= len(title) <= 60 or title != label(title)
            or not re.fullmatch(r'[0-9a-f]{64}', str(raw.get('requestHash', '')))):
        return {}
    for field in ('at', 'userAt'):
        value = raw.get(field)
        if not isinstance(value, (float, int)) or not math.isfinite(value) or value <= 0:
            return {}
    return raw if raw['userAt'] <= raw['at'] else {}


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
                value = {'version': 2, 'revision': 0, 'records': {}, 'workspaces': {}}
            if value.get('version') not in (1, 2) or not isinstance(value.get('records'), dict) or not isinstance(value.get('workspaces'), dict):
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
        # v1 titles were raw prompt excerpts, not summaries. Keep recency and
        # receipts but never resurrect those labels after migration/restart.
        value['version'] = 2
        for record in value['records'].values():
            record.pop('title', None)
        for session in sessions:
            if not session.get('createdAt') or not session.get('online', True):
                continue
            owner = identity(session)
            record = value['records'].setdefault(owner, {})
            native = label(session.get('autoTitle'))
            if native and native != record.get('nativeTitle'):
                record.update(nativeTitle=native, taskTitle=native, titleSource='native')
            summary = summary_record(session.get('taskSummary'))
            if (summary.get('at', 0) > record.get('summaryAt', 0)
                    and summary.get('at', 0) >= record.get('requestAt', 0)
                    and summary.get('title')
                    and (summary.get('requestHash') == record.get('requestHash')
                         or summary.get('userAt', 0) >= record.get('requestAt', 0))):
                record.update(taskTitle=label(summary['title']), titleSource='response', summaryAt=summary['at'])
            event = session.get('completionEvent') or ''
            if event and event != record.get('event'):
                # Use the durable completion time. Opening, acknowledging,
                # reconnecting and output streaming never advance recency.
                record['event'] = event
                self._touch(value, session, session.get('completionAt') or 0)
        self._commit(value)
        return self.decorate(sessions)

    def submitted(self, session, fingerprint, started_at):
        if not fingerprint or not session.get('createdAt'):
            return
        value = copy.deepcopy(self._load())
        record = value['records'].setdefault(identity(session), {})
        # Delivery updates recency, never the visible title. Short follow-ups
        # retain the task, and delayed responses cannot name a newer request.
        if started_at >= record.get('requestAt', 0):
            record.update(requestHash=fingerprint, requestAt=started_at)
        self._touch(value, session, started_at)
        self._commit(value)

    def decorate(self, sessions):
        value = self._load()
        return {'revision': value['revision'], 'workspaceActivity': dict(value['workspaces']),
                'sessions': [{**{k: v for k, v in session.items() if k != 'taskSummary'},
                              'taskTitle': value['records'].get(identity(session), {}).get('taskTitle', ''),
                              'titleSource': value['records'].get(identity(session), {}).get('titleSource', '')}
                             for session in sessions]}


state = SessionActivity(config.STATE_DIR / '.session-activity.json')


async def prepare_input(session_id, text):
    """Capture identity before delivery; failed sends never change a title."""
    if not str(text or '').strip():
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
                log.warning('New session identity could not be read for workspace recency')
    if session:
        return session, request_hash(text), time.time()
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
        log.warning('Workspace request activity could not be saved')
