"""Passive, bounded task-label reader. No model calls or terminal input.

Only an exact process-to-transcript binding is eligible (open descriptor, or
Claude's PID registry with matching kernel start time). Ambiguous/unavailable
ownership uses the native title. Reads are incremental, outside the event loop.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime
import json
import os
from pathlib import Path
import re
import time

from . import conversations
from .session_activity import request_hash

MAX_READ = 256 * 1024
PROC = Path('/proc')


def task_label(text):
    first = next((line.strip() for line in text.splitlines() if line.strip()), '')
    first = first.removeprefix('**').removesuffix('**')
    match = re.fullmatch(r'작업:\s*(.{2,60})', first)
    if not match or any(ord(c) < 32 or ord(c) == 127 for c in first):
        return ''
    return match[1].strip()


def timestamp(value):
    try:
        date = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        return date.timestamp() if date.tzinfo else 0
    except (ValueError, TypeError, OverflowError):
        return 0


def message(item, provider):
    if not isinstance(item, dict):
        return None
    if provider == 'codex':
        body = item.get('payload', {})
        if (item.get('type') != 'response_item' or not isinstance(body, dict)
                or body.get('type') != 'message' or body.get('channel') in ('analysis', 'summary')):
            return None
    else:
        if item.get('type') not in ('user', 'assistant') or item.get('isSidechain'):
            return None
        body = item.get('message', {})
    if not isinstance(body, dict) or body.get('role') not in ('user', 'assistant'):
        return None
    content = body.get('content', [])
    if isinstance(content, list):
        # Tool results, thinking and structured blocks must never name a task.
        content = '\n'.join(p['text'] for p in content if isinstance(p, dict)
                            and p.get('type') in ('text', 'input_text', 'output_text')
                            and isinstance(p.get('text'), str))
    if not isinstance(content, str) or not content.strip():
        return None
    return body['role'], content, timestamp(item.get('timestamp'))


def nearest_agents(root_pid):
    """Walk this pane's descendants only; never traverse unrelated sessions."""
    level, seen = [root_pid], set()
    while level and len(seen) < 256:
        children, agents = [], []
        for pid in level:
            if pid in seen:
                continue
            seen.add(pid)
            process = PROC / str(pid)
            try:
                executable = os.path.basename((process/'cmdline').read_bytes().split(b'\0')[0].decode(errors='replace')).lower()
                provider = 'codex' if 'codex' in executable else 'claude' if 'claude' in executable else ''
                if provider:
                    generation = (process/'stat').read_text().rsplit(')', 1)[1].split()[19]
                    agents.append((process, provider, f'{pid}:{generation}'))
                else:
                    for task in (process/'task').iterdir():
                        children.extend(int(n) for n in (task/'children').read_text().split())
            except (OSError, ValueError, IndexError):
                continue
        if agents:
            return agents
        level = children
    return []


def exact_source(pid, cwd):
    agents = nearest_agents(pid)
    # A parent shell concurrently running multiple agents has no unique owner.
    if len(agents) != 1:
        return None
    process, provider, generation = agents[0]
    root = conversations.ROOTS[provider].resolve()
    paths = set()
    expected_id = None
    try:
        for fd in (process/'fd').iterdir():
            try:
                path = fd.readlink()
                if (path.suffix == '.jsonl' and path.is_absolute() and 'subagents' not in path.parts
                        and not path.is_symlink() and path.resolve().is_relative_to(root)):
                    paths.add(path.resolve())
            except OSError:
                continue
    except OSError:
        return None
    # Claude closes its log between writes. Its per-PID registry is exact
    # evidence only when procStart matches the currently running process.
    # A stale PID file from an earlier incarnation is never accepted.
    if not paths and provider == 'claude':
        registry = root.parent/'sessions'/f'{process.name}.json'
        try:
            if registry.is_symlink() or registry.stat().st_size > 16384:
                return None
            record = json.loads(registry.read_text())
            conversation = record.get('sessionId', '')
            if (str(record.get('pid')) != process.name
                    or str(record.get('procStart')) != generation.split(':', 1)[1]
                    or not isinstance(conversation, str) or not conversations.UUID.fullmatch(conversation)
                    or os.path.realpath(record.get('cwd', '')) != os.path.realpath(cwd)):
                return None
            for path in root.glob(f'*/{conversation}.jsonl'):
                if not path.is_symlink() and path.resolve().is_relative_to(root):
                    paths.add(path.resolve())
            expected_id = conversation
        except (OSError, ValueError, TypeError, AttributeError):
            return None
    # Multiple log descriptors are ambiguous even if only one has matching cwd.
    if len(paths) != 1:
        return None
    path = paths.pop()
    meta = conversations.metadata(path, provider)
    if (not meta or meta['cwd'] != os.path.realpath(cwd)
            or expected_id is not None and meta['id'] != expected_id):
        return None
    return path, provider, generation


@dataclass
class Cursor:
    inode: tuple
    offset: int
    user_at: float = 0
    fingerprint: str = ''
    skipping: bool = False


class Reader:
    def __init__(self):
        self.started_at = time.time()
        self.cursors = {}

    def read(self, key, path, provider):
        with path.open('rb') as stream:
            stat = os.fstat(stream.fileno())
            inode = (stat.st_dev, stat.st_ino)
            cursor = self.cursors.get(key)
            if not cursor or cursor.inode != inode or cursor.offset > stat.st_size:
                start = max(0, stat.st_size - MAX_READ)
                cursor = Cursor(inode, start, skipping=bool(start))
                self.cursors[key] = cursor
            stream.seek(cursor.offset)
            data = stream.read(MAX_READ)
        result = None
        for line in data.splitlines(keepends=True):
            if not line.endswith(b'\n'):
                if cursor.skipping or len(line) == MAX_READ:
                    cursor.offset += len(line)
                    cursor.skipping = True
                break  # retry incomplete JSONL append without losing bytes
            cursor.offset += len(line)
            if cursor.skipping:
                cursor.skipping = False
                continue
            try:
                row = message(json.loads(line), provider)
            except (ValueError, UnicodeDecodeError):
                continue
            if not row:
                continue
            role, text, at = row
            if role == 'user':
                cursor.user_at, cursor.fingerprint = at, request_hash(text)
                # A later user message in the same batch invalidates an earlier
                # candidate; wait for that user's own assistant response.
                result = None
            elif (at >= self.started_at and cursor.user_at >= self.started_at
                  and at >= cursor.user_at and cursor.fingerprint):
                title = task_label(text)
                if title:
                    result = {'title': title, 'at': at, 'userAt': cursor.user_at,
                              'requestHash': cursor.fingerprint}
        return result

    def collect(self, sessions):
        updates, active = [], set()
        for sid, pid, cwd, created_at in sessions:
            try:
                source = exact_source(pid, cwd)
                if not source:
                    continue
                path, provider, generation = source
                key = (sid, created_at, generation, str(path))
                active.add(key)
                summary = self.read(key, path, provider)
                if summary and exact_source(pid, cwd) == source:
                    updates.append((sid, pid, created_at, summary))
            except (OSError, ValueError):
                continue  # process/file races are normal; native title remains
        self.cursors = {key: value for key, value in self.cursors.items() if key in active}
        return updates


async def poll():
    from .sessions import store
    from .streamer import broadcast
    from .logger import log
    reader = Reader()
    while True:
        sources = [(s.id, s.pane_pid, s.cwd, s.created_at) for s in store.all()
                   if s.status == 'running' and s.pane_pid and s.created_at]
        try:
            updates = await asyncio.to_thread(reader.collect, sources)
            for sid, pid, created_at, summary in updates:
                current = store.get(sid)
                if current and (current.pane_pid, current.created_at) == (pid, created_at):
                    current.task_summary = summary
                    broadcast({'type': 'task-summary', 'id': sid, 'taskSummary': summary})
        except Exception:
            log.warning('Task title observation failed; retaining native titles', exc_info=True)
        await asyncio.sleep(3)
