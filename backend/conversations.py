"""Read exact agent transcripts. Never infer ownership from the newest file in cwd."""
from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import threading
from pathlib import Path

from . import config

UUID = re.compile(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}')
CHUNK = 4 * 1024 * 1024
ROOTS = {'codex': Path.home() / '.codex/sessions', 'claude': Path.home() / '.claude/projects'}


def metadata(path: Path, provider: str):
    """Read only the bounded header; a transcript must identify itself and cwd."""
    try:
        with path.open('rb') as stream:
            for _ in range(40):
                line = stream.readline(256 * 1024)
                if not line or not line.endswith(b'\n'):
                    break
                item = json.loads(line)
                if not isinstance(item, dict):
                    continue
                body = item.get('payload', {}) if provider == 'codex' else item
                if not isinstance(body, dict):
                    continue
                if provider == 'codex' and item.get('type') != 'session_meta':
                    continue
                identity = body.get('session_id') or body.get('id') if provider == 'codex' else body.get('sessionId')
                cwd = body.get('cwd')
                if isinstance(identity, str) and UUID.fullmatch(identity) and isinstance(cwd, str):
                    return {'id': identity, 'provider': provider, 'cwd': os.path.realpath(cwd),
                            'timestamp': str(body.get('timestamp', item.get('timestamp', '')))[:40]}
    except (OSError, ValueError, TypeError):
        pass
    return None


def inventory(cwd: str):
    result = {}
    expected = os.path.realpath(cwd)
    for provider, root in ROOTS.items():
        for path in root.glob('**/*.jsonl'):
            if 'subagents' in path.parts or path.is_symlink():
                continue
            resolved = path.resolve()
            if not resolved.is_relative_to(root.resolve()):
                continue
            meta = metadata(resolved, provider)
            if meta and meta['cwd'] == expected:
                # No filesystem path or prompt preview is exposed in the picker.
                key = provider + ':' + meta['id']
                if key not in result:
                    result[key] = (resolved, meta)
    return result


def process_tree(root_pid: int):
    """Closest processes first; nested agent tasks cannot override their parent."""
    children = {}
    for path in Path('/proc').glob('[0-9]*/stat'):
        try:
            fields = path.read_text().rsplit(')', 1)[1].split()
            children.setdefault(int(fields[1]), []).append(int(path.parent.name))
        except (OSError, ValueError, IndexError):
            pass
    queue = [(root_pid, 0)]
    for pid, depth in queue:
        if len(queue) < 1024:
            queue.extend((child, depth + 1) for child in children.get(pid, []))
    return queue


def process_identity(pid: int):
    try:
        return str(pid) + ':' + Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19]
    except (OSError, IndexError):
        return ''


def agent_generation(pid: int):
    hits = {}
    for child, depth in process_tree(pid):
        try:
            first = Path(f'/proc/{child}/cmdline').read_bytes().split(b'\0')[0]
            name = os.path.basename(first.decode(errors='replace')).lower()
            if 'codex' in name or 'claude' in name:
                identity = process_identity(child)
                if identity:
                    hits.setdefault(depth, []).append(identity)
        except OSError:
            pass
    return '|'.join(sorted(hits[min(hits)])) if hits else 'shell'


def exact_candidate(pid: int, candidates: dict):
    by_path = {str(path): key for key, (path, _) in candidates.items()}
    hits = {}
    for child, depth in process_tree(pid):
        process = Path(f'/proc/{child}')
        try:
            arguments = (process / 'cmdline').read_bytes().split(b'\0')
            executable = os.path.basename(arguments[0].decode(errors='replace')).lower()
            if 'codex' not in executable and 'claude' not in executable:
                continue
            for fd in (process / 'fd').iterdir():
                try:
                    key = by_path.get(str(fd.readlink()))
                    if key:
                        hits.setdefault(depth, set()).add(key)
                except OSError:
                    pass
            # Explicit resume/session identifiers are also exact evidence.
            args = [part.decode(errors='replace') for part in arguments]
            for index, value in enumerate(args[:-1]):
                if value in ('resume', '--resume', '--session-id') and UUID.fullmatch(args[index + 1]):
                    provider = 'codex' if 'codex' in executable else 'claude'
                    key = provider + ':' + args[index + 1]
                    if key in candidates:
                        hits.setdefault(depth, set()).add(key)
        except OSError:
            continue
    if hits:
        nearest = hits[min(hits)]
        if len(nearest) == 1:
            return next(iter(nearest))
    return None


def transcript(path: Path, provider: str, before: int | None = None, limit: int = 120):
    """Byte cursors keep earlier pages stable as a JSONL transcript grows."""
    messages = []
    with path.open('rb') as stream:
        size = os.fstat(stream.fileno()).st_size
        end = min(size, before) if before is not None else size
        start = max(0, end - CHUNK)
        stream.seek(start)
        if start:
            stream.readline(min(CHUNK, end-start))  # bounded partial first record
        scan_start = stream.tell()
        while stream.tell() < end:
            offset = stream.tell()
            line = stream.readline(min(CHUNK + 1, end - offset))
            if not line.endswith(b'\n') or len(line) > CHUNK:
                break  # unfinished append is retried on next poll
            try:
                item = json.loads(line)
            except (ValueError, UnicodeDecodeError):
                continue
            if not isinstance(item, dict):
                continue
            if provider == 'codex':
                body = item.get('payload', {})
                if not isinstance(body, dict) or item.get('type') != 'response_item' or body.get('type') != 'message':
                    continue
                if body.get('channel') in ('analysis', 'summary'):
                    continue
            else:
                if item.get('type') not in ('user', 'assistant') or item.get('isSidechain'):
                    continue
                body = item.get('message', {})
            if not isinstance(body, dict):
                continue
            role = body.get('role')
            if role not in ('user', 'assistant'):
                continue
            content = body.get('content', [])
            if isinstance(content, str):
                text = content
            elif isinstance(content, list):
                text = '\n'.join(part['text'] for part in content if isinstance(part, dict)
                                 and part.get('type') in ('text', 'input_text', 'output_text') and isinstance(part.get('text'), str))
            else:
                continue
            if text.strip():
                messages.append({'id': str(offset), 'role': role, 'text': text,
                                 'timestamp': str(item.get('timestamp', ''))[:40]})
    # IDs are byte offsets within the verified transcript, not inferred titles.
    page = messages[-limit:]
    previous = int(page[0]['id']) if len(messages) > limit else scan_start if scan_start < end else start
    return {'messages': page, 'before': previous if previous > 0 else None,
            'version': f'{size}:{path.stat().st_mtime_ns}', 'sourceBytes': size,
            'limited': scan_start >= end and start > 0}


class Bindings:
    def __init__(self):
        self.path = config.STATE_DIR / '.conversation-bindings.json'
        self.values = {}
        self.lock = threading.Lock()
        try:
            self.values = json.loads(self.path.read_text())
            if not isinstance(self.values, dict):
                self.values = {}
        except (OSError, ValueError):
            pass

    @staticmethod
    def owner(session_name: str, process: str, cwd: str):
        return hashlib.sha256(json.dumps([session_name, process, cwd]).encode()).hexdigest()

    def put(self, owner: str, key: str | None):
        with self.lock:
            updated = dict(self.values)
            if key:
                updated[owner] = key
            else:
                updated.pop(owner, None)
            # Restrict state and replace atomically; no transcript contents are stored.
            fd, name = tempfile.mkstemp(prefix='.conversation-bindings.', dir=self.path.parent)
            temp = Path(name)
            try:
                with os.fdopen(fd, 'w') as stream:
                    json.dump(updated, stream)
                temp.replace(self.path)
                self.values = updated
            finally:
                temp.unlink(missing_ok=True)


bindings = Bindings()
