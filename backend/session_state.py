"""Hub-owned status snapshots and durable, cross-device completion receipts."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import tempfile
import time

from . import config


def identity(session: dict) -> str:
    # cwd and the hub's numeric ID can change while the same tmux pane lives.
    value = [session.get('host') or 'local', session.get('sessionName') or session['id'], session.get('createdAt', 0)]
    return hashlib.sha256(json.dumps(value, ensure_ascii=False).encode()).hexdigest()


class SessionState:
    def __init__(self, path: Path):
        self.path = path
        self._records = None
        self._sessions = None
        self._revision = 0

    def _load(self):
        if self._records is None:
            try:
                state = json.loads(self.path.read_text())
            except FileNotFoundError:
                state = {'version': 1, 'records': {}}
            # Never silently overwrite an unreadable receipt file.
            if state.get('version') != 1 or not isinstance(state.get('records'), dict):
                raise ValueError('Invalid shared session state')
            self._records = state['records']
        return self._records

    def _save(self, records):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(prefix='.session-state-', dir=self.path.parent)
        try:
            with os.fdopen(fd, 'w') as out:
                json.dump({'version': 1, 'records': records}, out)
                out.flush()
                os.fsync(out.fileno())
            os.replace(name, self.path)
        finally:
            if os.path.exists(name):
                os.unlink(name)
        self._records = records

    def snapshot(self, sessions: list[dict]) -> dict:
        records = self._load()
        updated = dict(records)
        decorated = []
        for session in sessions:
            owner = identity(session)
            record = updated.get(owner, {})
            raw = 'exit' if session.get('status') == 'completed' else session.get('completionId')
            # Wait for a real process incarnation, especially during old agent
            # replay (spawned -> aiState -> info). Never create an ID=0 receipt.
            if raw and session.get('createdAt') and session.get('online', True):
                event = hashlib.sha256(f'{owner}:{raw}'.encode()).hexdigest()
                seen = record.get('seen', [])
                if event not in seen:
                    record = {'event': event, 'unread': True, 'seen': [*seen, event], 'updated': time.time()}
                    updated[owner] = record
            decorated.append({**session, 'completionEvent': record.get('event', ''),
                              'completionAt': record.get('updated', 0),
                              'completionUnread': record.get('unread', False)})
        if updated != records:
            self._save(updated)
        if decorated != self._sessions:
            # Microseconds are exact JS integers; ordering survives hub restarts
            # and prevents an older HTTP response replacing a newer WS frame.
            self._revision = max(self._revision + 1, time.time_ns() // 1000)
            self._sessions = decorated
        return {'type': 'session-state', 'revision': self._revision, 'sessions': decorated}

    def acknowledge(self, sessions: list[dict], session_id: str, event: str) -> dict:
        current = self.snapshot(sessions)
        session = next((s for s in current['sessions'] if s['id'] == session_id), None)
        # A delayed click may only acknowledge the exact result that was shown.
        if session and event and session['completionEvent'] == event and session['completionUnread']:
            records = dict(self._load())
            owner = identity(session)
            records[owner] = {**records[owner], 'unread': False}
            self._save(records)
        return self.snapshot(sessions)


state = SessionState(config.STATE_DIR / '.session-state.json')


def sessions():
    from .sessions import store
    from .agents import registry
    return [s.to_dict() for s in store.all()] + registry.mirror()


def snapshot():
    result = state.snapshot(sessions())
    from . import session_activity
    try:
        activity = session_activity.state.sync(result['sessions'])
        return {**result, **activity, 'revision': max(result['revision'], activity['revision'])}
    except (OSError, ValueError):
        return {**result, 'activityError': '작업 제목과 최근 작업순서를 동기화하지 못했습니다.'}
